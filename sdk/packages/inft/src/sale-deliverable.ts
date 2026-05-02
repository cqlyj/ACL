/**
 * Factory for the `ProduceDeliverableStrategy` that an `inft-sale`
 * provider should plug into `ProviderAgentConfig.produceDeliverable`.
 *
 * Encapsulates the full Flow-2 vertical:
 *   - returns `null` for non-iNFT TaskSpecs so the SDK falls through
 *     to its default LLM-text path (Flow-1 jobs keep working),
 *   - emits an `inftDeliverableCommitment(...)` as the on-chain
 *     `submit(deliverable)` payload (the canonical pointer the
 *     `INFTDeliveryHook` decodes during `complete`),
 *   - skips 0G Storage upload (the deliverable is the pointer, not a
 *     content blob),
 *   - in `beforeSubmit`, idempotently approves the
 *     `INFTDeliveryHook` to pull the iNFT into escrow inside
 *     `_onBeforeSubmit`, waiting through public-RPC flakes via
 *     `waitForReceiptResilient`.
 *
 * Lifted from `examples/kelp-postmortem/src/agents/provider-process.ts`
 * verbatim — the example used to declare it inline but the body is
 * 100% protocol-shaped, so it lives here so other apps don't have to
 * re-derive it.
 */
import {
  type AclDeployment,
  INFT_DELIVERY_TYPE,
  INFT_POINTER_CONTENT_TYPE,
  type TaskSpec,
  waitForReceiptResilient,
} from "@acl/core";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import { INftClient } from "./client.js";
import { inftDeliverableCommitment } from "./hook.js";

/** Inputs accepted by the strategy returned from {@link inftSaleDeliverableStrategy}. */
export type InftSaleDeliverableInput = {
  jobId: bigint;
  taskSpec: TaskSpec;
  provider: Address;
  taskSpecRoot: Hex;
};

/** Outputs the strategy returns; structurally compatible with `@acl/agent`'s `ProduceDeliverableResult`. */
export type InftSaleDeliverableResult = {
  deliverable: Hex;
  contentType: string;
  beforeSubmit?: () => Promise<void>;
  skipStorageUpload: true;
};

/** Configuration for {@link inftSaleDeliverableStrategy}. */
export type InftSaleDeliverableStrategyConfig = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployment: AclDeployment;
  /** ERC-7857 token id this provider sells. */
  tokenId: bigint;
  /** Provider's ERC-8004 agent id (encoded into the pointer commitment). */
  providerAgentId: bigint;
  /**
   * Optional iNFT contract override. Defaults to
   * `deployment.galileo.aclAgentNFT`.
   */
  contractAddress?: Address;
  /**
   * Optional iNFT delivery hook override. Defaults to
   * `deployment.galileo.inftDeliveryHook`.
   */
  hookAddress?: Address;
  /**
   * Optional callback fired once the on-chain `approve(hook, tokenId)`
   * tx is mined. The example app uses this to log the approval; pass
   * a structured logger in production. Skipped on the idempotent
   * "already approved" branch.
   */
  onApprovalMined?: (args: { txHash: Hex }) => void;
};

export function inftSaleDeliverableStrategy(
  cfg: InftSaleDeliverableStrategyConfig,
): (input: InftSaleDeliverableInput) => Promise<InftSaleDeliverableResult | null> {
  const nftContract = cfg.contractAddress ?? cfg.deployment.galileo.aclAgentNFT;
  const hookAddress = cfg.hookAddress ?? cfg.deployment.galileo.inftDeliveryHook;

  return async (input) => {
    if (input.taskSpec.deliveryType !== INFT_DELIVERY_TYPE) return null;
    return {
      deliverable: inftDeliverableCommitment({
        nftContract,
        tokenId: cfg.tokenId,
        providerAgentId: cfg.providerAgentId,
      }),
      contentType: INFT_POINTER_CONTENT_TYPE,
      skipStorageUpload: true as const,
      beforeSubmit: async () => {
        const nftClient = new INftClient({
          publicClient: cfg.publicClient,
          walletClient: cfg.walletClient,
          deployment: cfg.deployment,
          ...(cfg.contractAddress ? { contractAddress: cfg.contractAddress } : {}),
        });
        // Idempotent: skip the approval (and gas) when the hook is
        // already approved for this tokenId.
        const approved = await nftClient.getApproved(cfg.tokenId);
        if (approved.toLowerCase() === hookAddress.toLowerCase()) return;
        const txHash = await nftClient.approve({
          to: hookAddress,
          tokenId: cfg.tokenId,
        });
        // The hook calls `transferFrom(provider, escrow, tokenId)`
        // inside `_onBeforeSubmit`, so the approval must be visible
        // at submit-time. Public-RPC flakes are common on Galileo;
        // `waitForReceiptResilient` polls through the
        // "transaction not yet mined" window viem's built-in waiter
        // throws on.
        await waitForReceiptResilient(cfg.publicClient, txHash);
        cfg.onApprovalMined?.({ txHash });
      },
    };
  };
}
