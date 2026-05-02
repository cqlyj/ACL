import { type AclDeployment, type ReputationScore, abis } from "@acl/core";
import type { Address } from "viem";
import type { AgentResolverConfig, DiscoveryPublicClient } from "./types.js";

/**
 * Minimum config slice required by {@link fetchReputation}. The full
 * {@link AgentResolverConfig} (which carries the ENS-side client) is
 * accepted as well so callers that already built a resolver can just
 * forward it.
 */
export type ReputationFetchConfig = {
  /** Live ACL deployment whose `galileo.reputationRegistry` is being read. */
  deployment: AclDeployment;
  /** Read-only PublicClient bound to the chain hosting the registry (0G Galileo). */
  galileoClient: DiscoveryPublicClient;
};

/**
 * Pull the on-chain reputation summary for an agent from the
 * `ACLReputationRegistry`.
 *
 * ERC-8004 v2 requires a non-empty `clientAddresses` filter when computing
 * `getSummary`, so we make a two-call dance:
 *   1. `getClients(agentId)` to discover everyone who left feedback
 *   2. `getSummary(agentId, clients, '', '')` to aggregate across all of them
 *
 * Returns `null` if no reputation client has rated the agent yet.
 */
export async function fetchReputation(
  cfg: ReputationFetchConfig | AgentResolverConfig,
  agentId: bigint,
): Promise<ReputationScore | null> {
  const galileo = cfg.galileoClient;
  if (!galileo) {
    throw new Error("fetchReputation: galileoClient is required to read the ReputationRegistry");
  }
  const registry = cfg.deployment.galileo.reputationRegistry;

  const clients = (await galileo.readContract({
    address: registry,
    abi: abis.aclReputationRegistryAbi,
    functionName: "getClients",
    args: [agentId],
  })) as readonly Address[];

  if (clients.length === 0) return null;

  const [count, summaryValue, summaryValueDecimals] = (await galileo.readContract({
    address: registry,
    abi: abis.aclReputationRegistryAbi,
    functionName: "getSummary",
    args: [agentId, clients, "", ""],
  })) as readonly [bigint, bigint, number];

  if (count === 0n) return null;
  return {
    count,
    summaryValue,
    summaryValueDecimals,
  };
}
