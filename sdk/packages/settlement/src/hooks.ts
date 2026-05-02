import { ACL_TESTNET, type AclDeployment, type HookConfig } from "@acl/core";
import { encodeAbiParameters } from "viem";

/**
 * Inputs for {@link reputationHook}. Mirrors the on-chain shape:
 * `ReputationHook` reads `abi.encode(uint256 providerAgentId)` from
 * `setProvider` / `setBudget` / `fund` / `submit` optParams and stores
 * the mapping the first time it arrives. Setting it on `setProvider` is
 * the canonical pattern; the other selectors just keep the hook
 * tolerant to callers that prefer a different wire schedule.
 */
export type ReputationHookInput = {
  /** Optional pinned deployment. Defaults to {@link ACL_TESTNET}. */
  deployment?: AclDeployment;
  /**
   * ERC-8004 numeric agent id of the provider — what feedback will be
   * written against once the hook fires `afterAction(complete | reject)`.
   */
  providerAgentId: bigint;
};

/**
 * Build a {@link HookConfig} that wires the deployed `ReputationHook`
 * contract into the orchestrator and stamps the provider's agent id on
 * the `setProvider` call's `optParams`.
 *
 * @example
 * ```ts
 * const hook = reputationHook({ providerAgentId: 7n });
 * await runJob({ ..., hook });
 * ```
 */
export function reputationHook(input: ReputationHookInput): HookConfig {
  const deployment = input.deployment ?? ACL_TESTNET;
  return {
    address: deployment.galileo.reputationHook,
    optParams: {
      setProvider: encodeAbiParameters([{ type: "uint256" }], [input.providerAgentId]),
    },
  };
}
