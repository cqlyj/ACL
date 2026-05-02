import type { AclDeployment, AgentProfile } from "@acl/core";
import type { Chain, PublicClient, Transport } from "viem";

/**
 * Minimal viem PublicClient shape used by the discovery layer. We accept any
 * client that exposes the standard read actions (`readContract`,
 * `getEnsAddress`, `getEnsText`, …) so consumers can pass in their own pre-
 * configured client without dragging the full chain object through the type.
 */
export type DiscoveryPublicClient = PublicClient<Transport, Chain | undefined>;

/**
 * Configuration for {@link AgentResolver}.
 *
 * The resolver is intentionally network-agnostic: callers wire in a viem
 * `PublicClient` for ENS reads (Sepolia by default) and an OPTIONAL second
 * client for the chain that hosts the IdentityRegistry/ReputationRegistry
 * (0G Galileo by default). When the Galileo client is omitted the resolver
 * still works for ENS-only flows; only `fetchReputation` becomes unavailable.
 */
export type AgentResolverConfig = {
  /** PublicClient bound to the ENS chain (Sepolia for the ACL testnet). */
  ensClient: DiscoveryPublicClient;
  /**
   * PublicClient bound to the chain hosting the registries. Optional; only
   * required for `fetchReputation`. Defaults to undefined.
   */
  galileoClient?: DiscoveryPublicClient;
  /** Live deployment used to look up well-known addresses. */
  deployment: AclDeployment;
  /**
   * Override the gateway URL list passed to viem's CCIP-Read flow when
   * resolving Universal-Resolver-batched calls. The inner resolver still
   * controls the URL list emitted in `OffchainLookup`; this only affects the
   * outer Universal Resolver multicall path. Default: undefined (use the
   * URLs the resolver itself emits).
   */
  gatewayUrls?: string[];
};

/**
 * Options accepted by {@link AgentResolver.resolve}.
 */
export type ResolveOptions = {
  /**
   * Verify the ENSIP-25 self-attestation as part of the resolve. When `true`,
   * resolve() throws on a mismatch. When `'best-effort'` it records the
   * status on the profile but does not throw. Default: `'best-effort'`.
   */
  ensip25?: false | "best-effort" | "strict";
  /**
   * Fetch the on-chain reputation summary. Requires `galileoClient` in the
   * resolver config; ignored otherwise. Default: false.
   */
  withReputation?: boolean;
};

/**
 * Result of an ENSIP-25 verification check.
 *
 * Per ENSIP-25, any non-empty text-record value is a valid attestation. The
 * `value` field carries the raw bytes the ENS name owner published so
 * downstream consumers can render or audit it; the spec recommends `"1"`
 * but does not require it.
 */
export type Ensip25Status =
  | { ok: true; key: string; value: string }
  | { ok: false; key: string; reason: "unset" };

/**
 * `resolve(name)` returns this combined view. The agent profile is the same
 * shape exported from `@acl/core`; we tack on the verification status so
 * downstream code can render trust badges without re-querying.
 */
export type ResolvedAgent = {
  profile: AgentProfile;
  ensip25: Ensip25Status | null;
};
