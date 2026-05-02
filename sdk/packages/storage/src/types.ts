import type { Hex } from "viem";

/**
 * Result of every successful upload through {@link AclStorage}.
 *
 * `rootHash` is what callers commit on-chain (e.g. ERC-8183
 * `submit(jobId, deliverable)` for the deliverable, `complete(jobId,
 * reason)` for the attestation bundle, or the AXL `taskSpecRoot` field
 * for the task spec). `txHash` and `txSeq` are surfaced for telemetry —
 * neither participates in the on-chain commitment.
 *
 * `txHash` is omitted when the upstream `@0gfoundation/0g-ts-sdk`
 * reports the file as already finalised on the storage network — in
 * that case 0G short-circuits the upload (no new Flow transaction is
 * submitted) so there is nothing to surface. `rootHash` is still the
 * canonical Merkle root and is safe to commit on-chain. Idempotent
 * re-uploads of the same canonical bytes (e.g. both client and
 * provider pinning the same `TaskSpec`) hit this path on the second
 * call.
 */
export type UploadResult = {
  /** 0G Storage Merkle root in 0x… form. */
  rootHash: Hex;
  /**
   * Submission transaction on the Flow contract. Absent when the
   * upload was a no-op (file already finalised in 0G Storage).
   */
  txHash?: Hex;
  /** Per-stream sequence number. Useful for log correlation. */
  txSeq: number;
};

/**
 * Configuration block for {@link createAclStorage}. Pass exactly one of
 * `signer`, `privateKey`, or `readOnly: true`:
 *
 *  - `signer` / `privateKey` → upload-capable storage. The signer pays
 *    for 0G Storage Flow txs and can also `downloadBytes`.
 *  - `readOnly: true` → download-only storage. No wallet is built,
 *    no Flow signer is required. Calling any `upload*` method
 *    throws. Use this from observers / web UIs that just need to
 *    materialise an on-chain `rootHash` back into bytes.
 *
 * Everything else (indexer URL, RPC URL) has sensible 0G Galileo
 * testnet defaults.
 */
export type AclStorageConfig = {
  /**
   * 0G Storage indexer URL. Default: turbo-testnet (recommended).
   *
   * Override only when targeting the standard network or a private
   * indexer. The indexer auto-discovers the correct Flow contract.
   */
  indexerUrl?: string;
  /**
   * RPC URL used by the indexer's flow-contract calls. Default: 0G
   * Galileo public RPC. For low-latency demos point this at a paid
   * endpoint — uploads are a single tx so range-cap RPC plans work
   * fine here.
   */
  rpcUrl?: string;
  /**
   * Max attempts for the underlying Flow `submit()` retry loop in
   * `uploadBytes`. Default: {@link DEFAULT_UPLOAD_MAX_ATTEMPTS}.
   *
   * Galileo's public storage Flow occasionally rejects a `submit`
   * because two clients raced on the same `nextTxSeq` (one wins, the
   * other reverts). The SDK transparently re-runs with a fresh
   * sequence number; bump this when the public turbo indexer is
   * lagging (5+ minute waits are common during testnet busy hours).
   * Lower it when running against a private 0G Storage with
   * deterministic ordering.
   */
  uploadMaxAttempts?: number;
  /**
   * Total time budget for a single `uploadBytes` attempt before the
   * watchdog gives up and surfaces an error. Default:
   * {@link DEFAULT_UPLOAD_TIMEOUT_MS} (5 minutes).
   *
   * Bound the upload here rather than at the call site: the upstream
   * `@0gfoundation/0g-ts-sdk` polls `waitForLogEntry()` indefinitely
   * and does not check the receipt status, so without this watchdog a
   * status=0 revert hangs forever. A status=0 receipt always
   * surfaces immediately as an error regardless of this budget.
   */
  uploadTimeoutMs?: number;
} & (
  | {
      /**
       * Pre-built ethers signer. Use this when you already have a
       * wallet from your app (e.g. RainbowKit / wagmi). The signer
       * MUST be connected to a provider that talks to `rpcUrl`.
       */
      signer: import("ethers").Signer;
      privateKey?: never;
      readOnly?: false;
    }
  | {
      /**
       * Hex private key of the account that pays for storage uploads.
       * The factory builds a fresh `ethers.JsonRpcProvider` + `Wallet`
       * from this; consumers who want their own provider should pass
       * `signer` instead.
       */
      privateKey: `0x${string}`;
      signer?: never;
      readOnly?: false;
    }
  | {
      /**
       * Build a download-only {@link AclStorage}. No Flow signer is
       * needed and `upload*` calls will throw. Mirrors the indexer +
       * `downloadToBlob` path so the result is byte-identical to
       * what an upload-capable client would see.
       */
      readOnly: true;
      signer?: never;
      privateKey?: never;
    }
);
