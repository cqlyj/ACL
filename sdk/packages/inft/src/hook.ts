/**
 * `inftDeliveryHook(...)` HookConfig factory + the matching
 * `inftDeliverableCommitment(...)` helper. These are the canonical
 * Flow-2 (iNFT acquisition) entry points.
 *
 * The corresponding on-chain hook is `INFTDeliveryHook` (see
 * `src/hooks/INFTDeliveryHook.sol`):
 *   beforeAction(setBudget) — `optParams = abi.encode(nftContract, tokenId, providerAgentId)`
 *   beforeAction(fund)      — `optParams = abi.encode(TransferValidityProof[])`
 *   onAfterSubmit / onAfterComplete — read state from prior calls; opt
 *     params are `0x`.
 *
 * The hook *is* the on-chain escrow + transfer driver — `submit()` only
 * commits a 32-byte deliverable hash to the chain (no storage upload),
 * which is why the SDK exports a stable `inftDeliverableCommitment(...)`
 * helper for that arg.
 */
import {
  ACL_TESTNET,
  type AclDeployment,
  type HookConfig,
  INFT_DELIVERY_TYPE,
  INFT_POINTER_CONTENT_TYPE,
} from "@acl/core";
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
} from "viem";

import type { TransferValidityProof } from "./proofs.js";

// Re-export so consumers that already import everything from `@acl/inft`
// don't have to add a second `@acl/core` import for these protocol-level
// identifiers. The canonical definitions live in `@acl/core/types.ts`.
export { INFT_DELIVERY_TYPE, INFT_POINTER_CONTENT_TYPE };

/** ABI tuple shape for `TransferValidityProof[]`, used in `fund` optParams. */
export const TRANSFER_VALIDITY_PROOF_ARRAY_ABI = [
  {
    type: "tuple[]",
    components: [
      {
        name: "accessProof",
        type: "tuple",
        components: [
          { name: "oldDataHash", type: "bytes32" },
          { name: "newDataHash", type: "bytes32" },
          { name: "nonce", type: "bytes" },
          { name: "encryptedPubKey", type: "bytes" },
          { name: "proof", type: "bytes" },
        ],
      },
      {
        name: "ownershipProof",
        type: "tuple",
        components: [
          { name: "oracleType", type: "uint8" },
          { name: "oldDataHash", type: "bytes32" },
          { name: "newDataHash", type: "bytes32" },
          { name: "sealedKey", type: "bytes" },
          { name: "encryptedPubKey", type: "bytes" },
          { name: "nonce", type: "bytes" },
          { name: "proof", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export type InftDeliveryHookInput = {
  /** Optional deployment override; defaults to `ACL_TESTNET`. */
  deployment?: AclDeployment;
  /** ERC-7857 contract that holds the iNFT being acquired. */
  nftContract: Address;
  /** iNFT id being escrowed. */
  tokenId: bigint;
  /** Provider's ERC-8004 agent id (the seller). */
  providerAgentId: bigint;
  /**
   * Pre-built per-IntelligentData proofs the receiver needs for
   * `iTransfer`. Encoded into `optParams.fund` per the on-chain hook.
   */
  proofs: ReadonlyArray<TransferValidityProof>;
};

/**
 * Build the `HookConfig` the buyer's `ClientAgent.runJob` consumes when
 * `selfComplete: true`.
 */
export function inftDeliveryHook(input: InftDeliveryHookInput): HookConfig {
  const deployment = input.deployment ?? ACL_TESTNET;
  const setBudget = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [input.nftContract, input.tokenId, input.providerAgentId],
  );
  const fund = encodeAbiParameters(TRANSFER_VALIDITY_PROOF_ARRAY_ABI, [
    input.proofs.map((p) => ({
      accessProof: { ...p.accessProof },
      ownershipProof: { ...p.ownershipProof },
    })),
  ]);
  return {
    address: deployment.galileo.inftDeliveryHook,
    optParams: {
      setBudget,
      fund,
    },
  };
}

/**
 * `bytes32` deliverable commitment the provider passes to
 * `AgenticCommerce.submit(jobId, deliverable)` for a Flow-2 iNFT job.
 *
 * Mirrors the on-chain hook escrow info: `keccak256(abi.encode(
 * nftContract, tokenId, providerAgentId))`. NOT a 0G Storage root —
 * iNFT delivery doesn't upload anything for `submit()`; the actual
 * transfer happens inside the hook on `onAfterComplete`.
 */
export function inftDeliverableCommitment(args: {
  nftContract: Address;
  tokenId: bigint;
  providerAgentId: bigint;
}): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [args.nftContract, args.tokenId, args.providerAgentId],
  );
  return keccak256(encoded);
}

/**
 * `bytes32` attestation root the buyer commits when self-completing a
 * Flow-2 iNFT job (`AgenticCommerce.complete(jobId, attestationRoot)`).
 *
 * Returns `null` when the supplied `HookConfig` is NOT an
 * `inftDeliveryHook(...)` (different hook address, or `setBudget`
 * optParams missing) — leaving the caller to decide whether to throw
 * or fall back to an explicit value. Returning a value never produces
 * a meaningless attestation: the hook's `setBudget` optParams are
 * defined to be exactly `abi.encode(nftContract, tokenId,
 * providerAgentId)`, so the keccak round-trip is the canonical bridge
 * between the off-chain hook config and the on-chain reason.
 */
export function attestationRootForInftHook(args: {
  hookConfig: HookConfig | undefined;
  deployment?: AclDeployment;
}): Hex | null {
  const cfg = args.hookConfig;
  if (cfg === undefined) return null;
  const deployment = args.deployment ?? ACL_TESTNET;
  const inftHookAddr = deployment.galileo.inftDeliveryHook.toLowerCase();
  if (cfg.address.toLowerCase() !== inftHookAddr) return null;
  const setBudget = cfg.optParams?.setBudget;
  if (setBudget === undefined) return null;
  decodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
    setBudget,
  );
  return keccak256(setBudget);
}
