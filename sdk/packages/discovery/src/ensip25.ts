import { type AgentProfile, buildAgentRegistrationKey } from "@acl/core";
import { normalize } from "viem/ens";
import type { AgentResolverConfig, Ensip25Status } from "./types.js";

/**
 * ENSIP-25 verifier. Constructs the canonical
 * `agent-registration[<7930-registry>][<agentId>]` text-record key for the
 * given profile, fetches that key through the resolver (CCIP-Read), and
 * checks that a non-empty attestation value is present.
 *
 * Per ENSIP-25 section "Parameterized Verification Text Record Key":
 *
 *   > The value of this text record MUST be a non-empty string.
 *   > Implementations SHOULD set the value to "1". The specific value has
 *   > no semantic meaning; the presence of a non-empty value is interpreted
 *   > as an attestation by the ENS name owner that the ENS name is
 *   > associated with the referenced AI agent registry entry. Verification
 *   > clients MUST NOT depend on the specific value beyond it being
 *   > non-empty.
 *
 * Returns a structured status so callers can render trust badges (or fail
 * loud in `strict` mode) without re-querying.
 */
export async function verifyEnsip25(
  cfg: AgentResolverConfig,
  profile: AgentProfile,
): Promise<Ensip25Status> {
  const key = buildAgentRegistrationKey({
    chainId: profile.chainId,
    registry: profile.identityRegistry,
    agentId: profile.agentId,
  });

  const value = await cfg.ensClient.getEnsText({
    name: normalize(profile.ensName),
    key,
    universalResolverAddress: cfg.deployment.ens.universalResolver,
    gatewayUrls: cfg.gatewayUrls,
  });

  if (value === null || value === "") {
    return { ok: false, key, reason: "unset" };
  }
  return { ok: true, key, value };
}
