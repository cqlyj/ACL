import type { Address, Hex } from "viem";

/**
 * EIP-712 typed-data domain for ACL JobProposal signatures. This is what the
 * negotiation package signs/verifies after AXL-bridged term agreement, and
 * what the on-chain `AgenticCommerce.fund` flow expects to find inside
 * the attestation bundle.
 *
 * The domain is keyed by the AgenticCommerce contract on the chain where
 * the job will be funded (0G Galileo by default). Because each
 * `AgenticCommerce` deployment pins an immutable `paymentToken`, the domain
 * implicitly pins the token; including `paymentToken` in the struct is a
 * redundancy check that helps signing UIs render readable data and that
 * lets verifiers double-check the deployment they're talking to.
 *
 * Dual-signed proposals produced by client + provider become the canonical
 * off-chain commitment that drives `createJob` / `setProvider` /
 * `setBudget` / `fund`.
 */
export const ACL_JOB_PROPOSAL_DOMAIN_NAME = "ACL JobProposal";
export const ACL_JOB_PROPOSAL_DOMAIN_VERSION = "1";

export type AclEip712Domain = {
  name: typeof ACL_JOB_PROPOSAL_DOMAIN_NAME;
  version: typeof ACL_JOB_PROPOSAL_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Address;
};

export function buildJobProposalDomain(params: {
  chainId: number;
  agenticCommerce: Address;
}): AclEip712Domain {
  return {
    name: ACL_JOB_PROPOSAL_DOMAIN_NAME,
    version: ACL_JOB_PROPOSAL_DOMAIN_VERSION,
    chainId: params.chainId,
    verifyingContract: params.agenticCommerce,
  };
}

/**
 * Type definitions for the JobProposal struct. Mirror the off-chain layout
 * negotiation peers sign. Field order matters — do not reorder without
 * coordinating the bump across every party that verifies signatures.
 *
 * - `hook` pins the IACPHook (e.g. ReputationHook vs INFTDeliveryHook).
 *   Without this in the signed payload, the on-chain `createJob` could
 *   bind a different hook than the one negotiated, silently changing the
 *   settlement semantics (reputation vs iNFT escrow vs custom).
 * - `taskSpecHash` is `keccak256` of the canonicalised TaskSpec. The
 *   TaskSpec already commits to the deliverable's MIME-shaped
 *   `deliveryType`, advertised in ENS via `acl.delivery-types`, so the
 *   proposal does NOT carry a separate `deliveryType` field — the
 *   commitment lives one level down inside the hash.
 */
export const JOB_PROPOSAL_TYPES = {
  JobProposal: [
    { name: "client", type: "address" },
    { name: "provider", type: "address" },
    { name: "evaluator", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "hook", type: "address" },
    { name: "taskSpecHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type JobProposal = {
  client: Address;
  provider: Address;
  evaluator: Address;
  paymentToken: Address;
  amount: bigint;
  /** ACP hook the on-chain job will bind (e.g. ReputationHook, INFTDeliveryHook). */
  hook: Address;
  /** keccak256 hash of the canonicalised task spec the client and provider agreed on. */
  taskSpecHash: Hex;
  /** Mirrors `job.expiredAt` (auto-refund deadline). */
  expiresAt: bigint;
  /** Random 32-byte value to prevent replay. */
  nonce: Hex;
};
