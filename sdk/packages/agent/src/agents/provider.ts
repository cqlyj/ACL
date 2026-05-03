import {
  type Deliverable,
  INFT_DELIVERY_TYPE,
  type JobProposal,
  type TaskSpec,
  decodeJobDescription,
  waitForReceiptResilient,
} from "@acl/core";
import {
  type AcceptPayload,
  type Negotiator,
  assertTaskSpecMatchesProposal,
  createNegotiator,
  deserializeJobProposal,
  generateNonce,
} from "@acl/negotiation";
import {
  JOB_FUNDED_EVENT,
  JOB_STATUS,
  createJobOrchestrator,
  getLogsPaginated,
} from "@acl/settlement";
import { type Address, type Hex, type Log, decodeEventLog } from "viem";
import { bootstrapAxl } from "../bootstrap/axl.js";
import { type AgentEventBus, createAgentEventBus } from "../events/bus.js";
import {
  DEFAULT_PROVIDER_PROMPTS,
  type ProviderPrompts,
  resolvePrompts,
} from "../llm/prompts.js";
import {
  type AgentRuntime,
  createAgentRuntime,
  pickRuntimeOverrides,
} from "../runtime.js";
import {
  DEFAULT_CHAIN_POLL_INTERVAL_MS,
  DEFAULT_NEGOTIATION_TIMEOUT_MS,
  DEFAULT_PENDING_SWEEP_INTERVAL_MS,
  DEFAULT_PROVIDER_AXL_POLL_INTERVAL_MS,
  type ProviderAgentConfig,
} from "./types.js";

/**
 * Default ceiling on parallel jobs the provider will commit to. Keep
 * conservative: every accepted proposal opens a TaskSpec → deliverable
 * → submit pipeline that races for a single nonce on the provider's
 * wallet. `1` means strict serial processing.
 */
const DEFAULT_MAX_CONCURRENT_JOBS = 1;

/**
 * Grace period (in seconds) past `proposal.expiresAt` before the
 * sweeper drops a `_pending` entry that never advanced to JobFunded.
 * Lets a JobFunded log that lands a few seconds after the negotiated
 * expiry still pair with the staged TaskSpec.
 */
const PENDING_TTL_GRACE_SECONDS = 60n;

type DecidePayload = {
  decision: "ACCEPT" | "COUNTER" | "REJECT";
  counterBudget: number | null;
  reason: string;
};

type PendingJob = {
  taskSpec: TaskSpec;
  taskSpecHash: Hex;
  agreedAmount: bigint;
  client: Address;
  /** Negotiated expiry (Unix seconds) — used by the TTL sweeper. */
  expiresAt: bigint;
};

/**
 * Provider agent: listens on AXL for incoming proposals, runs the LLM
 * to ACCEPT / COUNTER / REJECT, then watches the chain for matching
 * `JobFunded` events and produces + submits the deliverable.
 *
 * The agent intentionally keeps zero persistent state. If the process
 * restarts mid-job, the next operator action (a fresh negotiation, or
 * a manual `submit`) re-establishes the link. Restart-from-scratch is
 * the v1 contract: persistent, multi-process job choreography is
 * deferred to a future iteration.
 */
export class ProviderAgent {
  readonly events: AgentEventBus;
  private readonly _config: ProviderAgentConfig;
  private readonly _runtime: AgentRuntime;
  private readonly _prompts: ProviderPrompts;
  private _negotiator: Negotiator | null = null;
  private _peerId: string | null = null;
  private _orch: ReturnType<typeof createJobOrchestrator> | null = null;

  /**
   * Pending jobs keyed by `taskSpecHash` (not nonce — the hash is what
   * the client commits to via `description` when funding the job).
   */
  private readonly _pending = new Map<Hex, PendingJob>();
  private readonly _seenJobs = new Set<string>();
  /**
   * Number of jobs currently mid-flight on the chain side
   * (`_handleFundedLog` → `_produceAndSubmit`). Combined with
   * `_pending.size` (already-negotiated, not-yet-funded) this gives us
   * the concurrent-jobs count we cap with `acceptPolicy.maxConcurrentJobs`.
   */
  private _inFlightSubmissions = 0;
  private _running = false;
  /**
   * Highest block number we've finished scanning for `JobFunded`
   * events. Initialised in `start()` from the current chain head; the
   * `_pollChain` loop advances it forward after every successful range
   * read.
   */
  private _lastBlock = 0n;
  private _axlTimer: ReturnType<typeof setTimeout> | null = null;
  private _chainTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Periodic TTL sweep that drops `_pending` entries whose
   * `proposal.expiresAt + PENDING_TTL_GRACE_SECONDS` has passed
   * without a matching JobFunded landing on chain. Stops a
   * long-running provider from leaking memory through the slow
   * accumulation of accepted-but-never-funded proposals.
   */
  private _pendingSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ProviderAgentConfig) {
    this._config = config;
    this._runtime = createAgentRuntime({
      account: config.account,
      ...pickRuntimeOverrides(config),
    });
    this.events = config.events ?? createAgentEventBus();
    this._prompts = resolvePrompts(DEFAULT_PROVIDER_PROMPTS, config.prompts);
  }

  get address(): Address {
    return this._runtime.address;
  }

  /**
   * Read-only handle on the underlying runtime kernel — useful for
   * vertical extensions (e.g. the Flow-2 iNFT example) that need to
   * spin up adjacent contract bindings (`createINftClient(...)`)
   * sharing the same wallet/public clients. Internal mutability of
   * the runtime is NOT supported.
   */
  get runtime(): AgentRuntime {
    return this._runtime;
  }

  /** Boot AXL, the on-chain orchestrator, and start both poll loops. */
  async start(): Promise<void> {
    if (this._running) return;
    const r = this._runtime;

    const axl = await bootstrapAxl({ apiUrl: this._config.axlApiUrl });
    this._peerId = axl.peerId;

    this._negotiator = createNegotiator({
      apiUrl: this._config.axlApiUrl,
      deployment: r.deployment,
      signer: r.walletClient,
      selfAddress: r.address,
    });

    this._orch = createJobOrchestrator({
      publicClient: r.publicClient,
      walletClient: r.walletClient,
      deployment: r.deployment,
      ...(r.gasFeeOverrides !== undefined
        ? { gasFeeOverrides: r.gasFeeOverrides }
        : {}),
    });

    this._lastBlock = await r.publicClient.getBlockNumber();
    this._running = true;
    this.events.emit({
      type: "agent.boot",
      agentRole: "provider",
      ensName: this._config.ensName,
      address: r.address,
      at: new Date().toISOString(),
    });

    this._scheduleAxlPoll();
    this._scheduleChainPoll();
    this._pendingSweepTimer = setInterval(
      () => this._sweepExpiredPending(),
      this._config.pendingSweepIntervalMs ?? DEFAULT_PENDING_SWEEP_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._axlTimer) clearTimeout(this._axlTimer);
    if (this._chainTimer) clearTimeout(this._chainTimer);
    if (this._pendingSweepTimer) clearInterval(this._pendingSweepTimer);
    this.events.emit({
      type: "agent.shutdown",
      agentRole: "provider",
      address: this._runtime.address,
      at: new Date().toISOString(),
    });
  }

  /** Public peer id for the AXL bridge — useful for tests / web UI. */
  get peerId(): string {
    if (!this._peerId) throw new Error("ProviderAgent not started");
    return this._peerId;
  }

  // ---------- AXL loop ----------

  private _scheduleAxlPoll(): void {
    if (!this._running) return;
    this._axlTimer = setTimeout(() => {
      this._pollAxl().catch((err) => {
        this.events.emit({
          type: "agent.error",
          agentRole: "provider",
          message: `axl poll error: ${(err as Error).message}`,
          at: new Date().toISOString(),
        });
        this._scheduleAxlPoll();
      });
    }, this._config.axlPollIntervalMs ?? DEFAULT_PROVIDER_AXL_POLL_INTERVAL_MS);
  }

  private async _pollAxl(): Promise<void> {
    if (!this._running || !this._negotiator) return;
    const got = await this._negotiator.pollOnce();
    if (got) {
      const msg = got.message;
      // Build a structured receive event. We deserialize PROPOSE/COUNTER
      // /ACCEPT payloads opportunistically so the UI can render the
      // budget the counterpart is committing to without re-parsing the
      // raw envelope. Failures here are non-fatal — emit a bare event
      // and let downstream handlers surface the actual error.
      const verb: "PROPOSE" | "COUNTER" | "ACCEPT" | "REJECT" =
        msg.type === "PROPOSE"
          ? "PROPOSE"
          : msg.type === "COUNTER"
            ? "COUNTER"
            : msg.type === "ACCEPT"
              ? "ACCEPT"
              : "REJECT";
      let parsedAmount: bigint | undefined;
      let parsedToken: Address | undefined;
      let parsedReason: string | undefined;
      try {
        if (msg.type === "PROPOSE" || msg.type === "COUNTER") {
          const p = deserializeJobProposal(msg.payload.proposal);
          parsedAmount = p.amount;
          parsedToken = p.paymentToken;
          if (msg.type === "COUNTER" && msg.payload.reason) {
            parsedReason = msg.payload.reason;
          }
        } else if (msg.type === "ACCEPT") {
          const p = deserializeJobProposal(msg.payload.proposal);
          parsedAmount = p.amount;
          parsedToken = p.paymentToken;
        } else if (msg.type === "REJECT" && msg.payload.reason) {
          parsedReason = msg.payload.reason;
        }
      } catch {
        // Don't let decode failures stop the polling loop.
      }
      this.events.emit({
        type: "negotiation.receive",
        agentRole: "provider",
        verb,
        counterpart: this._runtime.address,
        ...(parsedAmount !== undefined
          ? { amount: parsedAmount.toString() }
          : {}),
        ...(parsedToken ? { paymentToken: parsedToken } : {}),
        ...(parsedReason ? { reason: parsedReason } : {}),
        at: new Date().toISOString(),
      });
      if (msg.type === "PROPOSE") {
        try {
          await this._handleProposal(
            got.fromPeerId,
            msg.payload.taskSpec,
            msg.payload.proposal,
            msg.id,
          );
        } catch (err) {
          // The PROPOSE has already been pulled off the bridge inbox by
          // `pollOnce`, so if we crash silently here the client's `recv`
          // hangs until its own deadline. Send a REJECT back instead so
          // the client gets a useful, immediate error and the operator
          // sees the underlying cause in the stream.
          const reason = (err as Error)?.message ?? "internal error";
          this.events.emit({
            type: "agent.error",
            agentRole: "provider",
            message: `proposal handling failed; sending REJECT back: ${reason}`,
            at: new Date().toISOString(),
          });
          try {
            await this._negotiator.reject({
              destPeerId: got.fromPeerId,
              replyTo: msg.id,
              reason: `provider internal error: ${reason.slice(0, 200)}`,
            });
            this.events.emit({
              type: "negotiation.send",
              agentRole: "provider",
              verb: "REJECT",
              counterpart: this._runtime.address,
              at: new Date().toISOString(),
            });
          } catch (sendErr) {
            // If even the REJECT fails (bridge down), log and let the
            // client's deadline expire — we've done what we can.
            this.events.emit({
              type: "agent.error",
              agentRole: "provider",
              message: `failed to send REJECT after proposal failure: ${(sendErr as Error)?.message ?? sendErr}`,
              at: new Date().toISOString(),
            });
          }
        }
      } else if (msg.type === "ACCEPT") {
        await this._handleClientAccept(msg.payload);
      }
      // COUNTER from the client side after our COUNTER would be unusual
      // (we limit to one counter per session) — drop silently.
    }
    this._scheduleAxlPoll();
  }

  private async _handleProposal(
    fromPeerId: string,
    taskSpec: TaskSpec,
    serializedProposal: Parameters<typeof deserializeJobProposal>[0],
    proposeId: string,
  ): Promise<void> {
    if (!this._negotiator) return;
    const proposal = deserializeJobProposal(serializedProposal);

    // Sanity: enforce taskSpec is what the proposal commits to. The
    // negotiation-level mismatch is a hard error — we refuse to act on a
    // proposal whose body doesn't match the hash the peer signed.
    try {
      assertTaskSpecMatchesProposal(taskSpec, proposal);
    } catch (err) {
      await this._negotiator.error({
        destPeerId: fromPeerId,
        replyTo: proposeId,
        code: "taskSpec-mismatch",
        message: (err as Error).message,
      });
      return;
    }

    // Policy gate: refuse proposals that have already expired. The
    // chain would reject `createJob` past `expiredAt` anyway, but
    // catching it here saves a wasted LLM round-trip and an AXL
    // ACCEPT we can't honour.
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    if (proposal.expiresAt <= nowSeconds) {
      const reason = `proposal expired (expiresAt=${proposal.expiresAt}, now=${nowSeconds})`;
      await this._negotiator.reject({
        destPeerId: fromPeerId,
        replyTo: proposeId,
        reason,
      });
      this.events.emit({
        type: "negotiation.send",
        agentRole: "provider",
        verb: "REJECT",
        counterpart: proposal.client,
        amount: proposal.amount.toString(),
        paymentToken: proposal.paymentToken,
        reason,
        at: new Date().toISOString(),
      });
      return;
    }

    // Policy gate: payment token must be in the configured allow-list.
    // Case-insensitive — addresses round-trip in mixed case across
    // viem/ethers/storage round-trips. Reject before the LLM round-trip
    // so an attacker proposing payment in a junk token isn't given the
    // chance to talk the model into accepting it.
    const policyTokens = this._config.acceptPolicy.paymentTokens.map((t) =>
      t.toLowerCase(),
    );
    if (!policyTokens.includes(proposal.paymentToken.toLowerCase())) {
      const reason = `paymentToken ${proposal.paymentToken} not in provider's accept list`;
      await this._negotiator.reject({
        destPeerId: fromPeerId,
        replyTo: proposeId,
        reason,
      });
      this.events.emit({
        type: "negotiation.send",
        agentRole: "provider",
        verb: "REJECT",
        counterpart: proposal.client,
        amount: proposal.amount.toString(),
        paymentToken: proposal.paymentToken,
        reason,
        at: new Date().toISOString(),
      });
      return;
    }

    // Concurrency gate. `_pending` covers negotiated-but-not-funded
    // jobs; `_inFlightSubmissions` covers funded-and-submitting. Cap on
    // the sum so a burst of incoming proposals can't open more chain
    // pipelines than the operator allows.
    const cap =
      this._config.acceptPolicy.maxConcurrentJobs ??
      DEFAULT_MAX_CONCURRENT_JOBS;
    if (this._pending.size + this._inFlightSubmissions >= cap) {
      const reason = `at capacity (maxConcurrentJobs=${cap})`;
      await this._negotiator.reject({
        destPeerId: fromPeerId,
        replyTo: proposeId,
        reason,
      });
      this.events.emit({
        type: "negotiation.send",
        agentRole: "provider",
        verb: "REJECT",
        counterpart: proposal.client,
        amount: proposal.amount.toString(),
        paymentToken: proposal.paymentToken,
        reason,
        at: new Date().toISOString(),
      });
      return;
    }

    const decision = await this._decideViaLLM(taskSpec, proposal);
    this.events.emit({
      type: "llm.decided",
      agentRole: "provider",
      purpose: "decide",
      modelId: this._config.llm.modelId,
      output: decision,
      at: new Date().toISOString(),
    });

    if (decision.decision === "REJECT") {
      await this._negotiator.reject({
        destPeerId: fromPeerId,
        replyTo: proposeId,
        reason: decision.reason,
      });
      this.events.emit({
        type: "negotiation.send",
        agentRole: "provider",
        verb: "REJECT",
        counterpart: proposal.client,
        amount: proposal.amount.toString(),
        paymentToken: proposal.paymentToken,
        reason: decision.reason,
        at: new Date().toISOString(),
      });
      return;
    }

    if (decision.decision === "COUNTER" && decision.counterBudget !== null) {
      const counterAmount = BigInt(
        Math.max(0, Math.floor(decision.counterBudget)),
      );
      const newProposal: JobProposal = {
        ...proposal,
        amount: counterAmount,
        nonce: generateNonce(),
      };
      // Stage `_pending` keyed by the (counter) taskSpecHash before we
      // send anything — same race-avoidance reasoning as the ACCEPT
      // path. The hash hasn't changed because we only mutate `amount` /
      // `nonce`, but we still re-key under `newProposal.taskSpecHash`
      // so the call site is symmetric with the ACCEPT branch.
      this._pending.set(newProposal.taskSpecHash, {
        taskSpec,
        taskSpecHash: newProposal.taskSpecHash,
        agreedAmount: newProposal.amount,
        client: newProposal.client,
        expiresAt: newProposal.expiresAt,
      });
      await this._negotiator.counter({
        destPeerId: fromPeerId,
        replyTo: proposeId,
        taskSpec,
        draft: { ..._draftFromProposal(newProposal) },
        reason: decision.reason,
      });
      this.events.emit({
        type: "negotiation.send",
        agentRole: "provider",
        verb: "COUNTER",
        counterpart: proposal.client,
        amount: newProposal.amount.toString(),
        paymentToken: newProposal.paymentToken,
        reason: decision.reason,
        at: new Date().toISOString(),
      });
      // Wait for the client's reply: ACCEPT or REJECT or CANCEL.
      const reply = await this._negotiator.waitForOneOf(
        ["ACCEPT", "REJECT", "CANCEL"],
        {
          timeoutMs:
            this._config.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS,
        },
      );
      if (reply.type !== "ACCEPT") {
        // Roll back the staged pending so the chain-poll doesn't
        // accidentally pick up a job we never accepted.
        this._pending.delete(newProposal.taskSpecHash);
        return;
      }
      // Verify their ACCEPT and proceed.
      await this._handleClientAccept(reply.payload);
      return;
    }

    // ACCEPT path. Record `_pending` BEFORE sending the ACCEPT so the
    // client's mirrored ACCEPT (which round-trips ms after we send our
    // own) can never arrive before we've registered the taskSpec —
    // otherwise the mirror handler logs a "unknown taskSpecHash" warn
    // and the chain-poll later can't satisfy the JobFunded match by
    // taskSpec hash.
    this._pending.set(proposal.taskSpecHash, {
      taskSpec,
      taskSpecHash: proposal.taskSpecHash,
      agreedAmount: proposal.amount,
      client: proposal.client,
      expiresAt: proposal.expiresAt,
    });
    await this._negotiator.accept({
      destPeerId: fromPeerId,
      replyTo: proposeId,
      proposal,
    });
    this.events.emit({
      type: "negotiation.send",
      agentRole: "provider",
      verb: "ACCEPT",
      counterpart: proposal.client,
      amount: proposal.amount.toString(),
      paymentToken: proposal.paymentToken,
      at: new Date().toISOString(),
    });
  }

  private async _handleClientAccept(payload: AcceptPayload): Promise<void> {
    if (!this._negotiator) return;
    const proposal = deserializeJobProposal(payload.proposal);
    // Verifying the signature against `proposal.client` is what we want
    // for the client's mirrored ACCEPT. `verifyAccept` throws on mismatch.
    try {
      await this._negotiator.verifyAccept(payload, proposal.client, proposal);
    } catch (err) {
      this.events.emit({
        type: "agent.error",
        agentRole: "provider",
        message: `client ACCEPT verification failed: ${(err as Error).message}`,
        at: new Date().toISOString(),
      });
      return;
    }
    // Already pending under `taskSpecHash` from our own ACCEPT step;
    // verifying the mirror is a defence-in-depth check that the client
    // signed the same proposal we did. If the mirror arrives without a
    // matching `_pending` entry it means we never sent our own ACCEPT
    // for this proposal — log it and drop. The chain-poll side cannot
    // serve the job without the original TaskSpec body.
    if (!this._pending.has(proposal.taskSpecHash)) {
      this.events.emit({
        type: "log",
        agentRole: "provider",
        level: "warn",
        message: `received ACCEPT mirror for unknown taskSpecHash ${proposal.taskSpecHash}; ignoring`,
        at: new Date().toISOString(),
      });
    }
  }

  // ---------- Chain loop ----------

  private _scheduleChainPoll(): void {
    if (!this._running) return;
    this._chainTimer = setTimeout(() => {
      this._pollChain().catch((err) => {
        this.events.emit({
          type: "agent.error",
          agentRole: "provider",
          message: `chain poll error: ${(err as Error).message}`,
          at: new Date().toISOString(),
        });
        this._scheduleChainPoll();
      });
    }, this._config.chainPollIntervalMs ?? DEFAULT_CHAIN_POLL_INTERVAL_MS);
  }

  private async _pollChain(): Promise<void> {
    if (!this._running || !this._orch) return;
    const r = this._runtime;
    const head = await r.publicClient.getBlockNumber();
    const fromBlock = this._lastBlock + 1n;
    const toBlock = head;
    if (fromBlock <= toBlock) {
      const logs = await getLogsPaginated(r.publicClient, {
        address: r.deployment.galileo.agenticCommerce,
        event: JOB_FUNDED_EVENT,
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        await this._handleFundedLog(log).catch((err) => {
          this.events.emit({
            type: "agent.error",
            agentRole: "provider",
            message: `funded handler error: ${(err as Error).message}`,
            at: new Date().toISOString(),
          });
        });
      }
      this._lastBlock = toBlock;
    }
    this._scheduleChainPoll();
  }

  private async _handleFundedLog(log: Log): Promise<void> {
    if (!this._orch) return;
    let decoded: ReturnType<typeof decodeEventLog>;
    try {
      decoded = decodeEventLog({
        abi: [JOB_FUNDED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      return;
    }
    if (decoded.eventName !== "JobFunded") return;
    const args = decoded.args as unknown as {
      jobId: bigint;
      funder: Address;
      amount: bigint;
    };
    const jobId = args.jobId;
    const dedupKey = jobId.toString();
    if (this._seenJobs.has(dedupKey)) return;
    // Set the dedup marker BEFORE the async chain check. Otherwise a
    // second poll round can pick up the same JobFunded event and race
    // through the `getJob` call before the first iteration has marked
    // it processed, ending up with two parallel deliverable uploads on
    // the same wallet (=> "replacement fee too low" on the second
    // upload).
    this._seenJobs.add(dedupKey);

    // Viem infers the full `Job` struct (`provider: Address`,
    // `description: string`, `status: number`, …) from the `as const`
    // ABI; no manual cast needed. `description` is a Solidity `string`
    // — `decodeJobDescription` accepts the `0x`-prefixed hex form (the
    // canonical encoding the SDK uploaded) as a plain string.
    const job = await this._orch.getJob(jobId);
    if (job.provider.toLowerCase() !== this._runtime.address.toLowerCase()) {
      // Wasn't ours — clear the dedup so a future event for a different
      // provider can still fire (we only use the marker to gate our own
      // pipeline, not the global list of seen jobIds).
      this._seenJobs.delete(dedupKey);
      return;
    }
    if (job.status !== JOB_STATUS.Funded) {
      // Already submitted (or never reached Funded). Skip silently — a
      // fresh process boot replays the same `JobFunded` log range, and
      // re-submitting would just revert with `WrongStatus` on chain.
      this.events.emit({
        type: "log",
        agentRole: "provider",
        level: "info",
        message: `Skipping jobId=${jobId} — status=${job.status} (not Funded)`,
        at: new Date().toISOString(),
      });
      return;
    }

    // The client commits the negotiated `taskSpecHash` (32 bytes) into
    // `Job.description` at `createJob` time via the canonical bytes32
    // encoding. We require that hash to match a `_pending` entry — it
    // is the only on-chain field we can use to safely pair a funded
    // job with the off-chain TaskSpec we negotiated.
    //
    // We deliberately do NOT fall back to "first pending entry from
    // this client" — two concurrent negotiations from the same client
    // would otherwise pair to the wrong TaskSpec, and a malicious
    // client could even race a funded job against an unrelated
    // pending entry.
    const taskSpecHash = decodeJobDescription(job.description);
    if (!taskSpecHash) {
      this.events.emit({
        type: "log",
        agentRole: "provider",
        level: "warn",
        message: `JobFunded jobId=${jobId} has non-ACL Job.description; skipping`,
        at: new Date().toISOString(),
      });
      return;
    }
    const pending = this._pending.get(taskSpecHash);
    if (!pending) {
      this.events.emit({
        type: "log",
        agentRole: "provider",
        level: "warn",
        message: `JobFunded jobId=${jobId} matched provider but no pending TaskSpec for hash ${taskSpecHash}; skipping`,
        at: new Date().toISOString(),
      });
      return;
    }
    this._pending.delete(taskSpecHash);

    this.events.emit({
      type: "job.funded",
      agentRole: "provider",
      jobId: dedupKey,
      chainId: this._runtime.deployment.galileo.chainId,
      // Confirmed logs always carry a tx hash; the field's
      // optionality on viem's `Log` type is for pending logs.
      txHash: (log.transactionHash ?? "0x") as Hex,
      budget: args.amount.toString(),
      at: new Date().toISOString(),
    });

    this._inFlightSubmissions += 1;
    try {
      await this._produceAndSubmit(jobId, pending);
    } finally {
      this._inFlightSubmissions = Math.max(0, this._inFlightSubmissions - 1);
    }
  }

  private async _produceAndSubmit(
    jobId: bigint,
    pending: PendingJob,
  ): Promise<void> {
    if (!this._orch) return;
    const r = this._runtime;

    // The taskSpec upload is shared by both pipelines: 0G Storage is
    // content-addressed (Merkle root over canonical JSON), so this
    // root matches whatever the client uploaded — `skipIfFinalized`
    // turns the second commit into a no-op once finalised. Done up
    // front so the custom `produceDeliverable` strategy sees a stable
    // taskSpecRoot.
    const taskSpecUpload = await r.storage.uploadTaskSpec(pending.taskSpec);
    this.events.emit({
      type: "storage.upload",
      agentRole: "provider",
      kind: "taskSpec",
      rootHash: taskSpecUpload.rootHash,
      ...(taskSpecUpload.txHash ? { txHash: taskSpecUpload.txHash } : {}),
      txSeq: taskSpecUpload.txSeq,
      at: new Date().toISOString(),
    });

    let deliverableRoot: Hex;
    let contentType: string;
    let submitOptParams: Hex = "0x";
    let beforeSubmit: (() => Promise<void>) | undefined;

    // Vertical / iNFT path: caller-supplied strategy. We DO NOT run
    // the LLM here — strategies that bake their own commitment (e.g.
    // `inftDeliverableCommitment`) must stay deterministic across
    // restarts. Strategies that only handle a subset of TaskSpecs may
    // return `null`/`undefined` to delegate this job to the default
    // LLM-text path.
    const customOut = this._config.produceDeliverable
      ? await this._config.produceDeliverable({
          jobId,
          taskSpec: pending.taskSpec,
          provider: r.address,
          taskSpecRoot: taskSpecUpload.rootHash,
        })
      : null;
    if (customOut) {
      const out = customOut;
      contentType = out.contentType;
      submitOptParams = out.submitOptParams ?? "0x";
      beforeSubmit = out.beforeSubmit;
      if (out.skipStorageUpload) {
        deliverableRoot = out.deliverable;
      } else {
        // The strategy returned canonical bytes but still wants the
        // SDK to upload an envelope. Wrap it in the same Deliverable
        // shape Flow-1 uses so the evaluator can resolve it
        // identically.
        const deliverable: Deliverable = {
          jobId: jobId.toString(),
          provider: r.address,
          taskSpecRoot: taskSpecUpload.rootHash,
          content: out.deliverable,
          contentType,
          createdAt: new Date().toISOString(),
        };
        const upload = await r.storage.uploadDeliverable(deliverable);
        this.events.emit({
          type: "storage.upload",
          agentRole: "provider",
          kind: "deliverable",
          rootHash: upload.rootHash,
          ...(upload.txHash ? { txHash: upload.txHash } : {}),
          txSeq: upload.txSeq,
          at: new Date().toISOString(),
        });
        deliverableRoot = upload.rootHash;
      }
    } else {
      // Default Flow-1 LLM-text path.
      this.events.emit({
        type: "llm.thinking",
        agentRole: "provider",
        purpose: "deliverable",
        modelId: this._config.llm.modelId,
        at: new Date().toISOString(),
      });
      const sourceMaterial = pending.taskSpec.extensions?.sourceMaterial;
      const sourceText =
        typeof sourceMaterial === "string"
          ? sourceMaterial
          : sourceMaterial !== undefined
            ? JSON.stringify(sourceMaterial)
            : "";
      const userPrompt = [
        `<task-spec>\n${JSON.stringify(pending.taskSpec, null, 2)}\n</task-spec>`,
        sourceText
          ? `<source-material>\n${sourceText}\n</source-material>`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const resp = await this._config.llm.chat(
        [
          {
            role: "system",
            content: this._config.persona
              ? `${this._prompts.deliverable}\n\nPersona: ${this._config.persona}`
              : this._prompts.deliverable,
          },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.4 },
      );
      const content = resp.content.trim();

      const deliverable: Deliverable = {
        jobId: jobId.toString(),
        provider: r.address,
        taskSpecRoot: taskSpecUpload.rootHash,
        content,
        contentType: "text/markdown",
        createdAt: new Date().toISOString(),
      };
      const upload = await r.storage.uploadDeliverable(deliverable);
      this.events.emit({
        type: "storage.upload",
        agentRole: "provider",
        kind: "deliverable",
        rootHash: upload.rootHash,
        ...(upload.txHash ? { txHash: upload.txHash } : {}),
        txSeq: upload.txSeq,
        at: new Date().toISOString(),
      });
      deliverableRoot = upload.rootHash;
      contentType = deliverable.contentType;
    }

    // Pre-submit hook (e.g. iNFT delivery hook needs the provider to
    // approve the hook contract on the iNFT). Run AFTER the
    // taskSpec/deliverable uploads so callers can rely on the earlier
    // events for status, but BEFORE the actual `submit(...)` so the
    // hook's `_onBeforeSubmit` sees the approved state.
    if (beforeSubmit) {
      await beforeSubmit();
    }

    const submitTx = await this._orch.submit({
      jobId,
      deliverable: deliverableRoot,
      ...(submitOptParams !== "0x" ? { optParams: submitOptParams } : {}),
    });
    this.events.emit({
      type: "tx.sent",
      agentRole: "provider",
      label: "submit",
      chainId: r.deployment.galileo.chainId,
      txHash: submitTx,
      at: new Date().toISOString(),
    });
    await waitForReceiptResilient(r.publicClient, submitTx);
    const submittedAt = new Date().toISOString();
    this.events.emit({
      type: "job.submitted",
      agentRole: "provider",
      jobId: jobId.toString(),
      chainId: r.deployment.galileo.chainId,
      txHash: submitTx,
      deliverableRoot,
      contentType,
      at: submittedAt,
    });
    this.events.emit({
      type: "job.delivered.provider-side",
      agentRole: "provider",
      jobId: jobId.toString(),
      chainId: r.deployment.galileo.chainId,
      txHash: submitTx,
      deliverableRoot,
      contentType,
      taskSpecHash: taskSpecUpload.rootHash,
      at: submittedAt,
    });
  }

  // ---------- TTL sweep ----------

  /**
   * Drop `_pending` entries whose `expiresAt + grace` has passed. Run
   * by the `_pendingSweepTimer` interval. Without this an accepted
   * proposal whose JobFunded never lands (client crashed, ran out of
   * gas, switched to a different provider) would sit in the Map for
   * the lifetime of the process.
   */
  private _sweepExpiredPending(): void {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    for (const [hash, entry] of this._pending.entries()) {
      if (nowSeconds > entry.expiresAt + PENDING_TTL_GRACE_SECONDS) {
        this._pending.delete(hash);
        this.events.emit({
          type: "log",
          agentRole: "provider",
          level: "info",
          message: `dropped expired pending taskSpecHash=${hash} (expiresAt=${entry.expiresAt})`,
          at: new Date().toISOString(),
        });
      }
    }
  }

  // ---------- LLM ----------

  private async _decideViaLLM(
    taskSpec: TaskSpec,
    proposal: JobProposal,
  ): Promise<DecidePayload> {
    const policy = this._config.acceptPolicy;
    // For iNFT-sale jobs the provider's price floor is `iNftSalePrice`
    // (when configured), NOT the commission `minBudget`. Surface only
    // the lane-relevant floor to the LLM so a weak model doesn't
    // accidentally counter for the commission floor against an iNFT
    // sale (or vice versa).
    const isInftJob = taskSpec.deliveryType === INFT_DELIVERY_TYPE;
    const effectiveMinBudget =
      isInftJob && policy.iNftSalePrice !== undefined
        ? policy.iNftSalePrice
        : policy.minBudget;
    const userPrompt = [
      `<task-spec>\n${JSON.stringify(taskSpec, null, 2)}\n</task-spec>`,
      `<proposal>\nbudget: ${proposal.amount.toString()}\npaymentToken: ${proposal.paymentToken}\nexpiresAt: ${proposal.expiresAt}\n</proposal>`,
      `<policy>\nlane: ${isInftJob ? "inft-sale" : "commission"}\nminBudget: ${effectiveMinBudget.toString()}\ntaskDomains: ${policy.taskDomains.join(", ")}\n</policy>`,
    ].join("\n\n");

    const resp = await this._config.llm.chat(
      [
        {
          role: "system",
          content: this._config.persona
            ? `${this._prompts.decide}\n\nPersona: ${this._config.persona}`
            : this._prompts.decide,
        },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0, responseFormat: "json" },
    );
    return _safeParseDecide(resp.content);
  }
}

// ---------- helpers ----------

function _draftFromProposal(p: JobProposal) {
  return {
    client: p.client,
    provider: p.provider,
    evaluator: p.evaluator,
    paymentToken: p.paymentToken,
    amount: p.amount,
    hook: p.hook,
    expiresAt: p.expiresAt,
    nonce: p.nonce,
  };
}

function _safeParseDecide(content: string): DecidePayload {
  try {
    const parsed = JSON.parse(content);
    const decision = parsed.decision;
    if (
      decision === "ACCEPT" ||
      decision === "COUNTER" ||
      decision === "REJECT"
    ) {
      return {
        decision,
        counterBudget:
          typeof parsed.counterBudget === "number"
            ? parsed.counterBudget
            : null,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    }
  } catch {
    // fall through to default
  }
  return {
    decision: "REJECT",
    reason: "malformed LLM decision",
    counterBudget: null,
  };
}
