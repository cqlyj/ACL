import { waitForReceiptResilient } from "@acl/core";
/**
 * Higher-level helper for refreshing an iNFT's intelligent-data slot in
 * one call. The flow is:
 *
 *   1. AES-256-GCM encrypt `plaintext` under a fresh data key.
 *   2. ECIES-seal the data key to `recipientPubKey` (the iNFT owner's
 *      uncompressed SEC1 secp256k1 pubkey).
 *   3. Upload the ciphertext to 0G Storage via {@link AclStorage.uploadBytes}.
 *   4. Optional `onEncrypted` callback — fire BEFORE the on-chain
 *      `update(...)` so any out-of-band key custody surface (oracle,
 *      KMS, demo coordinator, …) sees the freshly minted `dataKey` at
 *      the same moment the chain advertises the new `dataHash`.
 *   5. Submit `update(tokenId, IntelligentData[], encryptedStorageURI)`
 *      and (optionally) wait for the receipt before returning.
 *
 * Designed for the "owner refreshes their own iNFT corpus" lane (the
 * example app's "Op A" pipeline) and for any production flow that
 * mutates a single iNFT slot. Multi-slot iNFTs are supported via
 * `additionalSlots` — the new ciphertext occupies slot 0; existing
 * slots that should stay unchanged are appended verbatim.
 *
 * The helper is intentionally side-effect-light around the on-chain
 * write: callers retain full control over RECIPIENT key custody (the
 * `recipientPubKey` arg) and can plug their own KMS / oracle into
 * `onEncrypted`. The SDK never persists `dataKey` itself.
 */
import type { AclStorage } from "@acl/storage";
import type { Hex } from "viem";
import type { INftClient, IntelligentData } from "./client.js";
import { type EncryptedIntelligentData, encryptIntelligentData } from "./crypto.js";

/**
 * Default URI scheme prefix used for `encryptedStorageURI`. The
 * canonical 0G Storage form `0g://<rootHash>` matches the example app
 * and the 0G Intelligent NFT reference. Override via
 * {@link INftEncryptAndUpdateInput.uriPrefix} when integrating with a
 * different convention (e.g. `ipfs://`, `arweave://`).
 */
export const DEFAULT_INTELLIGENT_DATA_URI_PREFIX = "0g://" as const;

/** Inputs to {@link iNftEncryptAndUpdate}. */
export type INftEncryptAndUpdateInput = {
  /** The iNFT token id whose slot 0 is being refreshed. */
  tokenId: bigint;
  /**
   * Plaintext bytes to encrypt and pin to slot 0. The helper does NOT
   * canonicalise these bytes — encode JSON / canonical-JSON / opaque
   * binary upstream as your app requires.
   */
  plaintext: Uint8Array;
  /**
   * SEC1-uncompressed (65-byte `0x04 || X || Y`) secp256k1 public key
   * of the AES key recipient. For owner-refresh flows this is the
   * owner's own pubkey (so they can decrypt later); for buyer flows
   * this is the buyer's pubkey before transfer.
   */
  recipientPubKey: Uint8Array;
  /**
   * Description string written to slot 0's
   * `IntelligentData.dataDescription`. Free-form; surfaced to off-chain
   * indexers and explorers verbatim.
   */
  dataDescription: string;
  /**
   * Additional pre-existing `IntelligentData` slots to append AFTER
   * the new slot 0. Use this when the iNFT keeps multiple slots and
   * only slot 0 is being refreshed. Default: `[]` (single-slot iNFT).
   *
   * The on-chain `update(...)` replaces ALL slots, so the helper
   * preserves `additionalSlots` verbatim. Read them back from
   * `INftClient.getIntelligentData(tokenId)` before calling and pass
   * the surviving entries here.
   */
  additionalSlots?: ReadonlyArray<IntelligentData>;
  /**
   * Override the on-chain `encryptedStorageURI` prefix. Default
   * {@link DEFAULT_INTELLIGENT_DATA_URI_PREFIX}.
   */
  uriPrefix?: string;
  /**
   * Wait for the on-chain `update(...)` receipt before returning.
   * Default `true` — without this, a buyer who polls the chain and
   * sees the new `dataHash` IMMEDIATELY can race ahead of the
   * `update` confirmation and `iTransfer` would revert with
   * `OldDataHashMismatch`.
   */
  waitForReceipt?: boolean;
  /**
   * Side-channel callback invoked AFTER the encrypt+upload steps but
   * BEFORE the on-chain `update(...)` is submitted. Use this to push
   * the freshly minted symmetric `dataKey` into your key-custody
   * surface (production: 0G TeeML enclave / KMS; demo: an in-process
   * key registry).
   *
   * The callback awaits to completion before the chain write is
   * issued, so any failure aborts the refresh cleanly. Optional.
   */
  onEncrypted?: (event: IntelligentDataEncryptedEvent) => Promise<void> | void;
};

/** Payload surfaced to {@link INftEncryptAndUpdateInput.onEncrypted}. */
export type IntelligentDataEncryptedEvent = {
  tokenId: bigint;
  /** Raw 256-bit AES-GCM key. NEVER persist on chain or in events. */
  dataKey: Uint8Array;
  /** ECIES-sealed AES key — the value that lands in `OwnershipProof.sealedKey`. */
  sealedKey: Uint8Array;
  /** 0G Storage Merkle root of the freshly uploaded ciphertext. */
  rootHash: Hex;
  /** keccak256 of the ciphertext — the value that lands in `IntelligentData.dataHash`. */
  dataHash: Hex;
  /** Concatenated `iv || ciphertext || authTag` payload uploaded to 0G Storage. */
  ciphertext: Uint8Array;
  /** Final `encryptedStorageURI` that will be written on chain. */
  uri: string;
};

/** Result of {@link iNftEncryptAndUpdate}. */
export type INftEncryptAndUpdateResult = IntelligentDataEncryptedEvent & {
  /** `update(...)` transaction hash. */
  txHash: Hex;
};

/**
 * Encrypt `plaintext`, upload it to 0G Storage, and refresh the iNFT's
 * slot 0 in one call. Returns the full intelligent-data envelope plus
 * the on-chain tx hash.
 *
 * @example
 * ```ts
 * const result = await iNftEncryptAndUpdate({
 *   storage, nft, tokenId,
 *   plaintext: stringToBytes(JSON.stringify(bundle)),
 *   recipientPubKey: hexToBytes(publicKeyFromPrivateKey(ownerKey)),
 *   dataDescription: "researcher.acl.eth agent bundle",
 *   onEncrypted: ({ dataKey, dataHash }) =>
 *     keyRegistry.publish(tokenId, { dataKey, dataHash }),
 * });
 * ```
 */
export async function iNftEncryptAndUpdate(args: {
  storage: AclStorage;
  nft: INftClient;
  publicClient?: import("viem").PublicClient;
  input: INftEncryptAndUpdateInput;
}): Promise<INftEncryptAndUpdateResult> {
  const { storage, nft, input } = args;
  const encrypted: EncryptedIntelligentData = await encryptIntelligentData(
    input.plaintext,
    input.recipientPubKey,
  );
  const upload = await storage.uploadBytes(encrypted.ciphertext);
  const uri = `${input.uriPrefix ?? DEFAULT_INTELLIGENT_DATA_URI_PREFIX}${upload.rootHash}`;
  const event: IntelligentDataEncryptedEvent = {
    tokenId: input.tokenId,
    dataKey: encrypted.dataKey,
    sealedKey: encrypted.sealedKey,
    rootHash: upload.rootHash,
    dataHash: encrypted.dataHash,
    ciphertext: encrypted.ciphertext,
    uri,
  };
  if (input.onEncrypted) {
    await input.onEncrypted(event);
  }
  const newDatas: IntelligentData[] = [
    { dataDescription: input.dataDescription, dataHash: encrypted.dataHash },
    ...(input.additionalSlots ?? []),
  ];
  const txHash = await nft.update({
    tokenId: input.tokenId,
    newDatas,
    newEncryptedStorageURI: uri,
  });
  if (input.waitForReceipt !== false) {
    if (!args.publicClient) {
      throw new Error(
        "@acl/inft: iNftEncryptAndUpdate requires `publicClient` when `waitForReceipt` is not false",
      );
    }
    await waitForReceiptResilient(args.publicClient, txHash);
  }
  return { ...event, txHash };
}
