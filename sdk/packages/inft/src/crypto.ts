/**
 * Symmetric data encryption + ECIES key sealing helpers for ERC-7857
 * intelligent data. The shape mirrors the 0G "Intelligent NFT" reference
 * implementation: a fresh 256-bit AES-GCM key per blob, ECIES-sealed to
 * the recipient's secp256k1 public key.
 *
 * The contract layer never decrypts on chain; it only stores
 * `dataHash = keccak256(ciphertext)` and the sealed key. This module
 * therefore deliberately omits any ECDH/symmetric primitive that touches
 * the EVM — viem stays in the contract-binding modules (`client.ts`,
 * `proofs.ts`).
 */
import { PrivateKey, decrypt, encrypt } from "eciesjs";
import { type Hex, bytesToHex, hexToBytes, keccak256 } from "viem";

/** Random AES-256-GCM key length, in bytes. */
const AES_GCM_KEY_BYTES = 32;
/** AES-GCM IV length we use for intelligent data blobs. */
const AES_GCM_IV_BYTES = 12;
/** AES-GCM auth tag length (always 16 bytes for GCM). */
const AES_GCM_TAG_BYTES = 16;

export type EncryptedIntelligentData = {
  /**
   * Concatenation of `iv (12B) || ciphertext || authTag (16B)`. This is
   * the canonical wire form the 0G reference implementation uses, so
   * we keep it identical to maximise interop.
   */
  ciphertext: Uint8Array;
  /**
   * `keccak256(ciphertext)` — the value that lands in
   * `IntelligentData.dataHash` on chain. Both the ownership proof and
   * the access proof commit to this hash.
   */
  dataHash: Hex;
  /** ECIES-sealed AES-GCM key, ready for `iTransfer` / `iClone`. */
  sealedKey: Uint8Array;
  /**
   * Raw symmetric key — returned so the caller can persist it (e.g. for
   * a self-encrypted, owner-side decrypt) without re-running ECIES.
   * NEVER expose this in an event or attestation.
   */
  dataKey: Uint8Array;
};

/**
 * Encrypt `plaintext` under a fresh AES-256-GCM key and seal that key
 * to `recipientPubKeySEC1` (65-byte uncompressed secp256k1 pubkey, the
 * standard SEC1 form `0x04 || X || Y`).
 *
 * Returns the on-chain shape (`dataHash`, `sealedKey`) plus the raw
 * symmetric key for callers that need to persist it locally.
 */
export async function encryptIntelligentData(
  plaintext: Uint8Array,
  recipientPubKeySEC1: Uint8Array,
): Promise<EncryptedIntelligentData> {
  const dataKey = crypto.getRandomValues(new Uint8Array(AES_GCM_KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(dataKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(plaintext),
    ),
  );

  const ciphertext = new Uint8Array(iv.length + ctWithTag.length);
  ciphertext.set(iv, 0);
  ciphertext.set(ctWithTag, iv.length);

  const sealedKey = encrypt(recipientPubKeySEC1, dataKey);
  const dataHash = keccak256(bytesToHex(ciphertext));

  return { ciphertext, dataHash, sealedKey, dataKey };
}

/**
 * `crypto.subtle.*` rejects `Uint8Array<SharedArrayBufferLike>` views
 * under TS strict-DOM types. Copy into a fresh, plain `ArrayBuffer`
 * so the signature lines up no matter what `Uint8Array` flavor the
 * caller hands us. Cheap (single allocation per call) and isolates
 * the rest of the module from the upstream type churn.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/**
 * Reverse of {@link encryptIntelligentData}. Recovers the symmetric
 * data key from `sealedKey` using the recipient's private key, then
 * decrypts the AES-GCM payload.
 */
export async function decryptIntelligentData(
  ciphertext: Uint8Array,
  sealedKey: Uint8Array,
  recipientPrivKey: Hex,
): Promise<Uint8Array> {
  const dataKey = decrypt(hexToBytes(recipientPrivKey), sealedKey);
  return decryptIntelligentDataWithKey(ciphertext, dataKey);
}

/**
 * AES-GCM decrypt an `iv || ciphertext || authTag` payload using a
 * raw 32-byte symmetric key — bypassing ECIES.
 *
 * Use this when the AES key is delivered out-of-band (e.g. a TEE
 * attestation oracle, a KMS handoff, or a demo-time in-process key
 * registry). For the canonical "I know my private key, decrypt the
 * sealed envelope" path use {@link decryptIntelligentData}; this
 * helper is the asymmetry escape-hatch for buyer flows that already
 * hold the raw symmetric key.
 */
export async function decryptIntelligentDataWithKey(
  ciphertext: Uint8Array,
  dataKey: Uint8Array,
): Promise<Uint8Array> {
  if (dataKey.length !== AES_GCM_KEY_BYTES) {
    throw new Error(
      `@acl/inft: dataKey must be exactly ${AES_GCM_KEY_BYTES} bytes (AES-256-GCM); got ${dataKey.length}`,
    );
  }
  if (ciphertext.length < AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error("@acl/inft: ciphertext too short to contain iv+tag");
  }
  const iv = ciphertext.slice(0, AES_GCM_IV_BYTES);
  const ctWithTag = ciphertext.slice(AES_GCM_IV_BYTES);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(dataKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      cryptoKey,
      toArrayBuffer(ctWithTag),
    ),
  );
  return plaintext;
}

/**
 * Derive the SEC1 *uncompressed* public key (`0x04 || X || Y`, 65 bytes)
 * for a given secp256k1 private key. This is the format ECIES (and the
 * iNFT contracts) consume.
 */
export function publicKeyFromPrivateKey(privKey: Hex): Hex {
  const sk = new PrivateKey(hexToBytes(privKey));
  return bytesToHex(sk.publicKey.toBytes(false));
}
