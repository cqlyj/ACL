import { type Hex, toFunctionSelector } from "viem";

/**
 * Custom-error names emitted by the on-chain `INFTDeliveryHook`
 * (see `src/hooks/INFTDeliveryHook.sol`). Mirrored verbatim — keep
 * in lockstep with the contract or `decodeRevert` helpers will
 * silently miss new error kinds.
 *
 * The literal strings are the ones an app should match when
 * surfacing user-facing reasons; the EIP-838 4-byte selectors live in
 * {@link INFT_SALE_HOOK_REASON_SELECTORS} for revert-data sniffing.
 */
export const INFT_SALE_HOOK_REASONS = {
  /** Fired when something other than `AgenticCommerce` invokes the hook. */
  OnlyCommerce: "OnlyCommerce",
  /** No escrow record yet for the job — usually means `setBudget` never ran. */
  NoEscrowData: "NoEscrowData",
  /** `complete`/`reject` reached the hook before the iNFT was deposited. */
  NotDeposited: "NotDeposited",
  /** `setBudget` ran twice for the same job — provider attempted double-deposit. */
  AlreadyDeposited: "AlreadyDeposited",
  /** Recovery path called on a job whose lifecycle no longer permits it. */
  JobNotRecoverable: "JobNotRecoverable",
  /**
   * `setBudget` was called but `tx.origin`'s wallet doesn't currently
   * own the iNFT (e.g. the buyer already acquired it on a prior run,
   * or the provider transferred it elsewhere).
   */
  NotProvider: "NotProvider",
  /** `complete` reached the hook with `optParams.complete == 0x` (no proofs). */
  MissingTransferProofs: "MissingTransferProofs",
} as const;

export type InftSaleHookReasonName =
  (typeof INFT_SALE_HOOK_REASONS)[keyof typeof INFT_SALE_HOOK_REASONS];

/**
 * 4-byte selectors for {@link INFT_SALE_HOOK_REASONS}, useful when an
 * app wants to match a raw revert-data prefix without standing up a
 * viem `decodeErrorResult` call:
 *
 * ```ts
 * const data = (err.data ?? "0x") as Hex;
 * if (data.startsWith(INFT_SALE_HOOK_REASON_SELECTORS.NotProvider)) {
 *   // surface a friendlier "this iNFT is no longer for sale" message
 * }
 * ```
 *
 * All errors are zero-arg, so the selector alone is unambiguous.
 */
export const INFT_SALE_HOOK_REASON_SELECTORS: Record<InftSaleHookReasonName, Hex> = {
  OnlyCommerce: toFunctionSelector("error OnlyCommerce()"),
  NoEscrowData: toFunctionSelector("error NoEscrowData()"),
  NotDeposited: toFunctionSelector("error NotDeposited()"),
  AlreadyDeposited: toFunctionSelector("error AlreadyDeposited()"),
  JobNotRecoverable: toFunctionSelector("error JobNotRecoverable()"),
  NotProvider: toFunctionSelector("error NotProvider()"),
  MissingTransferProofs: toFunctionSelector("error MissingTransferProofs()"),
};
