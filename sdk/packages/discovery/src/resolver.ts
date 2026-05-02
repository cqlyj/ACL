import {
  type AclDeployment,
  type AgentProfile,
  type HttpTransportOptions,
  createEnsClient,
  createGalileoClients,
} from "@acl/core";
import { verifyEnsip25 } from "./ensip25.js";
import { fetchAgentProfile } from "./profile.js";
import { fetchReputation } from "./reputation.js";
import type {
  AgentResolverConfig,
  DiscoveryPublicClient,
  Ensip25Status,
  ResolveOptions,
  ResolvedAgent,
} from "./types.js";

/**
 * Façade over the discovery primitives.
 *
 * Holds the long-lived viem clients and deployment config so consumers can
 * call `resolver.resolve('researcher.acl.eth')` without re-stating the
 * Universal Resolver / chain id / RPC pair on every call.
 *
 * @example
 * ```ts
 * import { createPublicClient, http } from 'viem';
 * import { sepolia } from 'viem/chains';
 * import { ACL_TESTNET } from '@acl/core';
 * import { AgentResolver } from '@acl/discovery';
 *
 * const ensClient = createPublicClient({ chain: sepolia, transport: http() });
 * const resolver = new AgentResolver({ ensClient, deployment: ACL_TESTNET });
 * const { profile, ensip25 } = (await resolver.resolve('researcher.acl.eth'))!;
 * ```
 */
export class AgentResolver {
  constructor(private readonly cfg: AgentResolverConfig) {}

  /**
   * Resolve an `*.acl.eth` name to a verified profile. Returns `null` when
   * the name has no agent backing it (zero address). Throws when `ensip25`
   * is `'strict'` and the on-chain self-attestation is missing or wrong.
   *
   * Throws synchronously when `withReputation: true` is requested but no
   * `galileoClient` was passed at construction time — failing fast here is
   * more useful than letting the call no-op or fail mid-flight.
   */
  async resolve(
    name: string,
    opts: ResolveOptions = {},
  ): Promise<ResolvedAgent | null> {
    if (opts.withReputation && !this.cfg.galileoClient) {
      throw new Error(
        "AgentResolver.resolve: `withReputation: true` requires `galileoClient` in the resolver config (it powers the ACLReputationRegistry read on 0G Galileo).",
      );
    }

    const profile = await fetchAgentProfile(this.cfg, name);
    if (!profile) return null;

    const mode: ResolveOptions["ensip25"] = opts.ensip25 ?? "best-effort";
    let ensip25: Ensip25Status | null = null;
    if (mode !== false) {
      ensip25 = await verifyEnsip25(this.cfg, profile);
      if (mode === "strict" && !ensip25.ok) {
        throw new Error(
          `ENSIP-25 verification failed for ${profile.ensName}: ${ensip25.reason} (key=${ensip25.key})`,
        );
      }
    }

    let finalProfile: AgentProfile = profile;
    if (opts.withReputation) {
      const score = await fetchReputation(this.cfg, profile.agentId);
      if (score) finalProfile = { ...profile, score };
    }

    return { profile: finalProfile, ensip25 };
  }

  /** Re-export the lower-level helpers as instance methods for convenience. */
  fetchProfile = (name: string) => fetchAgentProfile(this.cfg, name);
  verifyEnsip25 = (profile: AgentProfile) => verifyEnsip25(this.cfg, profile);
  fetchReputation = (agentId: bigint) => fetchReputation(this.cfg, agentId);
}

/**
 * One-line factory that mirrors the most common resolver setup: ENS on the
 * Sepolia testnet, optional 0G Galileo RPC for reputation reads. Pass
 * `ensClient` / `galileoClient` to fully override; otherwise we spin up
 * vanilla `http()` transports against the provided RPC URLs (or the
 * deployment's default RPC URL for Galileo).
 *
 * @example
 * ```ts
 * import { ACL_TESTNET } from '@acl/core';
 * import { createAgentResolver } from '@acl/discovery';
 *
 * const resolver = createAgentResolver({
 *   deployment: ACL_TESTNET,
 *   sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL!,
 *   galileoRpcUrl: process.env.GALILEO_RPC_URL,
 * });
 * ```
 */
export type CreateAgentResolverInput = {
  deployment: AclDeployment;
  /** Override the ENS PublicClient. When omitted, we build one over Sepolia. */
  ensClient?: DiscoveryPublicClient;
  /** Override the Galileo PublicClient. When omitted, we build one if `galileoRpcUrl` is set. */
  galileoClient?: DiscoveryPublicClient;
  /** RPC URL for the ENS chain (Sepolia by default). */
  sepoliaRpcUrl?: string;
  /** RPC URL for the registry chain (0G Galileo). */
  galileoRpcUrl?: string;
  /** Override the gateway URL list passed to viem's CCIP-Read flow. */
  gatewayUrls?: string[];
  /** Tuning for the underlying viem `http` transport. */
  transportOptions?: HttpTransportOptions;
};

export function createAgentResolver(
  input: CreateAgentResolverInput,
): AgentResolver {
  const ensClient =
    input.ensClient ??
    (createEnsClient(
      input.sepoliaRpcUrl,
      input.transportOptions,
    ) as DiscoveryPublicClient);

  const galileoRpcUrl = input.galileoRpcUrl ?? input.deployment.galileo.rpcUrl;
  const galileoClient =
    input.galileoClient ??
    (galileoRpcUrl
      ? (createGalileoClients({
          deployment: input.deployment,
          rpcUrl: galileoRpcUrl,
          ...(input.transportOptions
            ? { transportOptions: input.transportOptions }
            : {}),
        }).publicClient as DiscoveryPublicClient)
      : undefined);

  return new AgentResolver({
    ensClient,
    ...(galileoClient ? { galileoClient } : {}),
    deployment: input.deployment,
    ...(input.gatewayUrls ? { gatewayUrls: input.gatewayUrls } : {}),
  });
}
