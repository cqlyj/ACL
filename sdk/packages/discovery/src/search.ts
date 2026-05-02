import {
  ACL_METADATA_KEYS,
  hasCapability,
  parseAgentContext,
  safeHexToText,
} from "@acl/core";
import type { Hex } from "viem";

/**
 * Lightweight discovery search hitting the ACL gateway's
 * `GET /agents[?taskDomain=...]` endpoint. The gateway already
 * maintains an in-memory mirror of every `MetadataSet` event — the
 * search reuses that index instead of replaying logs ourselves.
 *
 * Returned shape is intentionally a subset of {@link AgentProfile}:
 * the gateway only stores raw on-chain bytes, so consumers that need
 * the full profile (including ENS round-trip and reputation) should
 * follow up with `AgentResolver.resolve(name)` for each candidate.
 */

export type SearchAgentInput = {
  /** Gateway base URL, e.g. `https://gateway.acl.example`. No trailing slash. */
  gatewayUrl: string;
  /**
   * Substring filter on the `acl.task-domains` metadata. Comma-separated
   * lists are split and matched case-insensitively, so passing
   * `"security"` matches an agent advertising
   * `"Security,Research,DeFi"` and an agent advertising
   * `"security-research"`.
   *
   * Omit to receive every indexed agent.
   */
  taskDomain?: string;
  /**
   * ENSIP-26 capability filter. **Exact-token, case-insensitive** match
   * against the parsed `agent-context.capabilities[]` array (the
   * gateway lower-cases at index time, the SDK lower-cases the
   * needle).
   *
   * Diverges from {@link taskDomain} on purpose: capability tokens
   * are intentionally hyphenated short strings (`inft-sale`,
   * `acl-evaluator`) where substring match would yield false
   * positives (`inft-sale` would shadow `inft-sale-blacklist`).
   * `taskDomains` stays a comma-CSV substring filter because that key
   * is flattened CSV on chain.
   */
  capability?: string;
  /** Per-call timeout in ms. Default 10s. */
  timeoutMs?: number;
};

/** A trimmed candidate produced by the gateway index — enough to rank. */
export type AgentCandidate = {
  /** Numeric agent id from `ACLIdentityRegistry`. */
  agentId: bigint;
  /** ENS sub-label as it appears on-chain (e.g. `"researcher"`). */
  ensLabel: string;
  /** Comma-separated task domains advertised by the agent. */
  taskDomains: string;
  /** Decoded `acl.min-budget` (smallest-unit of the agent's primary payment token). */
  minBudget: bigint;
  /** Raw metadata map keyed by `acl.<key>` strings. Useful for forwards-compat. */
  metadata: Record<string, Hex>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Hit `GET <gatewayUrl>/agents` (optionally with `?taskDomain=`) and
 * return the matching candidates. Filtering happens client-side after
 * the fetch — keeps the gateway endpoint stateless and the SDK side
 * easy to reason about.
 */
export async function searchAgents(
  input: SearchAgentInput,
): Promise<AgentCandidate[]> {
  const url = `${input.gatewayUrl.replace(/\/$/, "")}/agents`;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`@acl/discovery: gateway /agents returned ${res.status}`);
    }
    const body = (await res.json()) as {
      agents: Array<{ agentId: string; metadata: Record<string, Hex> }>;
    };
    const candidates: AgentCandidate[] = [];
    for (const entry of body.agents) {
      const taskDomainsHex = entry.metadata[ACL_METADATA_KEYS.taskDomains];
      const ensLabelHex = entry.metadata[ACL_METADATA_KEYS.ensLabel];
      if (!taskDomainsHex || !ensLabelHex) continue;
      const taskDomains = safeHexToText(taskDomainsHex);
      const ensLabel = safeHexToText(ensLabelHex);
      if (!ensLabel) continue;
      if (input.taskDomain && !_matchesDomain(taskDomains, input.taskDomain))
        continue;
      if (input.capability) {
        const ctxRaw = safeHexToText(
          entry.metadata[ACL_METADATA_KEYS.agentContext],
        );
        const ctx = parseAgentContext(ctxRaw);
        if (!hasCapability(ctx, input.capability)) continue;
      }
      const minBudget = _decodeMinBudget(
        entry.metadata[ACL_METADATA_KEYS.minBudget],
      );
      candidates.push({
        agentId: BigInt(entry.agentId),
        ensLabel,
        taskDomains,
        minBudget,
        metadata: entry.metadata,
      });
    }
    return candidates;
  } finally {
    clearTimeout(timer);
  }
}

function _matchesDomain(taskDomains: string, query: string): boolean {
  const q = query.toLowerCase();
  return taskDomains
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .some((d) => d.includes(q));
}

function _decodeMinBudget(hex: Hex | undefined): bigint {
  if (!hex || hex === "0x") return 0n;
  // Stored as `abi.encode(uint256)` → 32-byte big-endian. `BigInt(hex)`
  // parses the hex correctly without pulling in viem's full decode.
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}
