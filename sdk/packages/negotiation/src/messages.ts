import type { TaskSpec } from "@acl/core";
import type { Address, Hex } from "viem";

/**
 * Wire protocol identifier used in every ACL negotiation message. Changes to
 * the envelope shape MUST bump the version.
 */
export const ACL_NEGOTIATION_PROTOCOL = "acl.axl.v1" as const;

/**
 * Generic envelope every negotiation message rides in. AXL nodes treat the
 * body as opaque bytes; `protocol` / `type` / `id` exist purely so consumers
 * can de-multiplex and correlate.
 */
export type Envelope<T extends string, P> = {
  protocol: typeof ACL_NEGOTIATION_PROTOCOL;
  type: T;
  /** Unique message id; UUIDv4 strings are recommended. */
  id: string;
  /** `id` of the message this one replies to (for request/response style). */
  replyTo: string | null;
  /** ISO-8601 UTC timestamp the sender stamped at send time. */
  createdAt: string;
  payload: P;
};

/**
 * JobProposal carried over the wire. Bigints are JSON-stringified so the
 * envelope round-trips through `JSON.stringify`. The receiver must rehydrate
 * before passing to viem helpers.
 *
 * Field order mirrors the EIP-712 `JobProposal` struct in `@acl/core`. The
 * named `hook` field is added vs a vanilla ERC-8183 escrow so the signed
 * payload pins the IACPHook the on-chain `createJob` will bind. The agreed
 * deliverable shape lives inside `TaskSpec.deliveryType`, which is committed
 * to via `taskSpecHash` — the proposal therefore never carries a separate
 * delivery field.
 */
export type SerializedJobProposal = {
  client: Address;
  provider: Address;
  evaluator: Address;
  paymentToken: Address;
  amount: string;
  hook: Address;
  taskSpecHash: Hex;
  expiresAt: string;
  nonce: Hex;
};

// `TaskSpec` lives in `@acl/core` so storage / evaluation / negotiation share
// one source of truth (the canonical hash binds them all). Re-export here so
// existing `@acl/negotiation` consumers don't have to retarget their imports.
export type { TaskSpec };

// ---------- Concrete payloads ----------

export type HelloPayload = {
  /** Sender's claimed ENS name (optional but recommended). */
  ensName?: string;
  /** Sender's agentId on `acl.identityRegistry`. */
  agentId?: string;
  /** Free-form note. */
  note?: string;
};

export type ProposePayload = {
  taskSpec: TaskSpec;
  proposal: SerializedJobProposal;
};

export type CounterPayload = {
  taskSpec: TaskSpec;
  proposal: SerializedJobProposal;
  reason?: string;
};

/**
 * `ACCEPT` carries the proposal and the sender's signature. When BOTH
 * parties have ACCEPT-ed the same proposal we have a dual-signed off-chain
 * commitment ready to be funded on-chain.
 */
export type AcceptPayload = {
  proposal: SerializedJobProposal;
  signer: Address;
  signature: Hex;
};

export type RejectPayload = {
  reason?: string;
};

export type CancelPayload = {
  reason?: string;
};

export type AckPayload = {
  note?: string;
};

export type ErrorPayload = {
  /** Short machine-readable error code (e.g. "schema", "protocol", "unknown_type"). */
  code: string;
  message: string;
};

// ---------- Discriminated union ----------

export type HelloMessage = Envelope<"HELLO", HelloPayload>;
export type ProposeMessage = Envelope<"PROPOSE", ProposePayload>;
export type CounterMessage = Envelope<"COUNTER", CounterPayload>;
export type AcceptMessage = Envelope<"ACCEPT", AcceptPayload>;
export type RejectMessage = Envelope<"REJECT", RejectPayload>;
export type CancelMessage = Envelope<"CANCEL", CancelPayload>;
export type AckMessage = Envelope<"ACK", AckPayload>;
export type ErrorMessage = Envelope<"ERROR", ErrorPayload>;

/**
 * 8-message taxonomy. Coverage is deliberately scoped to the pre-on-chain
 * negotiation phase: every relevant post-on-chain transition (BudgetSet,
 * JobFunded, JobSubmitted, JobCompleted, JobRejected, JobExpired,
 * PaymentReleased) is emitted as an ERC-8183 event by `AgenticCommerce`,
 * so AXL stays a clean negotiation channel and never duplicates lifecycle
 * state.
 */
export type NegotiationMessage =
  | HelloMessage
  | ProposeMessage
  | CounterMessage
  | AcceptMessage
  | RejectMessage
  | CancelMessage
  | AckMessage
  | ErrorMessage;

export type NegotiationMessageType = NegotiationMessage["type"];

/**
 * Type-guard that an arbitrary JSON value matches our envelope contract.
 * Used by the bridge so a remote peer running an unrelated app on the same
 * AXL mesh can't poison our negotiation queue.
 */
export function isNegotiationMessage(value: unknown): value is NegotiationMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Envelope<string, unknown>>;
  return (
    v.protocol === ACL_NEGOTIATION_PROTOCOL &&
    typeof v.type === "string" &&
    typeof v.id === "string" &&
    typeof v.createdAt === "string" &&
    (v.replyTo === null || typeof v.replyTo === "string")
  );
}

/**
 * Build an envelope with sensible defaults. Pass `replyTo` when continuing a
 * conversation; let it default to `null` for fresh threads.
 */
export function makeEnvelope<T extends NegotiationMessage>(
  type: T["type"],
  payload: T["payload"],
  opts: { id?: string; replyTo?: string | null } = {},
): T {
  return {
    protocol: ACL_NEGOTIATION_PROTOCOL,
    type,
    id: opts.id ?? randomId(),
    replyTo: opts.replyTo ?? null,
    createdAt: new Date().toISOString(),
    payload,
  } as T;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}
