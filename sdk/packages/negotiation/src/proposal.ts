import {
  type AclEip712Domain,
  JOB_PROPOSAL_TYPES,
  type JobProposal,
  type TaskSpec,
  hashTaskSpec,
  normalizeAddress,
} from "@acl/core";
import {
  type Address,
  type Hex,
  type LocalAccount,
  type WalletClient,
  bytesToHex,
  recoverTypedDataAddress,
  verifyTypedData,
} from "viem";
import type { SerializedJobProposal } from "./messages.js";

// `hashTaskSpec` ships from `@acl/core` so the canonical-JSON hashing rules
// are shared with `@acl/storage`. Re-export here so existing
// `@acl/negotiation` consumers continue to import it from this package.
export { hashTaskSpec };

/**
 * Serialise a {@link JobProposal} (bigints) into the JSON-friendly shape used
 * over the AXL wire.
 */
export function serializeJobProposal(p: JobProposal): SerializedJobProposal {
  return {
    client: p.client,
    provider: p.provider,
    evaluator: p.evaluator,
    paymentToken: p.paymentToken,
    amount: p.amount.toString(),
    hook: p.hook,
    taskSpecHash: p.taskSpecHash,
    expiresAt: p.expiresAt.toString(),
    nonce: p.nonce,
  };
}

/**
 * Inverse of {@link serializeJobProposal}.
 *
 * Validates every field strictly: a peer-supplied proposal that fails
 * any of these checks could not have been produced by a well-behaved
 * counterpart, so we refuse to deserialize rather than let a malformed
 * value reach `signTypedData` or the on-chain `createJob` call.
 *
 * Checks:
 *   - all `Address`-typed fields are EIP-55 valid hex,
 *   - `taskSpecHash` is 32 bytes (`0x` + 64 hex),
 *   - `nonce` is 32 bytes (`0x` + 64 hex),
 *   - `amount` and `expiresAt` parse as non-negative bigints (the
 *     `0x` / `n` literal form is rejected — the wire format is the
 *     decimal string `serializeJobProposal` produces).
 */
export function deserializeJobProposal(s: SerializedJobProposal): JobProposal {
  // `normalizeAddress` accepts both lowercased and checksummed input
  // (peer-supplied addresses sometimes lose their checksum across the
  // AXL / JSON wire) and re-emits the EIP-55 checksummed form so the
  // rest of the SDK sees a single canonical shape.
  const client = normalizeAddress(s.client);
  if (!client) throw new Error(`deserializeJobProposal: not an address: ${s.client}`);
  const provider = normalizeAddress(s.provider);
  if (!provider) throw new Error(`deserializeJobProposal: not an address: ${s.provider}`);
  const evaluator = normalizeAddress(s.evaluator);
  if (!evaluator) throw new Error(`deserializeJobProposal: not an address: ${s.evaluator}`);
  const paymentToken = normalizeAddress(s.paymentToken);
  if (!paymentToken) throw new Error(`deserializeJobProposal: not an address: ${s.paymentToken}`);
  const hook = normalizeAddress(s.hook);
  if (!hook) throw new Error(`deserializeJobProposal: not an address: ${s.hook}`);
  if (!_isBytes32Hex(s.taskSpecHash)) {
    throw new Error(
      `deserializeJobProposal: taskSpecHash must be 0x + 64 hex, got ${s.taskSpecHash}`,
    );
  }
  if (!_isBytes32Hex(s.nonce)) {
    throw new Error(
      `deserializeJobProposal: nonce must be 0x + 64 hex, got ${s.nonce}`,
    );
  }
  const amount = _parsePositiveBigint(s.amount, "amount");
  const expiresAt = _parsePositiveBigint(s.expiresAt, "expiresAt");
  return {
    client,
    provider,
    evaluator,
    paymentToken,
    amount,
    hook,
    taskSpecHash: s.taskSpecHash,
    expiresAt,
    nonce: s.nonce,
  };
}

function _isBytes32Hex(v: string): v is Hex {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}

function _parsePositiveBigint(raw: string, label: string): bigint {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    throw new Error(
      `deserializeJobProposal: ${label} must be a decimal string, got ${raw}`,
    );
  }
  return BigInt(raw);
}

/** Generate a random 32-byte nonce for a JobProposal. */
export function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Assert that a {@link TaskSpec} body actually hashes to the
 * `taskSpecHash` carried by a {@link JobProposal}. ERC-8183 dual-signed
 * commitments only bind to the proposal struct (which carries the hash);
 * the body lives outside the EIP-712 message. Both negotiation
 * counterparts MUST call this after deserialising a peer-supplied
 * `(taskSpec, proposal)` pair before signing or acting on it, otherwise
 * a malicious peer can desync the off-chain signed hash from the body
 * the SDK uploads + the on-chain `Job.description` records.
 *
 * Throws a structured `Error` with the expected vs received hashes when
 * the body and the proposal disagree. The throw message is safe to
 * surface as a NEGOTIATION error payload.
 */
export function assertTaskSpecMatchesProposal(
  taskSpec: TaskSpec,
  proposal: JobProposal,
): void {
  const localHash = hashTaskSpec(taskSpec);
  if (localHash !== proposal.taskSpecHash) {
    throw new Error(
      `taskSpec body does not match proposal.taskSpecHash (expected ${proposal.taskSpecHash}, got ${localHash})`,
    );
  }
}

/**
 * Sign a {@link JobProposal} with EIP-712. Accepts either a viem
 * `WalletClient` (hosted-wallet flow) or a `LocalAccount` (private-key
 * flow). The result is the 65-byte signature in `0x…` form.
 *
 * `LocalAccount` is identified at runtime by the presence of a `type`
 * field equal to `"local"` (per viem's account model). Anything else is
 * treated as a `WalletClient` and routed through its `signTypedData`
 * action, which requires the caller to pass an `account`.
 */
export async function signJobProposal(
  proposal: JobProposal,
  signer: WalletClient | LocalAccount,
  domain: AclEip712Domain,
): Promise<Hex> {
  const typedDataArgs = {
    domain,
    types: JOB_PROPOSAL_TYPES,
    primaryType: "JobProposal" as const,
    message: proposal,
  };

  if ("type" in signer && signer.type === "local") {
    return (signer as LocalAccount).signTypedData(typedDataArgs);
  }

  const wallet = signer as WalletClient;
  if (!wallet.account) {
    throw new Error(
      "signJobProposal: WalletClient has no `account`. Configure one or pass a LocalAccount.",
    );
  }
  return wallet.signTypedData({
    account: wallet.account,
    ...typedDataArgs,
  });
}

/**
 * Recover the signer of a JobProposal signature.
 */
export async function recoverJobProposalSigner(params: {
  proposal: JobProposal;
  signature: Hex;
  domain: AclEip712Domain;
}): Promise<Address> {
  return recoverTypedDataAddress({
    domain: params.domain,
    types: JOB_PROPOSAL_TYPES,
    primaryType: "JobProposal",
    message: params.proposal,
    signature: params.signature,
  });
}

/**
 * Verify a JobProposal signature against an expected signer. Returns
 * `true` only when the recovered address matches `expected`.
 */
export async function verifyJobProposalSignature(params: {
  proposal: JobProposal;
  signature: Hex;
  expected: Address;
  domain: AclEip712Domain;
}): Promise<boolean> {
  return verifyTypedData({
    address: params.expected,
    domain: params.domain,
    types: JOB_PROPOSAL_TYPES,
    primaryType: "JobProposal",
    message: params.proposal,
    signature: params.signature,
  });
}
