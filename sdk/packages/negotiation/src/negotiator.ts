import {
  type AclDeployment,
  type AclEip712Domain,
  JOB_PROPOSAL_TYPES,
  type JobProposal,
  buildJobProposalDomain,
} from "@acl/core";
import {
  type Address,
  type Hex,
  type LocalAccount,
  type WalletClient,
  hashTypedData,
} from "viem";
import {
  AxlBridge,
  type AxlBridgeConfig,
  DEFAULT_AXL_RECV_TIMEOUT_MS,
  type ReceivedMessage,
} from "./bridge.js";
import {
  type AcceptMessage,
  type AcceptPayload,
  type AckMessage,
  type AckPayload,
  type CancelMessage,
  type CancelPayload,
  type CounterMessage,
  type ErrorMessage,
  type ErrorPayload,
  type HelloMessage,
  type HelloPayload,
  type NegotiationMessage,
  type NegotiationMessageType,
  type ProposeMessage,
  type RejectMessage,
  type TaskSpec,
  makeEnvelope,
} from "./messages.js";
import {
  deserializeJobProposal,
  hashTaskSpec,
  recoverJobProposalSigner,
  serializeJobProposal,
  signJobProposal,
} from "./proposal.js";
import { Transcript } from "./transcript.js";

/** Fields the caller supplies to build a JobProposal. `taskSpecHash` is computed from the TaskSpec. */
export type JobProposalDraft = Omit<JobProposal, "taskSpecHash">;

/**
 * Configuration for {@link Negotiator} / {@link createNegotiator}.
 *
 * Either `domain` or `deployment` must be supplied:
 *   - Pass `deployment` for the common case — the factory derives the
 *     canonical EIP-712 domain from the deployment's `agenticCommerce`
 *     contract and chain id. This is the recommended path so consumers
 *     never have to hand-build the domain (which would be a footgun if it
 *     diverged from the on-chain `AgenticCommerce` deployment they're
 *     funding the job against).
 *   - Pass `domain` when the consumer is bridging to a non-default
 *     deployment (custom `AgenticCommerce` instance, fork, multi-tenant
 *     marketplace, …) and already has a precomputed domain.
 */
export type NegotiatorConfig = AxlBridgeConfig & {
  /** Live ACL deployment whose `AgenticCommerce` and `chainId` parameters the EIP-712 domain pins. */
  deployment?: AclDeployment;
  /** Pre-built EIP-712 domain. Mutually exclusive with `deployment`; takes precedence when both are supplied. */
  domain?: AclEip712Domain;
  /** viem signer used for ACCEPT messages. Either a WalletClient or LocalAccount. */
  signer: WalletClient | LocalAccount;
  /**
   * Address representing the local agent (for self-recognition + the
   * `signer` field of every outbound `ACCEPT` payload). Optional; defaults
   * to the signer's account address.
   *
   * Pass explicitly when the wire-level identity is meant to differ from
   * the EIP-712 signing key (e.g. when a future smart-account integration
   * re-points to an ERC-1271 contract). Note: today's `verifyAccept`
   * strictly recovers the EOA from the secp256k1 signature, so passing a
   * `selfAddress` that is NOT the signer's address will cause peers to
   * reject the ACCEPT until ERC-1271 verification lands. Track support
   * explicitly before relying on it.
   */
  selfAddress?: Address;
  /** Optional transcript instance to share with consumers. Defaults to a fresh one. */
  transcript?: Transcript;
};

/**
 * High-level negotiation client. Wraps an {@link AxlBridge}, a viem signer,
 * and a {@link Transcript}, exposing typed convenience methods for the 8
 * pre-on-chain message types in the ACL negotiation envelope (HELLO,
 * PROPOSE, COUNTER, ACCEPT, REJECT, CANCEL, ACK, ERROR).
 *
 * The class is intentionally state-light: there is no implicit FSM, so both
 * client- and provider-shaped flows compose the same primitives. Callers
 * decide who sends what and when.
 */
export class Negotiator {
  readonly bridge: AxlBridge;
  readonly transcript: Transcript;
  readonly domain: AclEip712Domain;
  readonly selfAddress: Address;
  private readonly signer: WalletClient | LocalAccount;

  constructor(cfg: NegotiatorConfig) {
    this.bridge = new AxlBridge(cfg);
    this.transcript = cfg.transcript ?? new Transcript();
    this.domain = resolveDomain(cfg);
    this.signer = cfg.signer;
    this.selfAddress = cfg.selfAddress ?? deriveSelfAddress(cfg.signer);
  }

  // ---------- senders ----------

  async hello(
    destPeerId: string,
    payload: HelloPayload = {},
  ): Promise<HelloMessage> {
    const env = makeEnvelope<HelloMessage>("HELLO", payload);
    await this._sendTracked(destPeerId, env);
    return env;
  }

  /**
   * Build a {@link JobProposal} from a draft + TaskSpec, send it, and return
   * the full proposal struct + envelope so the caller can keep them for the
   * subsequent ACCEPT round.
   */
  async propose(params: {
    destPeerId: string;
    taskSpec: TaskSpec;
    draft: JobProposalDraft;
    replyTo?: string | null;
  }): Promise<{ envelope: ProposeMessage; proposal: JobProposal }> {
    const proposal: JobProposal = {
      ...params.draft,
      taskSpecHash: hashTaskSpec(params.taskSpec),
    };
    const env = makeEnvelope<ProposeMessage>(
      "PROPOSE",
      { taskSpec: params.taskSpec, proposal: serializeJobProposal(proposal) },
      { replyTo: params.replyTo ?? null },
    );
    await this._sendTracked(params.destPeerId, env);
    return { envelope: env, proposal };
  }

  /**
   * Counter an existing proposal. The new TaskSpec MUST be re-hashed and the
   * new proposal returned to keep both parties in sync.
   */
  async counter(params: {
    destPeerId: string;
    replyTo: string;
    taskSpec: TaskSpec;
    draft: JobProposalDraft;
    reason?: string;
  }): Promise<{ envelope: CounterMessage; proposal: JobProposal }> {
    const proposal: JobProposal = {
      ...params.draft,
      taskSpecHash: hashTaskSpec(params.taskSpec),
    };
    const env = makeEnvelope<CounterMessage>(
      "COUNTER",
      {
        taskSpec: params.taskSpec,
        proposal: serializeJobProposal(proposal),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      },
      { replyTo: params.replyTo },
    );
    await this._sendTracked(params.destPeerId, env);
    return { envelope: env, proposal };
  }

  /**
   * Sign `proposal` with the local signer and return an `AcceptPayload`.
   * Useful when the caller wants to inspect the signature before shipping.
   */
  async signAccept(proposal: JobProposal): Promise<AcceptPayload> {
    const signature: Hex = await signJobProposal(
      proposal,
      this.signer,
      this.domain,
    );
    return {
      proposal: serializeJobProposal(proposal),
      signer: this.selfAddress,
      signature,
    };
  }

  /**
   * Sign + send an ACCEPT in a single shot.
   */
  async accept(params: {
    destPeerId: string;
    replyTo: string;
    proposal: JobProposal;
  }): Promise<{ envelope: AcceptMessage; payload: AcceptPayload }> {
    const payload = await this.signAccept(params.proposal);
    const env = makeEnvelope<AcceptMessage>("ACCEPT", payload, {
      replyTo: params.replyTo,
    });
    await this._sendTracked(params.destPeerId, env);
    return { envelope: env, payload };
  }

  async reject(params: {
    destPeerId: string;
    replyTo?: string | null;
    reason?: string;
  }): Promise<RejectMessage> {
    const env = makeEnvelope<RejectMessage>(
      "REJECT",
      params.reason !== undefined ? { reason: params.reason } : {},
      { replyTo: params.replyTo ?? null },
    );
    await this._sendTracked(params.destPeerId, env);
    return env;
  }

  /**
   * Withdraw a previously sent PROPOSE / COUNTER without rejecting an
   * incoming offer.
   */
  async cancel(params: {
    destPeerId: string;
    replyTo: string;
    reason?: string;
  }): Promise<CancelMessage> {
    const payload: CancelPayload =
      params.reason !== undefined ? { reason: params.reason } : {};
    const env = makeEnvelope<CancelMessage>("CANCEL", payload, {
      replyTo: params.replyTo,
    });
    await this._sendTracked(params.destPeerId, env);
    return env;
  }

  /**
   * Plain receipt acknowledgement. Useful as a "I saw your message" beacon
   * during multi-party flows where round-trip latency is observable.
   */
  async ack(params: {
    destPeerId: string;
    replyTo: string;
    note?: string;
  }): Promise<AckMessage> {
    const payload: AckPayload =
      params.note !== undefined ? { note: params.note } : {};
    const env = makeEnvelope<AckMessage>("ACK", payload, {
      replyTo: params.replyTo,
    });
    await this._sendTracked(params.destPeerId, env);
    return env;
  }

  /**
   * Surface a protocol-level error back to the peer (malformed payload,
   * unknown message type, schema mismatch, …). Distinct from `reject`,
   * which terminates a negotiation cleanly.
   */
  async error(params: {
    destPeerId: string;
    replyTo?: string | null;
    code: string;
    message: string;
  }): Promise<ErrorMessage> {
    const payload: ErrorPayload = {
      code: params.code,
      message: params.message,
    };
    const env = makeEnvelope<ErrorMessage>("ERROR", payload, {
      replyTo: params.replyTo ?? null,
    });
    await this._sendTracked(params.destPeerId, env);
    return env;
  }

  // ---------- receiver ----------

  /**
   * Wait for the next message of `type`, recording every poll into the
   * transcript (including any messages that didn't match the filter).
   *
   * Use this when the protocol step has only one valid next type — e.g.
   * the initiator waiting for the counter-party's `ACCEPT`. If multiple
   * types are valid (e.g. `ACCEPT | COUNTER | REJECT`), prefer
   * {@link waitForOneOf} so a peer's mid-flight `REJECT` doesn't get
   * silently buried in the transcript while we time out.
   */
  async waitFor<T extends NegotiationMessageType>(
    type: T,
    opts: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<
    Extract<NegotiationMessage, { type: T }> & { fromPeerId: string }
  > {
    return this.waitForOneOf([type], opts) as Promise<
      Extract<NegotiationMessage, { type: T }> & { fromPeerId: string }
    >;
  }

  /**
   * Wait for the next message whose `type` is in `types`, recording every
   * poll (matching or not) into the transcript. Resolves to the first
   * match together with the AXL routable peer id.
   *
   * The discriminated-union return type narrows on the caller side via
   * `if (msg.type === "ACCEPT") {...}`, so consumers don't lose the typed
   * payload when accepting multiple shapes. Throws on `timeoutMs` if no
   * matching message arrives.
   */
  async waitForOneOf<T extends NegotiationMessageType>(
    types: readonly T[],
    opts: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      /**
       * Optional thread filter — when set, only messages whose
       * `replyTo` equals `replyToId` are returned. Anything else is
       * silently recorded into the transcript so a late envelope from
       * a previous round (e.g. a slow REJECT after we already moved
       * on to the next-ranked provider) doesn't get matched by the
       * type-only filter.
       */
      replyToId?: string;
    } = {},
  ): Promise<
    Extract<NegotiationMessage, { type: T }> & { fromPeerId: string }
  > {
    const matchSet = new Set<NegotiationMessageType>(types);
    const replyToId = opts.replyToId;
    const got = await this.bridge.recv({
      timeoutMs: opts.timeoutMs ?? DEFAULT_AXL_RECV_TIMEOUT_MS,
      ...(opts.pollIntervalMs !== undefined
        ? { pollIntervalMs: opts.pollIntervalMs }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      match: (m) =>
        matchSet.has(m.type) &&
        (replyToId === undefined || m.replyTo === replyToId),
      onSkipped: (s) =>
        this.transcript.add("received", s.fromPeerId, s.message),
    });
    this.transcript.add("received", got.fromPeerId, got.message);
    return Object.assign(got.message, {
      fromPeerId: got.fromPeerId,
    }) as Extract<NegotiationMessage, { type: T }> & {
      fromPeerId: string;
    };
  }

  /** Single non-blocking poll that records the result in the transcript. */
  async pollOnce(): Promise<ReceivedMessage | null> {
    const got = await this.bridge.recvOnce();
    if (got) {
      this.transcript.add("received", got.fromPeerId, got.message);
    }
    return got;
  }

  // ---------- verification helpers ----------

  /**
   * Verify an `AcceptPayload` against the local proposal we sent in
   * the matching PROPOSE / COUNTER round.
   *
   * Three independent checks:
   *   1. The payload's `JobProposal` body hashes to the same EIP-712
   *      digest as our local copy — any field divergence (`amount`,
   *      `hook`, `nonce`, `expiresAt`, …) throws here.
   *   2. The signature recovers to `expected` (the counterpart's EOA
   *      we resolved off-chain via ENSIP-25).
   *   3. The payload's self-declared `signer` field also equals
   *      `expected` — a defence-in-depth check against a peer that
   *      forwards a valid signature but lies about who they are.
   *
   * `proposal` is REQUIRED. Earlier revisions of this method made it
   * optional, which let callers skip the body-equality check and
   * accept any well-formed signed proposal — opening the door to a
   * peer echoing back an ACCEPT carrying a different `amount` /
   * `hook` than the one we negotiated. The check is too important to
   * leave opt-in, so the SDK now demands the local proposal at every
   * call site.
   *
   * Returns the recovered signer on success; throws otherwise.
   */
  async verifyAccept(
    payload: AcceptPayload,
    expected: Address,
    proposal: JobProposal,
  ): Promise<Address> {
    const acceptedProposal = deserializeJobProposal(payload.proposal);

    const localHash = hashTypedData({
      domain: this.domain,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: proposal,
    });
    const acceptedHash = hashTypedData({
      domain: this.domain,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: acceptedProposal,
    });
    if (localHash !== acceptedHash) {
      throw new Error(
        `verifyAccept: proposal mismatch. expected EIP-712 digest ${localHash}, got ${acceptedHash}`,
      );
    }

    const recovered = await recoverJobProposalSigner({
      proposal: acceptedProposal,
      signature: payload.signature,
      domain: this.domain,
    });
    if (recovered.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `verifyAccept: signer mismatch. expected ${expected}, got ${recovered}`,
      );
    }
    if (payload.signer.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `verifyAccept: payload.signer (${payload.signer}) disagrees with expected (${expected})`,
      );
    }
    return recovered;
  }

  // ---------- internals ----------

  private async _sendTracked(
    destPeerId: string,
    message: NegotiationMessage,
  ): Promise<void> {
    await this.bridge.send(destPeerId, message);
    this.transcript.add("sent", destPeerId, message);
  }
}

/**
 * Single-line factory for the common case: AXL bridge + negotiator
 * configured against a viem signer. Equivalent to `new Negotiator(cfg)`,
 * but reads more like English at the call-site.
 */
export function createNegotiator(cfg: NegotiatorConfig): Negotiator {
  return new Negotiator(cfg);
}

/**
 * Resolve a sensible `selfAddress` from the signer when the caller didn't
 * pass one explicitly. Both viem `LocalAccount` and `WalletClient` (with
 * an attached `account`) expose an `.address` we can use directly.
 */
function deriveSelfAddress(signer: WalletClient | LocalAccount): Address {
  if ("type" in signer && signer.type === "local") {
    return (signer as LocalAccount).address;
  }
  const account = (signer as WalletClient).account;
  if (account?.address) return account.address as Address;
  throw new Error(
    "createNegotiator: cannot derive selfAddress (signer has no `.address` or `account.address`); pass `selfAddress` explicitly.",
  );
}

/**
 * Resolve the EIP-712 domain from the config. Prefers an explicit
 * `domain` (so callers using a custom `AgenticCommerce` deployment don't
 * have to wrap their config in a fake `AclDeployment`); otherwise builds
 * it from `deployment.galileo.{chainId, agenticCommerce}`. Throws when
 * neither is supplied so the misconfiguration surfaces at construction
 * time, not at the first signature attempt.
 */
function resolveDomain(cfg: NegotiatorConfig): AclEip712Domain {
  if (cfg.domain) return cfg.domain;
  if (cfg.deployment) {
    return buildJobProposalDomain({
      chainId: cfg.deployment.galileo.chainId,
      agenticCommerce: cfg.deployment.galileo.agenticCommerce,
    });
  }
  throw new Error(
    "createNegotiator: pass either `deployment` (recommended) or a pre-built `domain` so the EIP-712 signature pins the on-chain AgenticCommerce contract.",
  );
}
