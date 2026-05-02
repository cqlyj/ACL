/**
 * ERC-7857 transfer-validity proof helpers. Builds the off-chain
 * signatures that `TrustedPartyVerifier` recovers in
 * `_verifySingleProof`.
 *
 * The signing preimages are kept byte-for-byte aligned with
 * `src/inft/TrustedPartyVerifier.sol`:
 *
 * ```solidity
 * ownershipHash = keccak256(abi.encode(
 *   address(verifier), block.chainid,
 *   ownershipProof.oracleType,
 *   ownershipProof.oldDataHash,
 *   ownershipProof.newDataHash,
 *   ownershipProof.sealedKey,
 *   ownershipProof.encryptedPubKey,
 *   ownershipProof.nonce
 * ));
 * accessHash = keccak256(abi.encode(
 *   address(verifier), block.chainid,
 *   accessProof.oldDataHash,
 *   accessProof.newDataHash,
 *   accessProof.encryptedPubKey,
 *   accessProof.nonce
 * ));
 * ```
 *
 * Both are then `toEthSignedMessageHash`'d and verified with
 * `recover(...)`.
 */
import {
  type Address,
  type Hex,
  type LocalAccount,
  bytesToHex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
} from "viem";

import { encryptIntelligentData } from "./crypto.js";

/**
 * Verifier `OracleType` enum. Mirror of
 * `src/inft/TrustedPartyVerifier.sol`'s `OracleType { TEE, ZKP }`.
 */
export enum OracleType {
  TEE = 0,
  ZKP = 1,
}

/** Random nonce length for `accessProof.nonce` (bytes, no on-chain constraint). */
const ACCESS_NONCE_BYTES = 32;

/**
 * Encode the current Unix timestamp as `abi.encode(uint256)` (exactly
 * 32 bytes). Required when the deployed verifier has `maxProofAge > 0`
 * — the contract `abi.decode`s the nonce as a `uint256` Unix timestamp
 * and rejects anything else (`MalformedNonce`, `ProofExpired`).
 */
export function defaultOwnershipNonce(): Hex {
  const seconds = BigInt(Math.floor(Date.now() / 1000));
  return encodeAbiParameters([{ type: "uint256" }], [seconds]);
}

/** 32 cryptographically-random bytes — used as `accessProof.nonce`. */
export function randomAccessNonce(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(ACCESS_NONCE_BYTES)));
}

/**
 * On-chain `AccessProof` shape (must match the contract struct order).
 */
export type AccessProof = {
  oldDataHash: Hex;
  newDataHash: Hex;
  nonce: Hex;
  encryptedPubKey: Hex;
  proof: Hex;
};

/**
 * On-chain `OwnershipProof` shape (must match the contract struct order).
 */
export type OwnershipProof = {
  oracleType: OracleType;
  oldDataHash: Hex;
  newDataHash: Hex;
  sealedKey: Hex;
  encryptedPubKey: Hex;
  nonce: Hex;
  proof: Hex;
};

/**
 * On-chain `TransferValidityProof` shape — passed verbatim to
 * `iTransfer` / `iClone`.
 */
export type TransferValidityProof = {
  accessProof: AccessProof;
  ownershipProof: OwnershipProof;
};

/** Inputs to {@link signOwnershipProof}. */
export type OwnershipProofInput = {
  oldDataHash: Hex;
  newDataHash: Hex;
  sealedKey: Hex;
  encryptedPubKey: Hex;
  oracleType?: OracleType;
  /**
   * Override the auto-generated timestamp nonce. Only safe when the
   * deployed verifier has `maxProofAge == 0`. The default is the
   * canonical `abi.encode(uint256 now)` form required by `maxProofAge >
   * 0` deployments.
   */
  nonce?: Hex;
};

/** Inputs to {@link signAccessProof}. */
export type AccessProofInput = {
  oldDataHash: Hex;
  newDataHash: Hex;
  encryptedPubKey: Hex;
  /** Override the random nonce — only used to make tests deterministic. */
  nonce?: Hex;
};

/**
 * Sign the ownership-proof preimage with the verifier's authorised
 * oracle EOA. The returned object can be dropped straight into a
 * `TransferValidityProof.ownershipProof`.
 */
export async function signOwnershipProof(
  input: OwnershipProofInput,
  oracleSigner: LocalAccount,
  verifierAddr: Address,
  chainId: bigint,
): Promise<OwnershipProof> {
  const oracleType = input.oracleType ?? OracleType.TEE;
  const nonce = input.nonce ?? defaultOwnershipNonce();
  const preimage = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes" },
      { type: "bytes" },
      { type: "bytes" },
    ],
    [
      verifierAddr,
      chainId,
      oracleType,
      input.oldDataHash,
      input.newDataHash,
      input.sealedKey,
      input.encryptedPubKey,
      nonce,
    ],
  );
  const digest = keccak256(preimage);
  const signature = await oracleSigner.signMessage({
    message: { raw: hexToBytes(digest) },
  });
  return {
    oracleType,
    oldDataHash: input.oldDataHash,
    newDataHash: input.newDataHash,
    sealedKey: input.sealedKey,
    encryptedPubKey: input.encryptedPubKey,
    nonce,
    proof: signature,
  };
}

/**
 * Sign the access-proof preimage with the *receiver's* EOA (or its
 * delegate, see `delegateAccess`). The signer MUST be the recipient
 * since the contract recovers `accessSigner` and then asserts
 * `accessSigner == _to || accessSigner == delegateAssistants[_to]`.
 */
export async function signAccessProof(
  input: AccessProofInput,
  signer: LocalAccount,
  verifierAddr: Address,
  chainId: bigint,
): Promise<AccessProof> {
  const nonce = input.nonce ?? randomAccessNonce();
  const preimage = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes" },
      { type: "bytes" },
    ],
    [
      verifierAddr,
      chainId,
      input.oldDataHash,
      input.newDataHash,
      input.encryptedPubKey,
      nonce,
    ],
  );
  const digest = keccak256(preimage);
  const signature = await signer.signMessage({
    message: { raw: hexToBytes(digest) },
  });
  return {
    oldDataHash: input.oldDataHash,
    newDataHash: input.newDataHash,
    nonce,
    encryptedPubKey: input.encryptedPubKey,
    proof: signature,
  };
}

/**
 * Mnemonic substring matched against `(err as Error).message` —
 * viem's decoded contract-error path surfaces the named error here.
 */
const OLD_DATA_HASH_MISMATCH_TAG = "OldDataHashMismatch";

/**
 * 4-byte selector for `OldDataHashMismatch()` — the error has no
 * arguments, so the on-chain revert payload is exactly these four
 * bytes. Older viem versions (or non-viem callers) sometimes surface
 * just the selector without the mnemonic; matching both shapes keeps
 * the helper robust to upstream serialisation tweaks.
 *
 *   bytes4(keccak256("OldDataHashMismatch()")) = 0xc759686f
 */
const OLD_DATA_HASH_MISMATCH_SELECTOR = "0xc759686f";

/**
 * `true` iff `err` looks like an `OldDataHashMismatch` revert —
 * fired when the seller's `update(...)` lands between the buyer's
 * `oldDataHash` read and the verifier signature, so the `iTransfer`
 * driven by `INFTDeliveryHook.afterAction(complete)` (or directly by
 * the buyer) trips the staleness guard.
 *
 * Buyers should re-read `intelligentDataOf(tokenId)` and re-sign once
 * more before failing the acquisition.
 */
export function isOldDataHashMismatchError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as Error).message ?? err).toLowerCase();
  return (
    msg.includes(OLD_DATA_HASH_MISMATCH_TAG.toLowerCase()) ||
    msg.includes(OLD_DATA_HASH_MISMATCH_SELECTOR)
  );
}

/** Per-item inputs to {@link signTransferValidityProof}. */
export type SignTransferValidityProofInput = {
  oldDataHash: Hex;
  newDataHash: Hex;
  sealedKey: Hex;
  encryptedPubKey: Hex;
  verifierAddr: Address;
  chainId: bigint;
  oracleSigner: LocalAccount;
  accessSigner: LocalAccount;
  oracleType?: OracleType;
};

/**
 * Sign one `(ownershipProof, accessProof)` pair from precomputed
 * hashes and sealed key — i.e. when the caller has already encrypted
 * the IntelligentData blob (typical for buyer-side acquisition flows
 * that build the ciphertext once and reuse `keccak(ciphertext)` as
 * `newDataHash`).
 *
 * Use {@link buildTransferValidityProofs} when you also want the SDK
 * to encrypt the plaintext and derive `(newDataHash, sealedKey)` for
 * you.
 */
export async function signTransferValidityProof(
  input: SignTransferValidityProofInput,
): Promise<TransferValidityProof> {
  const ownership = await signOwnershipProof(
    {
      oldDataHash: input.oldDataHash,
      newDataHash: input.newDataHash,
      sealedKey: input.sealedKey,
      encryptedPubKey: input.encryptedPubKey,
      ...(input.oracleType !== undefined
        ? { oracleType: input.oracleType }
        : {}),
    },
    input.oracleSigner,
    input.verifierAddr,
    input.chainId,
  );
  const access = await signAccessProof(
    {
      oldDataHash: input.oldDataHash,
      newDataHash: input.newDataHash,
      encryptedPubKey: input.encryptedPubKey,
    },
    input.accessSigner,
    input.verifierAddr,
    input.chainId,
  );
  return { accessProof: access, ownershipProof: ownership };
}

/** Inputs to {@link buildTransferValidityProofs}. */
export type BuildTransferValidityProofsInput = {
  /**
   * Per-IntelligentData inputs. `oldDataHash` is read from the chain
   * IMMEDIATELY before signing (callers are responsible for that read
   * — see Section 3.11 of the plan); `plaintext` is the corpus blob
   * the receiver will decrypt with `sealedKey`.
   */
  items: ReadonlyArray<{
    oldDataHash: Hex;
    plaintext: Uint8Array;
  }>;
  verifierAddr: Address;
  chainId: bigint;
  /** Recipient SEC1 uncompressed pubkey (65 bytes). */
  recipientPubKey: Uint8Array;
  /**
   * `accessProof.encryptedPubKey` — opaque receiver-side key handle.
   * The contract treats it purely as identity-of-the-recipient bytes
   * (commits to it and checks equality on both proofs); a sensible
   * default is the SEC1-encoded form of `recipientPubKey`.
   */
  encryptedPubKey: Hex;
  oracleSigner: LocalAccount;
  accessSigner: LocalAccount;
  oracleType?: OracleType;
};

/**
 * Run the full per-item flow needed by `iTransfer` / `iClone`:
 * encrypt the corpus, ECIES-seal the symmetric key to the recipient,
 * sign the ownership + access proofs, and return the proof tuple in
 * positional order. The result is `iTransfer`-shaped.
 */
export async function buildTransferValidityProofs(
  input: BuildTransferValidityProofsInput,
): Promise<TransferValidityProof[]> {
  const proofs: TransferValidityProof[] = [];
  for (const item of input.items) {
    const encrypted = await encryptIntelligentData(
      item.plaintext,
      input.recipientPubKey,
    );
    proofs.push(
      await signTransferValidityProof({
        oldDataHash: item.oldDataHash,
        newDataHash: encrypted.dataHash,
        sealedKey: bytesToHex(encrypted.sealedKey),
        encryptedPubKey: input.encryptedPubKey,
        verifierAddr: input.verifierAddr,
        chainId: input.chainId,
        oracleSigner: input.oracleSigner,
        accessSigner: input.accessSigner,
        ...(input.oracleType !== undefined
          ? { oracleType: input.oracleType }
          : {}),
      }),
    );
  }
  return proofs;
}
