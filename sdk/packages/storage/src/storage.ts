import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import {
  type AttestationBundle,
  type Deliverable,
  GALILEO_PUBLIC_RPC_URL,
  type TaskSpec,
  canonicalJson,
} from "@acl/core";
import { JsonRpcProvider, type Signer } from "ethers";
import type { Hex } from "viem";

import { createEthersSignerFromPrivateKey } from "./ethers-signer.js";
import type { AclStorageConfig, UploadResult } from "./types.js";

/**
 * Canonical 0G Storage indexer for the Galileo testnet "turbo" network.
 * Higher fees, faster uploads — recommended for hackathon-grade demos.
 *
 * Operators with a stricter cost target should swap in the standard
 * indexer (`https://indexer-storage-testnet-standard.0g.ai`) via the
 * `indexerUrl` config knob; the SDK auto-discovers the matching Flow
 * contract from whichever indexer it points at.
 *
 * @see https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
 */
export const ZG_STORAGE_TURBO_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai" as const;

/**
 * Cast a string returned by the upstream `@0gfoundation/0g-ts-sdk`
 * (typed as `string`) into Viem's `Hex` only if it actually matches
 * the `0x[0-9a-fA-F]+` shape. This guards against an upstream SDK
 * change accidentally letting a non-hex value flow through.
 */
const HEX_RE = /^0x[0-9a-fA-F]*$/;

function _asHex(value: string, label: string): Hex {
  if (typeof value !== "string" || !HEX_RE.test(value)) {
    throw new Error(
      `@acl/storage: upstream SDK returned a non-hex ${label}: ${JSON.stringify(value)}`,
    );
  }
  return value as Hex;
}

/**
 * High-level wrapper around the 0G Storage TS SDK, narrowed to the
 * artifacts ACL actually uploads: task specs, deliverables and
 * attestation bundles. Everything else (raw bytes, raw JSON) is exposed
 * for completeness so consumers don't reach around the abstraction.
 *
 * Usage:
 *
 * ```ts
 * const storage = createAclStorage({ privateKey: process.env.PROVIDER_PRIVATE_KEY });
 * const { rootHash } = await storage.uploadTaskSpec(spec);
 * await commerce.write.submit([jobId, rootHash, "0x"]);
 * ```
 *
 * Internally we always go through `MemData` + `downloadToBlob` so the
 * package works in both Node.js and browser bundlers without dragging
 * `fs` into the call path.
 */
export class AclStorage {
  private readonly indexer: Indexer;
  private readonly rpcUrl: string;
  private readonly signer: Signer | undefined;
  private readonly uploadMaxAttempts: number;
  private readonly uploadTimeoutMs: number;

  constructor(opts: {
    indexer: Indexer;
    rpcUrl: string;
    /**
     * Omit to build a download-only `AclStorage`. Calling any upload
     * method on a signer-less instance throws an explicit error.
     */
    signer?: Signer;
    /**
     * Override the {@link DEFAULT_UPLOAD_MAX_ATTEMPTS} retry ceiling
     * for `uploadBytes`. Forwarded by `createAclStorage` from
     * {@link AclStorageConfig.uploadMaxAttempts}.
     */
    uploadMaxAttempts?: number;
    /**
     * Override the {@link DEFAULT_UPLOAD_TIMEOUT_MS} watchdog budget
     * per attempt. Forwarded by `createAclStorage` from
     * {@link AclStorageConfig.uploadTimeoutMs}.
     */
    uploadTimeoutMs?: number;
  }) {
    this.indexer = opts.indexer;
    this.rpcUrl = opts.rpcUrl;
    this.signer = opts.signer;
    this.uploadMaxAttempts = opts.uploadMaxAttempts ?? DEFAULT_UPLOAD_MAX_ATTEMPTS;
    if (this.uploadMaxAttempts < 1 || !Number.isInteger(this.uploadMaxAttempts)) {
      throw new Error(
        `@acl/storage: uploadMaxAttempts must be a positive integer (got ${opts.uploadMaxAttempts})`,
      );
    }
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    if (this.uploadTimeoutMs < 1_000 || !Number.isFinite(this.uploadTimeoutMs)) {
      throw new Error(
        `@acl/storage: uploadTimeoutMs must be >= 1000 (got ${opts.uploadTimeoutMs})`,
      );
    }
  }

  /** True when this instance can upload (i.e. a Flow signer is present). */
  get canUpload(): boolean {
    return this.signer !== undefined;
  }

  private _requireSigner(method: string): Signer {
    if (!this.signer) {
      throw new Error(
        `@acl/storage: ${method} requires an upload-capable signer; rebuild with \`createAclStorage({ privateKey })\` or \`{ signer }\` instead of \`{ readOnly: true }\``,
      );
    }
    return this.signer;
  }

  /**
   * Upload an arbitrary byte payload. Returns the on-chain commitable
   * `rootHash` plus telemetry data. Inputs over a few MiB are accepted
   * but the call is still single-shot — for >4 GiB use the underlying
   * SDK's `splitableUpload` directly.
   *
   * Retries the underlying Flow `submit()` up to `this.uploadMaxAttempts`
   * times on revert (default {@link DEFAULT_UPLOAD_MAX_ATTEMPTS}; tune
   * via `AclStorageConfig.uploadMaxAttempts`). Galileo's public storage
   * Flow occasionally rejects a `submit` because two clients raced on
   * the same `nextTxSeq` (one wins, the other reverts) — re-running
   * with a fresh sequence number almost always succeeds. The upstream
   * SDK has no such retry, so we own it here.
   */
  async uploadBytes(bytes: Uint8Array | ArrayLike<number>): Promise<UploadResult> {
    this._requireSigner("uploadBytes");
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.uploadMaxAttempts; attempt++) {
      try {
        return await this._uploadBytesOnce(bytes);
      } catch (err) {
        lastErr = err;
        const msg = (err as Error).message ?? String(err);
        // Only retry the specific revert/finalisation classes that we
        // know are transient: a Flow `submit` that reverted with
        // status=0 (sequence race or fee shortfall), or that never
        // finalised within the receipt window (mempool drop). Any
        // other failure (merkleTree, fragmentation, decode) is fatal.
        const isRetryable =
          /reverted \(status=0\)/.test(msg) || /did not finalise within/.test(msg);
        if (!isRetryable || attempt === this.uploadMaxAttempts) {
          throw err;
        }
        await _delay(UPLOAD_RETRY_BACKOFF_MS * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async _uploadBytesOnce(bytes: Uint8Array | ArrayLike<number>): Promise<UploadResult> {
    const signer = this._requireSigner("uploadBytes");
    const data = new MemData(bytes);
    const [, treeErr] = await data.merkleTree();
    if (treeErr) {
      throw new Error(`@acl/storage uploadBytes: merkleTree failed: ${treeErr.message ?? treeErr}`);
    }
    // The upstream `@0gfoundation/0g-ts-sdk` Uploader submits the
    // Flow tx and then `waitForLogEntry()`s in an unbounded loop —
    // it does NOT check the receipt status. When the tx mines as
    // status=0 (intermittent on Galileo when the storage fee races
    // a fee bump, or when a duplicate root is rejected) the SDK
    // hangs forever instead of surfacing the error.
    //
    // Mitigation: capture the submitted txHash via `onProgress` and
    // race the upload against a short receipt watchdog. The
    // watchdog only fires once a hash is observed, so successful
    // uploads pay no cost. On revert we throw a clear error so the
    // caller can pick a fresh nonce/fee and try again — which
    // `uploadBytes` does automatically.
    let observedTxHash: Hex | undefined;
    const onProgress = (msg: string): void => {
      const m = /Transaction submitted: (0x[0-9a-fA-F]{64})/.exec(msg);
      if (m?.[1]) {
        observedTxHash = m[1] as Hex;
      }
    };
    const provider = (signer.provider ?? new JsonRpcProvider(this.rpcUrl)) as JsonRpcProvider;
    const uploadPromise = this.indexer.upload(data, this.rpcUrl, signer, {
      onProgress,
    });
    const [tx, uploadErr] = await Promise.race([
      uploadPromise,
      _watchUploadReceipt(provider, () => observedTxHash, this.uploadTimeoutMs).then(
        (err): never => {
          throw err;
        },
      ),
    ]);
    if (uploadErr) {
      throw new Error(`@acl/storage uploadBytes: upload failed: ${uploadErr.message ?? uploadErr}`);
    }
    if ("rootHashes" in tx) {
      throw new Error(
        `@acl/storage uploadBytes: payload was fragmented (${tx.rootHashes.length} parts); use the underlying SDK's splitableUpload for >4GiB blobs`,
      );
    }
    return {
      rootHash: _asHex(tx.rootHash, "rootHash"),
      ...(tx.txHash && tx.txHash.length > 0 ? { txHash: _asHex(tx.txHash, "txHash") } : {}),
      txSeq: tx.txSeq,
    };
  }

  /**
   * Upload a UTF-8 string. Convenience for log-like artifacts (e.g.
   * raw evaluator transcripts) that want plaintext on-chain commits.
   */
  async uploadString(text: string): Promise<UploadResult> {
    return this.uploadBytes(new TextEncoder().encode(text));
  }

  /**
   * Upload an arbitrary JSON value using ACL's canonical encoding
   * (sorted keys, throws on non-representable leaves). The same encoder
   * that hashes a `TaskSpec` for EIP-712 produces the bytes uploaded
   * here, so the on-chain root hashes are byte-stable across runs.
   */
  async uploadJson(value: unknown): Promise<UploadResult> {
    return this.uploadString(canonicalJson(value));
  }

  /**
   * Upload a {@link TaskSpec} for AXL→on-chain hand-off. The
   * resulting `rootHash` is what the SDK records as
   * `Deliverable.taskSpecRoot` and `AttestationBundle.taskSpecRoot`.
   *
   * Note that this hash is independent from `JobProposal.taskSpecHash`
   * (which is the keccak256 of the canonical JSON, computed locally for
   * EIP-712). They commit to the same bytes via the same canonicaliser
   * but have different hash semantics.
   */
  async uploadTaskSpec(spec: TaskSpec): Promise<UploadResult> {
    return this.uploadJson(spec);
  }

  /**
   * Upload a {@link Deliverable}. The returned `rootHash` is the
   * `bytes32 deliverable` argument to ERC-8183 `submit(jobId,
   * deliverable, optParams)`.
   */
  async uploadDeliverable(deliverable: Deliverable): Promise<UploadResult> {
    return this.uploadJson(deliverable);
  }

  /**
   * Upload an {@link AttestationBundle}. The returned `rootHash` is the
   * `bytes32 reason` argument to ERC-8183 `complete` / `reject`.
   */
  async uploadAttestationBundle(bundle: AttestationBundle): Promise<UploadResult> {
    return this.uploadJson(bundle);
  }

  /**
   * Download a single root hash and return raw bytes. Always uses
   * `downloadToBlob` so this works in both Node.js and browsers.
   * Verifies the Merkle proof per the SDK default.
   */
  async downloadBytes(rootHash: string): Promise<Uint8Array> {
    const [blob, err] = await this.indexer.downloadToBlob(rootHash, {
      proof: true,
    });
    if (err) {
      throw new Error(`@acl/storage downloadBytes: ${err.message ?? err}`);
    }
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** UTF-8 decode of {@link downloadBytes}. */
  async downloadString(rootHash: string): Promise<string> {
    return new TextDecoder().decode(await this.downloadBytes(rootHash));
  }

  /**
   * Download and JSON.parse. The generic narrows to the expected shape
   * but does not validate — consumers SHOULD revalidate the payload
   * before trusting it (the storage layer is permissionless).
   */
  async downloadJson<T = unknown>(rootHash: string): Promise<T> {
    return JSON.parse(await this.downloadString(rootHash)) as T;
  }

  /** Convenience helper: fetch + cast back into a {@link TaskSpec}. */
  async downloadTaskSpec(rootHash: string): Promise<TaskSpec> {
    return this.downloadJson<TaskSpec>(rootHash);
  }

  /** Convenience helper: fetch + cast back into a {@link Deliverable}. */
  async downloadDeliverable(rootHash: string): Promise<Deliverable> {
    return this.downloadJson<Deliverable>(rootHash);
  }

  /** Convenience helper: fetch + cast back into an {@link AttestationBundle}. */
  async downloadAttestationBundle(rootHash: string): Promise<AttestationBundle> {
    return this.downloadJson<AttestationBundle>(rootHash);
  }
}

/**
 * Watchdog that bounds a single 0G Storage `Indexer.upload(...)`
 * attempt. The upstream `@0gfoundation/0g-ts-sdk` polls
 * `waitForLogEntry()` indefinitely and does NOT check the receipt
 * status, so a status=0 revert (intermittent on Galileo when the
 * storage fee races a fee bump, or when the indexer rejects a
 * duplicate root) hangs the upload forever. The watchdog watches the
 * caller-provided `getTxHash()` getter (populated by `onProgress`)
 * and:
 *   - polls the receipt as soon as a hash is observed; a status=0
 *     receipt resolves with a structured Error so the caller's retry
 *     loop can fire,
 *   - hard-caps the entire attempt at `totalBudgetMs` so a hash that
 *     never arrives (or a tx that never finalises) resolves with an
 *     Error rather than blocking forever.
 *
 * The watchdog only ever surfaces errors. On the happy path the upload
 * promise resolves first and `Promise.race` discards the watchdog.
 */
const RECEIPT_POLL_INTERVAL_MS = 3_000;
const TX_HASH_OBSERVE_POLL_INTERVAL_MS = 500;

/**
 * Default total watchdog budget for a single upload attempt. Aligned
 * with the public Galileo RPC's worst-case finalisation delay
 * documented in `sdk/README.md` ("Resilience defaults"). Override per
 * instance via {@link AclStorageConfig.uploadTimeoutMs}.
 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000 as const;

/**
 * Default `uploadMaxAttempts` for {@link AclStorage.uploadBytes}.
 * 3 strikes the balance between absorbing transient Galileo failures
 * (sequence race, mempool drops) and giving up before the caller's
 * own deadline fires. Override per-instance via
 * {@link AclStorageConfig.uploadMaxAttempts}.
 */
export const DEFAULT_UPLOAD_MAX_ATTEMPTS = 3 as const;
const UPLOAD_RETRY_BACKOFF_MS = 4_000;

async function _watchUploadReceipt(
  provider: JsonRpcProvider,
  getTxHash: () => Hex | undefined,
  totalBudgetMs: number,
): Promise<Error> {
  const deadline = Date.now() + totalBudgetMs;
  let pollIntervalMs = TX_HASH_OBSERVE_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    await _delay(pollIntervalMs);
    const txHash = getTxHash();
    if (!txHash) continue;
    pollIntervalMs = RECEIPT_POLL_INTERVAL_MS;
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt && receipt.status === 0) {
        return new Error(
          `@acl/storage uploadBytes: 0G Storage Flow tx ${txHash} reverted (status=0); the upstream SDK polls indefinitely on revert. Retry the upload with a fresh nonce/fee.`,
        );
      }
    } catch {
      // Transient RPC failure - keep watching.
    }
  }
  const tail = getTxHash();
  if (tail) {
    return new Error(
      `@acl/storage uploadBytes: 0G Storage Flow tx ${tail} did not finalise within ${totalBudgetMs / 1_000}s; check the indexer health or retry with a fresh nonce/fee.`,
    );
  }
  return new Error(
    `@acl/storage uploadBytes: 0G Storage indexer did not surface a Flow tx hash within ${totalBudgetMs / 1_000}s; check the indexer health ('indexerUrl' config) and the wallet's tOG balance.`,
  );
}

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build an {@link AclStorage} with sensible 0G Galileo testnet
 * defaults. The smallest valid usage is two lines:
 *
 * ```ts
 * const storage = createAclStorage({ privateKey: '0x...' });
 * const { rootHash } = await storage.uploadJson({ hello: 'world' });
 * ```
 *
 * Three config shapes are accepted:
 *
 *  - `{ privateKey }` — the factory builds an `ethers.JsonRpcProvider`
 *    + `Wallet` for you. Pays the Flow `submit()` gas.
 *  - `{ signer }` — pass a pre-built ethers signer (e.g. one wired via
 *    RainbowKit / wagmi). Identical upload semantics to `privateKey`.
 *  - `{ readOnly: true }` — download-only mode. No wallet is built and
 *    `upload*` calls throw a clear error. Use this from observers /
 *    web UIs that just need to materialise an on-chain `rootHash`
 *    back into bytes.
 */
export function createAclStorage(config: AclStorageConfig): AclStorage {
  const rpcUrl = config.rpcUrl ?? GALILEO_PUBLIC_RPC_URL;
  const indexerUrl = config.indexerUrl ?? ZG_STORAGE_TURBO_INDEXER;
  const indexer = new Indexer(indexerUrl);

  const tuningOpts = {
    ...(config.uploadMaxAttempts !== undefined
      ? { uploadMaxAttempts: config.uploadMaxAttempts }
      : {}),
    ...(config.uploadTimeoutMs !== undefined
      ? { uploadTimeoutMs: config.uploadTimeoutMs }
      : {}),
  };

  if ("readOnly" in config && config.readOnly === true) {
    return new AclStorage({ indexer, rpcUrl, ...tuningOpts });
  }

  let signer: Signer;
  if ("signer" in config && config.signer) {
    signer = config.signer;
  } else if ("privateKey" in config && config.privateKey) {
    signer = createEthersSignerFromPrivateKey(config.privateKey, rpcUrl);
  } else {
    throw new Error(
      "createAclStorage: pass `signer`, `privateKey`, or `readOnly: true` in the config",
    );
  }

  return new AclStorage({ indexer, rpcUrl, signer, ...tuningOpts });
}
