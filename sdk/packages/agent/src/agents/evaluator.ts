import {
  decodeJobDescription,
  hashTaskSpec,
  waitForReceiptResilient,
} from "@acl/core";
import {
  type Evaluator,
  type EvaluatorConfig,
  buildAttestationBundle,
  createEvaluator,
} from "@acl/evaluation";
import {
  JOB_STATUS,
  JOB_SUBMITTED_EVENT,
  createJobOrchestrator,
  getLogsPaginated,
} from "@acl/settlement";
import { type Address, type Hex, type Log, decodeEventLog, stringToHex } from "viem";
import { type AgentEventBus, createAgentEventBus } from "../events/bus.js";
import {
  type AgentRuntime,
  createAgentRuntime,
  pickRuntimeOverrides,
} from "../runtime.js";
import {
  DEFAULT_CHAIN_POLL_INTERVAL_MS,
  type EvaluatorAgentConfig,
} from "./types.js";

/**
 * Default evaluator agent. Boots a local in-process listener that
 * watches `AgenticCommerce` for `JobSubmitted` events whose `evaluator`
 * field equals our address, runs evaluation through `@acl/evaluation`
 * (which uses 0G Compute Direct for the TEE-attested response), and
 * settles via `ACLEvaluator.settle()` with the on-chain TEE proof.
 *
 * The agent stores the (jobId, taskSpec, deliverable, taskSpecRoot,
 * deliverableRoot) tuple ephemerally — no persistence, by design.
 * Restart-from-scratch is the v1 contract; agent state is the harness's
 * problem, not the SDK's.
 */
export class EvaluatorAgent {
  private readonly _runtime: AgentRuntime;
  private readonly _config: EvaluatorAgentConfig;
  private _evaluator: Evaluator | null = null;
  private _orchestrator: ReturnType<typeof createJobOrchestrator> | null = null;
  private _running = false;
  /**
   * Highest block number we've finished scanning for `JobSubmitted`
   * events. Initialised in `start()` from `config.fromBlock` (or the
   * current head when omitted); the `_poll` loop advances it forward
   * after every successful range read.
   */
  private _lastBlock = 0n;
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Jobs we've already settled (or deliberately skipped after a
   * status check). Persistent for the lifetime of the agent.
   */
  private readonly _processed = new Set<string>();
  /**
   * Jobs we're currently mid-evaluating. Cleared inside `finally` so
   * a transient evaluation failure can be retried by the next poll
   * round (without `_processed` permanently shadowing it).
   */
  private readonly _inFlight = new Set<string>();

  readonly events: AgentEventBus;

  constructor(config: EvaluatorAgentConfig) {
    this._config = config;
    this._runtime = createAgentRuntime({
      account: config.account,
      ...pickRuntimeOverrides(config),
    });
    this.events = config.events ?? createAgentEventBus();
  }

  /**
   * Boot the evaluator: ensure the on-chain ACLEvaluator authorises us as
   * an operator (delegated to the caller — they own the evaluator owner
   * key), provision 0G Compute funding, and start polling for events.
   */
  async start(): Promise<void> {
    if (this._running) return;
    const { _runtime: r } = this;
    const evalCfg: EvaluatorConfig = {
      privateKey:
        typeof this._config.account === "string"
          ? this._config.account
          : undefined,
      signer:
        typeof this._config.account === "string" ? undefined : r.ethersSigner,
      storage: r.storage,
      rpcUrl: r.galileoRpcUrl,
      ...(this._config.computeProvider !== undefined
        ? { providerAddress: this._config.computeProvider }
        : {}),
      ...(this._config.modelMatch !== undefined
        ? { modelMatch: this._config.modelMatch }
        : {}),
      ...(this._config.systemPrompt !== undefined
        ? { systemPrompt: this._config.systemPrompt }
        : {}),
    } as EvaluatorConfig;

    this._evaluator = await createEvaluator(evalCfg);
    await this._evaluator.ensureFunded();

    this._orchestrator = createJobOrchestrator({
      publicClient: r.publicClient,
      walletClient: r.walletClient,
      deployment: r.deployment,
      ...(this._config.aclEvaluator !== undefined
        ? { aclEvaluator: this._config.aclEvaluator }
        : {}),
      ...(r.gasFeeOverrides !== undefined
        ? { gasFeeOverrides: r.gasFeeOverrides }
        : {}),
    });

    // Fail loud if our operator key isn't authorised on `ACLEvaluator`.
    // Without this gate the listener silently boots, picks up
    // `JobSubmitted` events, runs the entire 0G-Compute evaluation
    // pipeline, and only reverts inside `settle()` with an opaque
    // `NotAuthorized()` — wasting compute spend and surfacing a
    // late-bound error to the operator. Surfacing it here points the
    // operator straight at `setEvaluatorOperator(self, true)`.
    const isAuthorised = await this._orchestrator.authorizedOperator(r.address);
    if (!isAuthorised) {
      throw new Error(
        `@acl/agent: EvaluatorAgent operator ${r.address} is not authorised on ACLEvaluator (` +
          `${this._config.aclEvaluator ?? r.deployment.galileo.aclEvaluator}). The ACLEvaluator owner ` +
          "must call `setOperator(operator, true)` (e.g. via `JobOrchestrator.setEvaluatorOperator`) " +
          "before the evaluator can settle jobs.",
      );
    }

    this._lastBlock =
      this._config.fromBlock ?? (await r.publicClient.getBlockNumber());
    this._running = true;
    this.events.emit({
      type: "agent.boot",
      agentRole: "evaluator",
      address: r.address,
      at: new Date().toISOString(),
    });
    this._scheduleNextPoll();
  }

  /** Stop the listener and release timers. */
  async stop(): Promise<void> {
    this._running = false;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this.events.emit({
      type: "agent.shutdown",
      agentRole: "evaluator",
      address: this._runtime.address,
      at: new Date().toISOString(),
    });
  }

  /** Convenience: fully expose the underlying Evaluator for advanced uses. */
  get evaluator(): Evaluator {
    if (!this._evaluator) throw new Error("EvaluatorAgent not started");
    return this._evaluator;
  }

  /** Convenience getter for the agent's own settlement-operator address. */
  get address(): Address {
    return this._runtime.address;
  }

  /**
   * Read-only handle on the underlying runtime kernel. Surfaced for
   * symmetry with `ClientAgent` / `ProviderAgent` so the factory can
   * hand back the real runtime the agent is using.
   */
  get runtime(): AgentRuntime {
    return this._runtime;
  }

  // ---------- internals ----------

  private _scheduleNextPoll(): void {
    if (!this._running) return;
    const interval =
      this._config.pollIntervalMs ?? DEFAULT_CHAIN_POLL_INTERVAL_MS;
    this._pollTimer = setTimeout(() => {
      this._poll().catch((err) => {
        this.events.emit({
          type: "agent.error",
          agentRole: "evaluator",
          message: `poll error: ${(err as Error).message}`,
          at: new Date().toISOString(),
        });
        this._scheduleNextPoll();
      });
    }, interval);
  }

  private async _poll(): Promise<void> {
    if (!this._running) return;
    const { _runtime: r } = this;
    const head = await r.publicClient.getBlockNumber();
    const fromBlock = this._lastBlock + 1n;
    const toBlock = head;
    if (fromBlock <= toBlock) {
      const logs = await getLogsPaginated(r.publicClient, {
        address: r.deployment.galileo.agenticCommerce,
        event: JOB_SUBMITTED_EVENT,
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        await this._handleLog(log).catch((err) => {
          this.events.emit({
            type: "agent.error",
            agentRole: "evaluator",
            message: `process log error: ${(err as Error).message}`,
            at: new Date().toISOString(),
          });
        });
      }
      this._lastBlock = toBlock;
    }
    this._scheduleNextPoll();
  }

  private async _handleLog(log: Log): Promise<void> {
    if (!this._orchestrator || !this._evaluator) return;
    let decoded: ReturnType<typeof decodeEventLog>;
    try {
      decoded = decodeEventLog({
        abi: [JOB_SUBMITTED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      return;
    }
    if (decoded.eventName !== "JobSubmitted") return;
    const args = decoded.args as unknown as {
      jobId: bigint;
      provider: Address;
      deliverable: Hex;
    };
    const jobId = args.jobId;
    const deliverableRoot = args.deliverable;
    const dedupKey = `${this._runtime.deployment.galileo.chainId}:${jobId.toString()}`;
    // Two-tier dedup:
    //   - `_inFlight` blocks a concurrent poll round from racing past
    //     the `getJob` await and starting a parallel evaluation. We
    //     clear this entry inside `finally` so a transient failure
    //     can be retried by the next sweep.
    //   - `_processed` marks a job that finished successfully (or
    //     deliberately skipped after a status check). Persistent so
    //     the evaluator never re-runs a job it has already settled.
    if (this._processed.has(dedupKey) || this._inFlight.has(dedupKey)) return;
    this._inFlight.add(dedupKey);
    try {
      // Only act on jobs assigned to this evaluator address that are
      // still awaiting settlement. The status guard makes the
      // evaluator idempotent across restarts and across multiple
      // evaluator instances sharing the same operator key — a fresh
      // process boots, replays the `JobSubmitted` log range, and
      // silently no-ops on jobs already in `Completed` / `Rejected`.
      // Viem infers the full `Job` struct from the `as const` ABI; no
      // manual cast needed. Status numerics:
      //   0 Open, 1 Funded, 2 Submitted, 3 Completed, 4 Rejected, 5 Expired.
      const job = await this._orchestrator.getJob(jobId);
      const aclEvaluatorAddr = (
        this._config.aclEvaluator ??
        this._runtime.deployment.galileo.aclEvaluator
      ).toLowerCase();
      if (job.evaluator.toLowerCase() !== aclEvaluatorAddr) {
        // Not ours — never re-poll this job from this instance.
        this._processed.add(dedupKey);
        return;
      }
      if (job.status !== JOB_STATUS.Submitted) {
        // Already settled (or never reached Submitted state). Mark
        // processed so we don't refetch on the next poll, and emit
        // a single trace event so the UI can show the skip.
        this._processed.add(dedupKey);
        this.events.emit({
          type: "log",
          agentRole: "evaluator",
          level: "info",
          message: `Skipping jobId=${jobId.toString()} — status=${job.status} (not Submitted)`,
          at: new Date().toISOString(),
        });
        return;
      }

      // The client commits `taskSpecHash` (the EIP-712 keccak of the
      // canonicalised TaskSpec) into `Job.description` at createJob
      // time via the canonical bytes32 encoding. We re-derive that
      // hash from the downloaded spec further below to prove the
      // bytes the provider actually delivered match the bytes both
      // parties signed. `null` here means a non-ACL description —
      // skip the hash gate.
      const onChainTaskSpecHash = decodeJobDescription(job.description);

      this.events.emit({
        type: "log",
        agentRole: "evaluator",
        level: "info",
        message: `Picked up jobId=${jobId.toString()} deliverable=${deliverableRoot.slice(0, 10)}...`,
        at: new Date().toISOString(),
      });

      const { _runtime: r, _evaluator: ev, _orchestrator: orch } = this;

      this.events.emit({
        type: "storage.download",
        agentRole: "evaluator",
        kind: "deliverable",
        rootHash: deliverableRoot,
        at: new Date().toISOString(),
      });
      const deliverable = await r.storage.downloadDeliverable(deliverableRoot);
      const taskSpecRoot = deliverable.taskSpecRoot;
      this.events.emit({
        type: "storage.download",
        agentRole: "evaluator",
        kind: "taskSpec",
        rootHash: taskSpecRoot,
        at: new Date().toISOString(),
      });
      const taskSpec = await r.storage.downloadTaskSpec(taskSpecRoot);

      // Re-derive the TaskSpec hash from the downloaded bytes and
      // assert it matches the value the client wrote into
      // `Job.description` at `createJob` time. A mismatch means the
      // spec the provider acted on is not the spec both parties
      // signed (storage tampering, swapped root, or canonicalisation
      // drift) and the job must not settle.
      const recomputed = hashTaskSpec(taskSpec).toLowerCase();
      if (onChainTaskSpecHash !== null && onChainTaskSpecHash !== recomputed) {
        this.events.emit({
          type: "log",
          agentRole: "evaluator",
          level: "error",
          message: `taskSpec hash mismatch — refusing to settle: onChain=${onChainTaskSpecHash} recomputed=${recomputed}`,
          at: new Date().toISOString(),
        });
        // Permanent skip — the bytes don't match the on-chain
        // commitment so re-evaluating won't help.
        this._processed.add(dedupKey);
        throw new Error(
          `@acl/agent: taskSpec hash mismatch for job ${jobId.toString()} — onChain=${onChainTaskSpecHash} recomputed=${recomputed}`,
        );
      }

      this.events.emit({
        type: "llm.thinking",
        agentRole: "evaluator",
        purpose: "evaluate-deliverable",
        modelId: ev.modelId,
        at: new Date().toISOString(),
      });
      const result = await ev.evaluate({
        taskSpec,
        deliverable,
        taskSpecRoot,
        deliverableRoot,
      });
      this.events.emit({
        type: "evaluator.evaluated",
        agentRole: "evaluator",
        jobId: jobId.toString(),
        modelId: result.modelId,
        approved: result.normalizedVerdict.approved,
        score: result.normalizedVerdict.score,
        teeVerified: result.responseVerification,
        at: new Date().toISOString(),
      });

      const bundle = buildAttestationBundle({
        jobId,
        commerceContract: r.deployment.galileo.agenticCommerce,
        chainId: r.deployment.galileo.chainId,
        taskSpecRoot,
        deliverableRoot,
        evaluation: result,
      });
      const upload = await ev.uploadAttestationBundle(bundle);
      this.events.emit({
        type: "storage.upload",
        agentRole: "evaluator",
        kind: "attestation",
        rootHash: upload.rootHash,
        ...(upload.txHash ? { txHash: upload.txHash } : {}),
        txSeq: upload.txSeq,
        at: new Date().toISOString(),
      });

      const settleTx = await orch.settleViaEvaluator({
        jobId,
        approved: result.normalizedVerdict.approved,
        attestationRoot: upload.rootHash,
        computeProvider: result.computeProvider,
        signedText: stringToHex(result.signedText),
        teeSignature: result.teeSignature,
      });
      this.events.emit({
        type: "tx.sent",
        agentRole: "evaluator",
        label: "settleViaEvaluator",
        chainId: r.deployment.galileo.chainId,
        txHash: settleTx,
        at: new Date().toISOString(),
      });
      await waitForReceiptResilient(r.publicClient, settleTx);
      // Settled successfully — promote the in-flight marker into
      // the persistent `_processed` set so a re-poll never replays.
      this._processed.add(dedupKey);
      const settledAt = new Date().toISOString();
      this.events.emit({
        type: "job.settled",
        agentRole: "evaluator",
        jobId: jobId.toString(),
        chainId: r.deployment.galileo.chainId,
        txHash: settleTx,
        approved: result.normalizedVerdict.approved,
        at: settledAt,
      });
      this.events.emit({
        type: "job.evaluated.evaluator-side",
        agentRole: "evaluator",
        jobId: jobId.toString(),
        chainId: r.deployment.galileo.chainId,
        txHash: settleTx,
        approved: result.normalizedVerdict.approved,
        score: result.normalizedVerdict.score,
        attestationRoot: upload.rootHash,
        at: settledAt,
      });
    } finally {
      this._inFlight.delete(dedupKey);
    }
  }
}

/**
 * Sugar factory: build + start an EvaluatorAgent in one call. Use this
 * when you want the SDK's "default evaluator" — no custom 0G Compute
 * provider, default Qwen-2.5-7b-instruct on Galileo testnet.
 *
 * When `ownerPrivateKey` is supplied the helper first ensures the
 * operator is authorised on `ACLEvaluator.setOperator` — useful for
 * fresh demo wallets that would otherwise fail on `start()` with the
 * "operator not authorised" guard. Production deployments should
 * keep the owner key offline and call `setOperator` separately.
 */
export async function createDefaultEvaluator(
  config: EvaluatorAgentConfig & { ownerPrivateKey?: Hex },
): Promise<EvaluatorAgent> {
  const { ownerPrivateKey, ...agentConfig } = config;
  const agent = new EvaluatorAgent(agentConfig);
  if (ownerPrivateKey) {
    await ensureEvaluatorOperator({
      ownerPrivateKey,
      operator: agent.address,
      deployment: agent.runtime.deployment,
      galileoRpcUrl: agent.runtime.galileoRpcUrl,
      ...(agentConfig.aclEvaluator !== undefined
        ? { aclEvaluator: agentConfig.aclEvaluator }
        : {}),
    });
  }
  await agent.start();
  return agent;
}

/**
 * Idempotently authorise `operator` on `ACLEvaluator`. Reads the
 * current `authorizedOperators(operator)` mapping first and short-
 * circuits when it's already `true` so the helper costs nothing on
 * a warm wallet.
 *
 * Surfaced as a standalone helper (not a method) because it ALWAYS
 * uses a different signing key (the evaluator-contract owner) than
 * the `EvaluatorAgent` itself (the operator), and the agent's own
 * runtime never carries the owner key.
 */
export async function ensureEvaluatorOperator(opts: {
  ownerPrivateKey: Hex;
  operator: Address;
  deployment: AgentRuntime["deployment"];
  galileoRpcUrl: string;
  aclEvaluator?: Address;
}): Promise<{ authorised: boolean; txHash?: Hex }> {
  const ownerRuntime = createAgentRuntime({
    account: opts.ownerPrivateKey,
    deployment: opts.deployment,
    galileoRpcUrl: opts.galileoRpcUrl,
  });
  const orch = createJobOrchestrator({
    publicClient: ownerRuntime.publicClient,
    walletClient: ownerRuntime.walletClient,
    deployment: opts.deployment,
    ...(opts.aclEvaluator !== undefined
      ? { aclEvaluator: opts.aclEvaluator }
      : {}),
  });
  const already = await orch.authorizedOperator(opts.operator);
  if (already) return { authorised: true };
  const txHash = await orch.setEvaluatorOperator(opts.operator, true);
  await waitForReceiptResilient(ownerRuntime.publicClient, txHash);
  return { authorised: true, txHash };
}
