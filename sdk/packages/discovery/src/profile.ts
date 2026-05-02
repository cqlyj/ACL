import {
  ACL_METADATA_KEYS,
  type AgentProfile,
  abis,
  decodeMetadataAsText,
  normalizeAddress,
  parseAgentContext,
} from "@acl/core";
import { type Address, type Hex, getAddress, zeroAddress } from "viem";
import { normalize } from "viem/ens";
import type { AgentResolverConfig, DiscoveryPublicClient } from "./types.js";

/** Keys the discovery layer pulls per-agent. */
const TEXT_KEYS = [
  ACL_METADATA_KEYS.agentId,
  ACL_METADATA_KEYS.ensLabel,
  ACL_METADATA_KEYS.chainId,
  ACL_METADATA_KEYS.evaluatorAddress,
  ACL_METADATA_KEYS.axlPeerId,
  ACL_METADATA_KEYS.taskDomains,
  ACL_METADATA_KEYS.deliveryTypes,
  ACL_METADATA_KEYS.paymentTokens,
  ACL_METADATA_KEYS.minBudget,
  ACL_METADATA_KEYS.agentContext,
] as const;

type TextRecordKey = (typeof TEXT_KEYS)[number];

/**
 * Resolve a fully qualified `*.acl.eth` name into an {@link AgentProfile}.
 *
 * Two paths exist depending on what's wired in the resolver config:
 *   - **Fast path (galileoClient available):** issue a single ENS `addr()`
 *     resolution to obtain the agent address (and to confirm the CCIP-Read
 *     pipeline is healthy), discover the agentId via the same single
 *     CCIP-Read text lookup, then batch every other metadata read into one
 *     `multicall3` round-trip directly against the IdentityRegistry on 0G.
 *     Cuts the number of CCIP-Read trips from ~9 to 2.
 *   - **Fallback (ENS-only):** original path — every key is a CCIP-Read text
 *     lookup. Slower, but works when no Galileo RPC is configured.
 *
 * Returns `null` when the name resolves to the zero address.
 */
export async function fetchAgentProfile(
  cfg: AgentResolverConfig,
  name: string,
): Promise<AgentProfile | null> {
  const normalized = normalize(name);
  const { ensClient, deployment } = cfg;

  const universal: {
    universalResolverAddress: Address;
    gatewayUrls?: string[];
  } = {
    universalResolverAddress: deployment.ens.universalResolver,
    ...(cfg.gatewayUrls ? { gatewayUrls: [...cfg.gatewayUrls] } : {}),
  };

  const addr = await ensClient.getEnsAddress({
    name: normalized,
    ...universal,
  });
  if (!addr || addr === zeroAddress) return null;

  const text = await _fetchTextRecords(cfg, normalized, universal);

  const ensLabel =
    text[ACL_METADATA_KEYS.ensLabel] ?? deriveLabel(normalized, deployment.ens.parentName);
  const agentId = parseAgentId(text[ACL_METADATA_KEYS.agentId]);
  if (agentId === null) return null;
  const chainId = parseChainId(text[ACL_METADATA_KEYS.chainId], deployment.galileo.chainId);

  const agentContextRaw = text[ACL_METADATA_KEYS.agentContext];
  const agentContext = parseAgentContext(agentContextRaw);
  return {
    ensName: normalized,
    ensLabel,
    agentId,
    chainId,
    identityRegistry: deployment.galileo.identityRegistry,
    agentAddress: getAddress(addr),
    evaluatorAddress: parseAddress(text[ACL_METADATA_KEYS.evaluatorAddress]),
    axlPeerId: stripPrefix(text[ACL_METADATA_KEYS.axlPeerId] ?? ""),
    taskDomains: text[ACL_METADATA_KEYS.taskDomains] ?? "",
    deliveryTypes: text[ACL_METADATA_KEYS.deliveryTypes] ?? "",
    paymentTokens: parseAddressList(text[ACL_METADATA_KEYS.paymentTokens]),
    minBudget: parseUintOr0(text[ACL_METADATA_KEYS.minBudget]),
    agentContext,
    ...(agentContextRaw ? { agentContextRaw } : {}),
  } satisfies AgentProfile;
}

/**
 * Strategy router:
 *   - With `galileoClient`: pull `agent-id` via ENS, then read every other
 *     key in one multicall3 batch directly from the IdentityRegistry.
 *   - Without it: fall back to N parallel CCIP-Read text lookups.
 */
async function _fetchTextRecords(
  cfg: AgentResolverConfig,
  normalizedName: string,
  universal: {
    universalResolverAddress: Address;
    gatewayUrls?: string[];
  },
): Promise<Record<TextRecordKey, string | null>> {
  if (cfg.galileoClient) {
    return _fastPathRecords(cfg, normalizedName, universal, cfg.galileoClient);
  }
  return _fallbackPathRecords(cfg, normalizedName, universal);
}

async function _fastPathRecords(
  cfg: AgentResolverConfig,
  normalizedName: string,
  universal: {
    universalResolverAddress: Address;
    gatewayUrls?: string[];
  },
  galileo: DiscoveryPublicClient,
): Promise<Record<TextRecordKey, string | null>> {
  const idText = await cfg.ensClient.getEnsText({
    name: normalizedName,
    key: ACL_METADATA_KEYS.agentId,
    ...universal,
  });
  const agentId = parseAgentId(idText);
  if (agentId === null) {
    return _emptyTextRecord();
  }

  // Multicall: every metadata key on the IdentityRegistry in one batch.
  const onChainKeys: ReadonlyArray<TextRecordKey> = [
    ACL_METADATA_KEYS.ensLabel,
    ACL_METADATA_KEYS.chainId,
    ACL_METADATA_KEYS.evaluatorAddress,
    ACL_METADATA_KEYS.axlPeerId,
    ACL_METADATA_KEYS.taskDomains,
    ACL_METADATA_KEYS.deliveryTypes,
    ACL_METADATA_KEYS.paymentTokens,
    ACL_METADATA_KEYS.minBudget,
    ACL_METADATA_KEYS.agentContext,
  ];

  const results = await galileo.multicall({
    contracts: onChainKeys.map((key) => ({
      address: cfg.deployment.galileo.identityRegistry,
      abi: abis.aclIdentityRegistryAbi,
      functionName: "getMetadata",
      args: [agentId, key],
    })),
    allowFailure: true,
  });

  const text = _emptyTextRecord();
  text[ACL_METADATA_KEYS.agentId] = agentId.toString();

  onChainKeys.forEach((key, idx) => {
    const r = results[idx];
    if (!r || r.status !== "success") return;
    const raw = r.result as Hex;
    text[key] = decodeMetadataAsText(key, raw);
  });

  return text;
}

async function _fallbackPathRecords(
  cfg: AgentResolverConfig,
  normalizedName: string,
  universal: {
    universalResolverAddress: Address;
    gatewayUrls?: string[];
  },
): Promise<Record<TextRecordKey, string | null>> {
  const records = await Promise.all(
    TEXT_KEYS.map((key) => cfg.ensClient.getEnsText({ name: normalizedName, key, ...universal })),
  );

  return Object.fromEntries(TEXT_KEYS.map((key, idx) => [key, records[idx] ?? null])) as Record<
    TextRecordKey,
    string | null
  >;
}

function _emptyTextRecord(): Record<TextRecordKey, string | null> {
  return Object.fromEntries(TEXT_KEYS.map((k) => [k, null])) as Record<
    TextRecordKey,
    string | null
  >;
}

function deriveLabel(name: string, parent: string): string {
  if (!name.endsWith(`.${parent}`)) return "";
  return name.slice(0, name.length - parent.length - 1);
}

function parseAgentId(value: string | null): bigint | null {
  if (!value) return null;
  try {
    const id = BigInt(value);
    return id < 0n ? null : id;
  } catch {
    return null;
  }
}

function parseChainId(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseUintOr0(value: string | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function parseAddress(value: string | null): Address {
  if (!value) return zeroAddress;
  // `normalizeAddress` accepts both checksummed and fully-lowercase
  // hex addresses (viem's `decodeAbiParameters` emits the latter, so
  // the fast-path multicall + CSV joiner ends up handing us
  // lowercased blobs) and re-checksums the survivors so the rest of
  // the SDK sees a consistent shape.
  return normalizeAddress(value) ?? zeroAddress;
}

/**
 * Parse `acl.payment-tokens` as a list of checksum addresses.
 *
 * On-chain the value is stored as `abi.encode(address[])`; the gateway's
 * resolver-service flattens it to a comma-separated string before signing
 * the CCIP-Read response, and the multicall fast path decodes the ABI
 * blob and joins on `,` as well (see {@link decodeMetadataAsText}). Both
 * code paths therefore present a CSV here, and we keep this helper
 * deliberately minimal: anything that isn't a CSV of valid addresses is
 * dropped, which surfaces gateway / encoder regressions as missing
 * payment options instead of silently round-tripping malformed bytes.
 */
function parseAddressList(value: string | null): Address[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseAddress)
    .filter((a) => a !== zeroAddress);
}

function stripPrefix(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}
