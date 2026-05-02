/**
 * `ReencryptionOracle` — the trust surface ERC-7857 (`iTransfer` /
 * `iClone`) bottoms out at. The contract layer only sees a signed
 * `OwnershipProof`; the proof signer (= `oracle`) is the entity the
 * verifier (e.g. `TrustedPartyVerifier`) trusts to assert that the new
 * ciphertext really decrypts to the same plaintext as the old one and
 * that the new sealed key is bound to the receiver's pubkey.
 *
 * In production the oracle runs inside a TEE: the seller hands the
 * sealed AES key + ciphertext to the enclave; the enclave decrypts,
 * generates a fresh AES key, re-encrypts under the receiver's pubkey,
 * and signs the resulting `OwnershipProof` with an oracle EOA whose
 * private key never leaves the enclave. The buyer then signs the
 * matching `AccessProof` with their own EOA and ships both to the
 * verifier.
 *
 * For local development ACL ships {@link createDemoLocalReencryptionOracle},
 * which inlines the same algorithm in-process — handy for testnets and
 * unit tests where a TEE is overkill. Production deployments implement
 * {@link ReencryptionOracle} directly against their enclave / KMS so
 * the plaintext never leaves the trust boundary.
 *
 * Design rationale (kept here intentionally so SDK consumers can read it):
 *
 *   • The oracle owns BOTH re-encryption and ownership-proof signing
 *     because in a TEE deployment they MUST happen inside the same
 *     trust boundary — splitting them would force the enclave to leak
 *     the freshly-generated AES key. Mirroring that boundary in the
 *     interface keeps the layered abstractions honest and makes the
 *     dev-time substitute (`demo-local`) functionally equivalent to
 *     production from the call-site's POV.
 *
 *   • The oracle does NOT sign the access proof. Per ERC-7857 the
 *     access proof signer must be the recipient (or its delegate),
 *     since the verifier recovers the signer and asserts equality
 *     against `to` / `delegateAssistants[to]`. Asking an oracle to
 *     sign on the recipient's behalf would defeat the proof.
 *
 *   • The "demo-local" oracle resolves the seller's raw AES key via
 *     a caller-supplied `fetchDataKey` callback. The example app
 *     wires this to a coordinator HTTP endpoint; another developer
 *     could wire it to a key file, an in-memory map, or a key-server
 *     RPC — the SDK stays neutral about custody policy.
 */
import type { Address, Hex, LocalAccount } from "viem";
import { bytesToHex } from "viem";

import {
  decryptIntelligentDataWithKey,
  encryptIntelligentData,
} from "./crypto.js";
import {
  type AccessProofInput,
  type OwnershipProof,
  type TransferValidityProof,
  OracleType,
  signAccessProof,
  signOwnershipProof,
} from "./proofs.js";

/**
 * Per-slot input the oracle needs to re-encrypt one IntelligentData
 * blob for a new recipient. Keep one `ReencryptionRequest` per
 * `IntelligentData` slot — `iTransfer` / `iClone` consume an
 * ordered array of `TransferValidityProof[]` aligned to
 * `intelligentDataOf(tokenId)`.
 */
export type ReencryptionRequest = {
  /** ERC-7857 token id being transferred. Surfaced for logging / TEE attestation binding. */
  tokenId: bigint;
  /**
   * Current ciphertext blob from the on-chain `encryptedStorageURI`.
   * The shape is whatever {@link encryptIntelligentData} produced for
   * the seller (`iv || ciphertext || authTag`).
   */
  sellerCiphertext: Uint8Array;
  /**
   * `IntelligentData.dataHash` for this slot, read straight from the
   * chain immediately before signing. The verifier will reject the
   * proof on mismatch (`OldDataHashMismatch`) so the read MUST be
   * close in time to the `iTransfer` call.
   */
  oldDataHash: Hex;
  /**
   * Recipient's secp256k1 public key in SEC1 uncompressed form
   * (`0x04 || X || Y`, 65 bytes). The oracle will ECIES-seal the
   * fresh AES key against this and bind the new ciphertext to it.
   */
  recipientPubKey: Uint8Array;
};

/**
 * Per-slot output of {@link ReencryptionOracle.reencryptForRecipient}.
 * The buyer typically uploads `newCiphertext` to whatever storage
 * layer backs `encryptedStorageURI` (e.g. 0G Storage), then calls
 * `iTransfer` with the matching `TransferValidityProof`.
 */
export type ReencryptionResult = {
  /** New ciphertext bound to the recipient's pubkey, ready for upload. */
  newCiphertext: Uint8Array;
  /** `keccak256(newCiphertext)` — feeds straight into `OwnershipProof.newDataHash`. */
  newDataHash: Hex;
  /**
   * AES key sealed to `recipientPubKey`. The verifier doesn't open it;
   * the recipient does, off-chain, with their own private key. Goes
   * verbatim into `OwnershipProof.sealedKey`.
   */
  sealedKey: Hex;
  /**
   * Signed `OwnershipProof` ready to feed into `iTransfer`. Signed by
   * the oracle EOA the verifier is authorised against.
   */
  ownershipProof: OwnershipProof;
};

/**
 * `ReencryptionOracle` — the trust boundary an ERC-7857 verifier
 * recovers signatures from. Implementations bind a single
 * `(verifierAddress, chainId, oracleType, oracleSigner)` quadruple
 * for the lifetime of the instance.
 */
export interface ReencryptionOracle {
  /** Verifier address this oracle is authorised against. */
  readonly verifierAddress: Address;
  /** Chain id the verifier lives on. */
  readonly chainId: bigint;
  /** Oracle flavour reported in `OwnershipProof.oracleType`. */
  readonly oracleType: OracleType;
  /** Signer address embedded in every `OwnershipProof`. */
  readonly signerAddress: Address;

  /**
   * Re-encrypt one IntelligentData slot for `recipientPubKey` and
   * return the on-chain materials needed to fill the corresponding
   * `OwnershipProof`. The recipient still has to sign their own
   * `AccessProof`; see {@link buildTransferValidityProofForRecipient}
   * for the convenience helper that wires both sides together.
   */
  reencryptForRecipient(req: ReencryptionRequest): Promise<ReencryptionResult>;
}

// ---------------------------------------------------------------------------
// demo-local — drop-in oracle for testnets / unit tests.
// ---------------------------------------------------------------------------

/** Inputs to {@link createDemoLocalReencryptionOracle}. */
export type DemoLocalReencryptionOracleConfig = {
  /**
   * EOA the verifier is configured to trust. Signs every
   * `OwnershipProof`; in a real deployment this key would live inside
   * a TEE.
   */
  oracleSigner: LocalAccount;
  /** Verifier contract address the oracle is authorised against. */
  verifierAddress: Address;
  /** Chain id the verifier lives on. */
  chainId: bigint;
  /**
   * Resolve the seller's raw AES-256 data key for `tokenId`. The
   * SDK is intentionally agnostic about WHERE the key lives — pass
   * a function that hits an in-process registry, a coordinator HTTP
   * endpoint, a key file, etc. Production deployments replace the
   * whole oracle with a TEE attestation, so this callback is a
   * dev-time only construct.
   */
  fetchDataKey: (tokenId: bigint) => Promise<Uint8Array>;
  /**
   * `OracleType` to advertise — defaults to `TEE` so the verifier's
   * `oracleType` enum lands on the same value as the production
   * implementation. Override only when wiring a verifier that pins
   * a different flavour.
   */
  oracleType?: OracleType;
};

/**
 * In-process oracle that decrypts the seller's ciphertext with a
 * known AES key, re-encrypts under the recipient's pubkey, and signs
 * the resulting `OwnershipProof` with `oracleSigner`. Useful for
 * tests, demos, and local development against a verifier whose
 * `authorizedOracle` slot is set to `oracleSigner.address`.
 *
 * NOTE: the seller's plaintext is briefly held in memory inside this
 * function. NEVER use the demo-local oracle in production —
 * production deployments MUST implement {@link ReencryptionOracle}
 * inside a TEE / ZKP boundary so the plaintext never leaves the
 * trust boundary.
 */
export function createDemoLocalReencryptionOracle(
  cfg: DemoLocalReencryptionOracleConfig,
): ReencryptionOracle {
  const oracleType = cfg.oracleType ?? OracleType.TEE;
  return {
    verifierAddress: cfg.verifierAddress,
    chainId: cfg.chainId,
    oracleType,
    signerAddress: cfg.oracleSigner.address,
    async reencryptForRecipient(req) {
      const dataKey = await cfg.fetchDataKey(req.tokenId);
      const plaintext = await decryptIntelligentDataWithKey(
        req.sellerCiphertext,
        dataKey,
      );
      const reencrypted = await encryptIntelligentData(
        plaintext,
        req.recipientPubKey,
      );
      const sealedKey = bytesToHex(reencrypted.sealedKey);
      const ownership = await signOwnershipProof(
        {
          oldDataHash: req.oldDataHash,
          newDataHash: reencrypted.dataHash,
          sealedKey,
          encryptedPubKey: bytesToHex(req.recipientPubKey),
          oracleType,
        },
        cfg.oracleSigner,
        cfg.verifierAddress,
        cfg.chainId,
      );
      return {
        newCiphertext: reencrypted.ciphertext,
        newDataHash: reencrypted.dataHash,
        sealedKey,
        ownershipProof: ownership,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// helper — full TransferValidityProof in one call.
// ---------------------------------------------------------------------------

/** Inputs to {@link buildTransferValidityProofForRecipient}. */
export type BuildTransferValidityProofForRecipientInput = {
  oracle: ReencryptionOracle;
  request: ReencryptionRequest;
  /**
   * EOA that signs the `AccessProof` — must be the recipient or its
   * registered delegate. The verifier recovers this signature and
   * asserts equality against `to` / `delegateAssistants[to]`.
   */
  recipient: LocalAccount;
  /**
   * Override `AccessProof.encryptedPubKey`. Defaults to the SEC1 hex
   * encoding of `request.recipientPubKey` (which is what
   * `buildTransferValidityProofs` does for callers that don't carry
   * a separate receiver-side key handle).
   */
  encryptedPubKey?: Hex;
  /** Override the random `AccessProof.nonce` — only useful for tests. */
  accessNonce?: AccessProofInput["nonce"];
};

/**
 * Re-encrypt one slot via {@link ReencryptionOracle.reencryptForRecipient}
 * AND sign the matching `AccessProof` with the recipient's EOA, returning
 * the full `TransferValidityProof` ready for `iTransfer` / `iClone`.
 */
export async function buildTransferValidityProofForRecipient(
  input: BuildTransferValidityProofForRecipientInput,
): Promise<{ proof: TransferValidityProof; reencryption: ReencryptionResult }> {
  const reencryption = await input.oracle.reencryptForRecipient(input.request);
  const encryptedPubKey =
    input.encryptedPubKey ?? bytesToHex(input.request.recipientPubKey);
  const access = await signAccessProof(
    {
      oldDataHash: input.request.oldDataHash,
      newDataHash: reencryption.newDataHash,
      encryptedPubKey,
      ...(input.accessNonce !== undefined ? { nonce: input.accessNonce } : {}),
    },
    input.recipient,
    input.oracle.verifierAddress,
    input.oracle.chainId,
  );
  return {
    proof: { accessProof: access, ownershipProof: reencryption.ownershipProof },
    reencryption,
  };
}
