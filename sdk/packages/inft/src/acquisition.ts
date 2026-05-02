/**
 * Buyer-side ERC-7857 acquisition pipeline.
 *
 * Mechanical helper that mirrors the seller-side
 * {@link iNftEncryptAndUpdate} but for the receive direction. It owns
 * the deterministic, app-agnostic steps a buyer takes between deciding
 * to acquire an iNFT and submitting the `iTransfer`-driving
 * {@link inftDeliveryHook} settlement:
 *
 *  1. Read the seller's on-chain `IntelligentData` (`getIntelligentData`)
 *     and `encryptedStorageURI` (`getEncryptedStorageURI`).
 *  2. Download the seller's ciphertext from 0G Storage.
 *  3. Hand the seller bundle to the {@link ReencryptionOracle} to
 *     decrypt and re-encrypt under a fresh AES-GCM key sealed to the
 *     buyer's pubkey, producing a signed `OwnershipProof`.
 *  4. Sign the matching `AccessProof` on the buyer side and return the
 *     completed {@link TransferValidityProof}.
 *  5. Upload the recipient-bound ciphertext to 0G Storage and surface
 *     the new `0g://<root>` pointer.
 *  6. Optionally decrypt the bundle locally for the caller (UI / test
 *     hooks) using the buyer's private key.
 *
 * What the caller still drives (intentionally):
 *
 *   - the LLM ACQUIRE / SKIP decision (this is policy, not pipeline);
 *   - the runJob that wraps `iTransfer` via {@link inftDeliveryHook}
 *     (the budget / evaluator / hook-config policy is app-shaped);
 *   - the post-acquisition `update(...)` repointing the on-chain URI
 *     (handled by {@link repointInftAfterAcquisition} below).
 */

import type { AclStorage } from "@acl/storage";
import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  hexToBytes,
} from "viem";
import type { INftClient, IntelligentData } from "./client.js";
import { decryptIntelligentData, publicKeyFromPrivateKey } from "./crypto.js";
import { DEFAULT_INTELLIGENT_DATA_URI_PREFIX } from "./encrypt-update.js";
import {
  type ReencryptionOracle,
  type ReencryptionResult,
  buildTransferValidityProofForRecipient,
} from "./oracle.js";
import type { TransferValidityProof } from "./proofs.js";
import { waitForReceiptResilient } from "@acl/core";

/** Inputs to {@link prepareInftAcquisition}. */
export type PrepareInftAcquisitionInput = {
  /** ERC-7857 client wired to the same chain that holds `tokenId`. */
  nft: INftClient;
  /** 0G Storage client used to download seller ciphertext + upload buyer ciphertext. */
  storage: AclStorage;
  /** Re-encryption oracle the buyer trusts (TEE in prod, in-process in demos). */
  oracle: ReencryptionOracle;
  /** Token id the buyer wants to acquire. */
  tokenId: bigint;
  /**
   * Buyer's local account — signs the {@link AccessProof}. Must be the
   * recipient (or a registered delegate) since the verifier recovers
   * this signature.
   */
  buyer: LocalAccount;
  /**
   * Buyer's hex-encoded private key. Used to derive the SEC1 pubkey
   * (passed to the oracle as `recipientPubKey`) and, when
   * `decryptPlaintext` is `true`, to ECIES-unseal the new AES key for
   * a local decrypt.
   *
   * The SDK accepts the private key (rather than the pubkey alone)
   * because the typical caller has both at hand and the alternative —
   * deriving the pubkey externally then passing both — duplicates
   * configuration.
   */
  buyerPrivateKey: Hex;
  /**
   * When `true` (the default) the helper also decrypts the new
   * ciphertext locally and surfaces the plaintext bytes on the result.
   * Set to `false` for callers that don't need the plaintext (e.g.
   * batch transfer pipelines).
   */
  decryptPlaintext?: boolean;
  /**
   * Override the on-chain `encryptedStorageURI` prefix. Defaults to
   * {@link DEFAULT_INTELLIGENT_DATA_URI_PREFIX} (`0g://`).
   */
  uriPrefix?: string;
  /**
   * Slot index to acquire when the iNFT exposes multiple
   * `IntelligentData` slots. Defaults to `0`. The helper signs ONE
   * `TransferValidityProof` for the picked slot; multi-slot
   * acquisitions chain multiple `prepareInftAcquisition` calls.
   */
  slotIndex?: number;
};

/** Result of {@link prepareInftAcquisition}. */
export type PrepareInftAcquisitionResult = {
  /** Picked slot's on-chain hash (the seller's `oldDataHash`). */
  oldDataHash: Hex;
  /** Seller-side `0g://<root>` URI read from chain. */
  sellerEncryptedStorageURI: string;
  /** Raw seller ciphertext downloaded from 0G Storage. */
  sellerCiphertext: Uint8Array;
  /** Re-encryption oracle output (new ciphertext + sealedKey + ownership proof). */
  reencryption: ReencryptionResult;
  /** Buyer-side `TransferValidityProof` ready to feed into {@link inftDeliveryHook}. */
  proof: TransferValidityProof;
  /** 0G Storage Merkle root of the buyer's freshly uploaded ciphertext. */
  cipherRoot: Hex;
  /** Final `encryptedStorageURI` to write back via `update(...)` post-transfer. */
  newEncryptedStorageURI: string;
  /**
   * Decrypted plaintext bytes — present when `decryptPlaintext !== false`.
   * Useful for surfacing the recovered bundle on UI / test output.
   */
  plaintext?: Uint8Array;
};

/**
 * Run the buyer-side acquisition pipeline (steps 1–6 above) and return
 * the artefacts needed to drive an iNFT-acquisition runJob plus the
 * follow-up `update(...)`.
 *
 * @example
 * ```ts
 * const prep = await prepareInftAcquisition({
 *   nft, storage, oracle, tokenId,
 *   buyer: buyerAccount, buyerPrivateKey,
 * });
 * const hook = inftDeliveryHook({
 *   deployment, nftContract: nft.contract, tokenId,
 *   providerAgentId, proofs: [prep.proof],
 * });
 * const job = await client.runJob({ ..., hook });
 * await repointInftAfterAcquisition({
 *   nft, publicClient, tokenId,
 *   newDataHash: prep.reencryption.newDataHash,
 *   newEncryptedStorageURI: prep.newEncryptedStorageURI,
 *   dataDescription: "buyer-side bundle",
 * });
 * ```
 */
export async function prepareInftAcquisition(
  input: PrepareInftAcquisitionInput,
): Promise<PrepareInftAcquisitionResult> {
  const slotIndex = input.slotIndex ?? 0;
  const onChain = await input.nft.getIntelligentData(input.tokenId);
  if (onChain.length === 0) {
    throw new Error(
      `@acl/inft: prepareInftAcquisition: tokenId=${input.tokenId} has no IntelligentData slots`,
    );
  }
  if (slotIndex >= onChain.length) {
    throw new Error(
      `@acl/inft: prepareInftAcquisition: slotIndex=${slotIndex} out of bounds (token has ${onChain.length} slots)`,
    );
  }
  const slot = onChain[slotIndex]!;
  const sellerUri = await input.nft.getEncryptedStorageURI(input.tokenId);
  const prefix = input.uriPrefix ?? DEFAULT_INTELLIGENT_DATA_URI_PREFIX;
  if (!sellerUri.startsWith(prefix)) {
    throw new Error(
      `@acl/inft: prepareInftAcquisition: seller encryptedStorageURI "${sellerUri}" does not use the expected prefix "${prefix}"`,
    );
  }
  const sellerRoot = sellerUri.slice(prefix.length) as Hex;
  const sellerCiphertext = await input.storage.downloadBytes(sellerRoot);

  const recipientPubKey = hexToBytes(
    publicKeyFromPrivateKey(input.buyerPrivateKey),
  );
  const built = await buildTransferValidityProofForRecipient({
    oracle: input.oracle,
    request: {
      tokenId: input.tokenId,
      sellerCiphertext,
      oldDataHash: slot.dataHash,
      recipientPubKey,
    },
    recipient: input.buyer,
    encryptedPubKey: publicKeyFromPrivateKey(input.buyerPrivateKey),
  });

  const upload = await input.storage.uploadBytes(
    built.reencryption.newCiphertext,
  );
  const newEncryptedStorageURI = `${prefix}${upload.rootHash}`;

  const result: PrepareInftAcquisitionResult = {
    oldDataHash: slot.dataHash,
    sellerEncryptedStorageURI: sellerUri,
    sellerCiphertext,
    reencryption: built.reencryption,
    proof: built.proof,
    cipherRoot: upload.rootHash,
    newEncryptedStorageURI,
  };
  if (input.decryptPlaintext !== false) {
    result.plaintext = await decryptIntelligentData(
      built.reencryption.newCiphertext,
      hexToBytes(built.reencryption.sealedKey),
      input.buyerPrivateKey,
    );
  }
  return result;
}

/** Inputs to {@link repointInftAfterAcquisition}. */
export type RepointInftAfterAcquisitionInput = {
  nft: INftClient;
  /**
   * Required when `waitForReceipt !== false` (the default). The helper
   * blocks on the `update(...)` receipt so the caller can read the
   * fresh `encryptedStorageURI` immediately afterwards without racing
   * the chain.
   */
  publicClient?: PublicClient;
  tokenId: bigint;
  /** New `dataHash` produced by the re-encryption (verifier-validated). */
  newDataHash: Hex;
  /** Final `encryptedStorageURI` produced by {@link prepareInftAcquisition}. */
  newEncryptedStorageURI: string;
  /** Free-form description written into `IntelligentData[].dataDescription`. */
  dataDescription: string;
  /**
   * Additional pre-existing slots to keep alongside the refreshed one.
   * Defaults to `[]` (single-slot iNFT). Mirrors the seller-side
   * {@link INftEncryptAndUpdateInput.additionalSlots} convention.
   */
  additionalSlots?: ReadonlyArray<IntelligentData>;
  /**
   * Wait for the `update(...)` receipt before returning. Default `true`
   * — without this, downstream reads can race ahead of confirmation
   * and surface the stale seller URI.
   */
  waitForReceipt?: boolean;
};

/** Result of {@link repointInftAfterAcquisition}. */
export type RepointInftAfterAcquisitionResult = {
  /** `update(...)` transaction hash. */
  updateTxHash: Hex;
  /** `ownerOf(tokenId)` reading **after** the post-transfer update mined. */
  newOwner: Address;
};

/**
 * Post-transfer fixup: ERC-7857 `iTransfer` auto-updates the new
 * owner's `dataHash` (validated by the verifier) but leaves
 * `encryptedStorageURI` pointing at the SELLER's ciphertext. Call
 * `update(...)` ourselves to repoint the URI at the buyer's freshly
 * uploaded ciphertext, then read `ownerOf(tokenId)` to confirm the
 * transfer landed.
 */
export async function repointInftAfterAcquisition(
  input: RepointInftAfterAcquisitionInput,
): Promise<RepointInftAfterAcquisitionResult> {
  const updateTxHash = await input.nft.update({
    tokenId: input.tokenId,
    newDatas: [
      {
        dataDescription: input.dataDescription,
        dataHash: input.newDataHash,
      },
      ...(input.additionalSlots ?? []),
    ],
    newEncryptedStorageURI: input.newEncryptedStorageURI,
  });
  if (input.waitForReceipt !== false) {
    if (!input.publicClient) {
      throw new Error(
        "@acl/inft: repointInftAfterAcquisition requires `publicClient` when `waitForReceipt` is not false",
      );
    }
    await waitForReceiptResilient(input.publicClient, updateTxHash);
  }
  const newOwner = await input.nft.ownerOf(input.tokenId);
  return { updateTxHash, newOwner };
}
