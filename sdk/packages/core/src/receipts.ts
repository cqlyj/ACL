/**
 * Receipt-wait helpers tuned for slow / flaky public RPC endpoints.
 *
 * The 0G Galileo public RPC (and most permissionless testnet endpoints)
 * has three failure modes that bite naive `waitForTransactionReceipt`
 * usage:
 *
 *   1. **Slow propagation.** `eth_sendRawTransaction` returns a hash
 *      almost immediately, but a follow-up `eth_getTransactionReceipt`
 *      against the same load-balanced endpoint may not see the tx for
 *      tens of seconds because the read may land on a different node.
 *   2. **Transient 5xx / rate-limit.** The transport-level retry
 *      eventually surfaces these as exceptions.
 *   3. **`eth_getTransaction` flakiness.** viem's
 *      `waitForTransactionReceipt` calls `eth_getTransaction` between
 *      receipt polls to detect dropped/replaced transactions; the public
 *      0G RPC can return null for a freshly-submitted tx even *after*
 *      the receipt is available, which makes viem throw
 *      `TransactionReceiptNotFoundError` despite the tx being mined.
 *
 * We sidestep all three by polling `eth_getTransactionReceipt` directly
 * in a loop and treating any "not found" / transient error as a signal
 * to wait + retry until either (a) the receipt comes back, or (b) the
 * overall deadline passes. This is intentionally narrower than viem's
 * `waitForTransactionReceipt` (we don't detect replaced or cancelled
 * transactions) but it's exactly what every ACL agent needs: fire a tx
 * we just signed locally, then block until it lands.
 */

import type { Hex, PublicClient, TransactionReceipt } from "viem";

/** Tunables for {@link waitForReceiptResilient}. All optional. */
export type WaitForReceiptOptions = {
  /** Overall poll deadline in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /**
   * Per-poll interval in ms. Defaults to 2s — fast enough that a tx
   * confirmed in the next block lands within ~6s on Galileo's ~5s
   * blocks, slow enough that we don't hammer the RPC.
   */
  pollingIntervalMs?: number;
};

export const DEFAULT_RECEIPT_TIMEOUT_MS = 300_000 as const;
export const DEFAULT_RECEIPT_POLLING_MS = 2_000 as const;

/**
 * Resilient drop-in for `publicClient.waitForTransactionReceipt({ hash })`.
 * Polls `eth_getTransactionReceipt` every {@link WaitForReceiptOptions.pollingIntervalMs}
 * ms, swallowing transient errors, and returns the receipt as soon as
 * the chain produces one. Throws if {@link WaitForReceiptOptions.timeoutMs}
 * elapses without observing the receipt.
 *
 * @example
 * ```ts
 * import { waitForReceiptResilient } from '@acl/core';
 *
 * const tx = await walletClient.writeContract({ ... });
 * const receipt = await waitForReceiptResilient(publicClient, tx);
 * ```
 */
export async function waitForReceiptResilient(
  client: PublicClient,
  hash: Hex,
  opts: WaitForReceiptOptions = {},
): Promise<TransactionReceipt> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const pollingIntervalMs = opts.pollingIntervalMs ?? DEFAULT_RECEIPT_POLLING_MS;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      // viem's `getTransactionReceipt` throws `TransactionReceiptNotFoundError`
      // when the receipt isn't available yet. Treat that as "keep polling".
      return await client.getTransactionReceipt({ hash });
    } catch (err) {
      lastErr = err;
    }
    await _sleep(pollingIntervalMs);
  }
  // Never observed a receipt before the deadline — surface the last
  // error if we have one (helps debug RPC-level issues), otherwise a
  // synthetic timeout error.
  if (lastErr) throw lastErr;
  throw new Error(`waitForReceiptResilient: timed out after ${timeoutMs}ms waiting for ${hash}`);
}

function _sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
