/**
 * Build / parse ENSIP-26 `agent-context` text records.
 *
 * The record is stored on chain as opaque UTF-8 bytes; the SDK + the
 * gateway interpret it as JSON. ENSIP-26 leaves the value free-form
 * (plaintext, Markdown, YAML, JSON), so the parser is strictly
 * lenient: any non-JSON or schema-mismatched record yields the empty
 * shape `{ capabilities: [], registries: [], protocols: [], extra: {} }`
 * rather than throwing.
 */
import type { AgentContext } from "./types.js";

/**
 * Default empty parse result — used both as a fallback and as a public
 * template. Frozen so consumers that mutate it don't leak the change
 * back into the SDK's parse path.
 */
export const EMPTY_AGENT_CONTEXT: AgentContext = Object.freeze({
  capabilities: Object.freeze([]) as readonly string[],
  registries: Object.freeze([]) as readonly string[],
  protocols: Object.freeze([]) as readonly string[],
  extra: Object.freeze({}) as Record<string, unknown>,
}) as AgentContext;

/**
 * Build an `agent-context` JSON string ready for `setMetadata`. Empty
 * arrays are dropped on the wire so the on-chain blob stays small;
 * `extra` is spread alongside the structured fields.
 *
 * Returns `null` when there is nothing to publish — call sites can
 * skip the `setMetadata` write entirely so non-ACL agents don't
 * accidentally publish an empty record (the gateway already returns
 * `capabilities: []` for missing records, no need for a write).
 */
export function buildAgentContext(input: {
  capabilities?: ReadonlyArray<string>;
  registries?: ReadonlyArray<string>;
  protocols?: ReadonlyArray<string>;
  extra?: Record<string, unknown>;
}): string | null {
  const caps = _normaliseTokens(input.capabilities);
  const regs = _normaliseTokens(input.registries);
  const procs = _normaliseTokens(input.protocols);
  const extra =
    input.extra && Object.keys(input.extra).length > 0 ? input.extra : null;
  if (caps.length === 0 && regs.length === 0 && procs.length === 0 && !extra) {
    return null;
  }
  const out: Record<string, unknown> = {};
  // Spread `extra` FIRST so the canonical reserved keys (`capabilities` /
  // `registries` / `protocols`) always win on collision. Otherwise a
  // caller passing `extra: { capabilities: ["fake"] }` could overwrite
  // the structured field we just normalised — silently breaking
  // discovery filtering for that record.
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === "capabilities" || k === "registries" || k === "protocols") {
        continue;
      }
      out[k] = v;
    }
  }
  if (caps.length > 0) out.capabilities = caps;
  if (regs.length > 0) out.registries = regs;
  if (procs.length > 0) out.protocols = procs;
  return JSON.stringify(out);
}

/**
 * Parse an `agent-context` UTF-8 string into the structured
 * {@link AgentContext} shape. Lenient: non-JSON or schema-mismatched
 * input → empty shape.
 *
 * Capabilities / registries / protocols are lowercased + de-duped so
 * downstream exact-token matching is case-insensitive without per-call
 * re-normalisation.
 */
export function parseAgentContext(
  raw: string | null | undefined,
): AgentContext {
  if (!raw) return EMPTY_AGENT_CONTEXT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_AGENT_CONTEXT;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_AGENT_CONTEXT;
  }
  const obj = parsed as Record<string, unknown>;
  const capabilities = _normaliseTokens(_asStringArray(obj.capabilities));
  const registries = _normaliseTokens(_asStringArray(obj.registries));
  const protocols = _normaliseTokens(_asStringArray(obj.protocols));
  const known = new Set(["capabilities", "registries", "protocols"]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (known.has(k)) continue;
    extra[k] = v;
  }
  return { capabilities, registries, protocols, extra };
}

function _asStringArray(v: unknown): ReadonlyArray<string> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function _normaliseTokens(tokens: ReadonlyArray<string> | undefined): string[] {
  if (!tokens || tokens.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (typeof tok !== "string") continue;
    const trimmed = tok.trim().toLowerCase();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Exact-token, case-insensitive capability check used by both the
 * gateway filter and the SDK search predicate. Lifted into core so
 * both sides stay byte-identical.
 */
export function hasCapability(
  context: AgentContext | null | undefined,
  capability: string,
): boolean {
  if (!context) return false;
  const needle = capability.trim().toLowerCase();
  if (!needle) return false;
  return context.capabilities.includes(needle);
}
