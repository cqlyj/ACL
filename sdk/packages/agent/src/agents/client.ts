import {
  ACL_METADATA_KEYS,
  type AgentProfile,
  type HookConfig,
  INFT_DELIVERY_TYPE,
  type JobProposal,
  type TaskSpec,
  encodeJobDescription,
  hashTaskSpec,
  parseAgentContext,
  parseJsonLenient,
  safeHexToText,
  safeJsonObject,
  waitForReceiptResilient,
} from "@acl/core";
import { createAgentResolver, searchAgents } from "@acl/discovery";
import { attestationRootForInftHook } from "@acl/inft";
import {
  type Negotiator,
  assertTaskSpecMatchesProposal,
  createNegotiator,
  deserializeJobProposal,
  generateNonce,
} from "@acl/negotiation";
import { createJobOrchestrator, reputationHook, watchJobLifecycle } from "@acl/settlement";
import { type Address, type Hex, zeroAddress } from "viem";
import { bootstrapAxl } from "../bootstrap/axl.js";
import { type AgentEventBus, createAgentEventBus } from "../events/bus.js";
import { type ClientPrompts, DEFAULT_CLIENT_PROMPTS, resolvePrompts } from "../llm/prompts.js";
import { type AgentRuntime, createAgentRuntime, pickRuntimeOverrides } from "../runtime.js";
import {
  type ClientAgentConfig,
  type ClientJobResult,
  DEFAULT_MAX_NEGOTIATION_ATTEMPTS,
  DEFAULT_NEGOTIATION_TIMEOUT_MS,
  DEFAULT_SETTLEMENT_POLL_INTERVAL_MS,
} from "./types.js";

/** Inputs to {@link ClientAgent.runJob}. */
export type RunJobInput = {
  /**
   * Free-form description of the work the client wants done. Surfaced
   * to the LLM as the user prompt for domain-picking, provider
   * ranking, and TaskSpec authoring. Keep it specific so the LLM can
   * derive a tight TaskSpec (e.g. "Summarize the security implications
   * of the latest LayerZero v2 message-passing changes in 600 words").
   */
  brief: string;
  /** Hard budget cap, in `paymentToken` smallest-unit. */
  maxBudget: bigint;
  /**
   * Optional explicit opening bid, in `paymentToken` smallest-unit. When
   * set, must satisfy `provider.minBudget <= openingBudget <= maxBudget`.
   * When omitted, the client opens at the **midpoint** of the legal range
   * (`(provider.minBudget + maxBudget) / 2`), which leaves room for the
   * provider to COUNTER for fair value and for the client to ACCEPT
   * within `maxBudget`. Set this equal to `maxBudget` if you want to
   * skip the negotiation phase and ACCEPT-on-first-reply.
   */
  openingBudget?: bigint;
  /** ERC-20 to fund the escrow with. Defaults to deployment.galileo.testUSDC. */
  paymentToken?: Address;
  /** Job expiry — Unix seconds. Default: now + 1 hour. */
  expiresAt?: bigint;
  /**
   * Optional source-material attachment. When set, the value (anything
   * JSON-serialisable) is embedded into TaskSpec.extensions.sourceMaterial
   * so the provider can pin it inside the deliverable prompt without
   * re-fetching from a URL the LLM might fail to navigate. Recommended
   * for testnet models which struggle with autonomous browsing.
   */
  sourceMaterial?: unknown;
  /** Optional evaluator override. Default: deployment.galileo.aclEvaluator. */
  evaluator?: Address;
  /**
   * Optional hook configuration. Default: zero address (no hook).
   *
   * Pass a {@link HookConfig} when the hook also needs per-call
   * `optParams` bytes (e.g. `reputationHook(...)` /
   * `inftDeliveryHook(...)`). The orchestrator forwards each entry's
   * bytes verbatim to the corresponding `setProvider` / `setBudget`
   * / `fund` / `submit` call.
   *
   * Plain `Address` is the back-compat shape for simple callers that
   * just want a hook contract attached with no opt bytes.
   *
   * NOTE: when `autoReputationHook` is `true` (the default for a
   * Phase-1 commission job, see below), passing `hook` here disables
   * the auto-wiring — the SDK assumes the caller already chose its
   * own hook policy.
   */
  hook?: Address | HookConfig;
  /**
   * When `true` (the default) the client agent auto-wires the
   * deployed `ReputationHook` for Phase-1 commission jobs. The hook
   * carries the picked provider's ERC-8004 agent id forward so
   * settlement (`complete` / `reject`) writes a `Feedback` entry on
   * `ACLReputationRegistry`. No-op when:
   *
   *  - `hook` is supplied (caller's hook wins),
   *  - `allowedDeliveryTypes` opts into iNFT (Phase-2 jobs use the
   *    iNFT delivery hook instead).
   *
   * Set to `false` to keep the legacy "no hook attached" behaviour.
   */
  autoReputationHook?: boolean;
  /**
   * Allowed taskDomain ids the LLM may pick from. Defaults to
   * {@link DEFAULT_ALLOWED_DOMAINS} — pass the curated set for your
   * vertical if you want the LLM to stay narrow.
   */
  allowedDomains?: ReadonlyArray<string>;
  /**
   * Allowed `taskSpec.deliveryType` values the LLM may pick from.
   * Defaults to {@link DEFAULT_ALLOWED_DELIVERY_TYPES} (`['text']`).
   * Pass `['iNFT']` for an iNFT acquisition flow, or the union of
   * both for a multi-modal client.
   */
  allowedDeliveryTypes?: ReadonlyArray<string>;
  /** Maximum search candidates to consider. Default 5. */
  maxCandidates?: number;
  /** Wait for the on-chain settlement event before returning. Default true. */
  waitForSettlement?: boolean;
  /** Settlement event poll timeout (ms). Default 10 minutes. */
  settlementTimeoutMs?: number;
  /**
   * When `true`, the client itself calls `AgenticCommerce.complete(...)`
   * after the provider submits — bypassing the `ACLEvaluator` settle
   * path. Used for the buyer-as-evaluator flow (ERC-7857 iNFT
   * acquisition) where `Job.evaluator == client.address`.
   *
   * The chain enforces `msg.sender == job.evaluator` on the receiving
   * side — the SDK does not pre-check.
   *
   * Default `false`: the agent waits for the configured evaluator to
   * settle through `ACLEvaluator.settle`.
   */
  selfComplete?: boolean;
  /**
   * Optional caller-provided `attestationRoot` (the on-chain `reason`
   * arg of `JobCompleted`) for `selfComplete: true`.
   *
   * When omitted AND `hook` is an `inftDeliveryHook(...)` `HookConfig`
   * (detected by the hook address matching
   * `deployment.galileo.inftDeliveryHook`), the SDK derives
   * `keccak256(abi.encode(nftContract, tokenId, providerAgentId))` from
   * the hook factory's known inputs.
   *
   * When omitted AND no iNFT hook is supplied, `runJob` throws — the
   * SDK refuses to fabricate a meaningless attestation.
   */
  selfCompleteAttestationRoot?: Hex;
};

/**
 * Generic taskDomain bucket the LLM is allowed to pick from when the
 * caller doesn't pass `allowedDomains`. Intentionally broad-neutral so
 * the SDK doesn't bias toward any particular vertical; verticals that
 * need a tighter (or wider) set should pass `allowedDomains` per
 * `runJob` call.
 */
export const DEFAULT_ALLOWED_DOMAINS: ReadonlyArray<string> = [
  "research",
  "writing",
  "analysis",
  "engineering",
  "general",
];

/**
 * Default `taskSpec.deliveryType` values the LLM is allowed to pick from
 * when the caller doesn't pass `allowedDeliveryTypes`. Restricted to
 * `text` — the canonical Flow-1 deliverable shape — so legacy callers
 * keep getting the same on-chain TaskSpec they did before. iNFT-aware
 * callers pass `['iNFT']` (or the union) to opt in.
 */
export const DEFAULT_ALLOWED_DELIVERY_TYPES: ReadonlyArray<string> = ["text"];

/** Default ceiling on candidates ranked by the LLM after gateway search. */
const DEFAULT_MAX_CANDIDATES = 5;

/** Default `Job.expiredAt` window for `runJob` callers (Unix seconds). */
const DEFAULT_JOB_EXPIRY_SECONDS = 60 * 60;

/** Default ceiling on `_waitForSettlement` (single client `runJob` call). */
const DEFAULT_SETTLE_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Client agent. Drives the full ERC-8183 happy path:
 *   1. LLM picks a `taskDomain` for the brief.
 *   2. Search the gateway for providers in that domain.
 *   3. LLM ranks the candidates and picks one.
 *   4. Resolve the picked agent's ENS to recover its AXL peer id and
 *      EIP-712 wallet address.
 *   5. Negotiate over AXL (PROPOSE → optional COUNTER → ACCEPT).
 *   6. Upload the agreed TaskSpec to 0G Storage.
 *   7. createJob + setProvider + setBudget + fund.
 *   8. Wait for `JobCompleted` / `JobRejected` and return the result.
 *
 * The class is single-shot per `runJob()` call: each call is a self-
 * contained negotiation. Concurrent calls are safe because we don't
 * share negotiator state across them.
 */
export class ClientAgent {
  readonly events: AgentEventBus;
  private readonly _config: ClientAgentConfig;
  private readonly _runtime: AgentRuntime;
  private readonly _prompts: ClientPrompts;
  private _negotiator: Negotiator | null = null;
  private _peerId: string | null = null;
  private _started = false;

  constructor(config: ClientAgentConfig) {
    this._config = config;
    this._runtime = createAgentRuntime({
      account: config.account,
      ...pickRuntimeOverrides(config),
    });
    this.events = config.events ?? createAgentEventBus();
    this._prompts = resolvePrompts(DEFAULT_CLIENT_PROMPTS, config.prompts);
  }

  get address(): Address {
    return this._runtime.address;
  }

  /**
   * Read-only handle on the underlying runtime kernel — useful for
   * vertical extensions (e.g. the Flow-2 BuyerFlow) that need to
   * spin up adjacent contract bindings (`createINftClient(...)`)
   * sharing the same wallet/public clients.
   */
  get runtime(): AgentRuntime {
    return this._runtime;
  }

  /**
   * AXL peer id this client advertised after `start()`. Read-only; the
   * field is set by `bootstrapAxl(...)` and never reassigned. Throws
   * if `start()` has not yet completed — surfacing the misuse rather
   * than returning a stale empty string.
   */
  get peerId(): string {
    if (!this._peerId) {
      throw new Error("ClientAgent: peerId is unavailable until start() completes");
    }
    return this._peerId;
  }

  /** Boot AXL connection. Must be called once before `runJob`. */
  async start(): Promise<void> {
    if (this._started) return;
    const axl = await bootstrapAxl({ apiUrl: this._config.axlApiUrl });
    this._peerId = axl.peerId;
    this._negotiator = createNegotiator({
      apiUrl: this._config.axlApiUrl,
      deployment: this._runtime.deployment,
      signer: this._runtime.walletClient,
      selfAddress: this._runtime.address,
    });
    this._started = true;
    this.events.emit({
      type: "agent.boot",
      agentRole: "client",
      ...(this._config.ensLabel
        ? {
            ensName: `${this._config.ensLabel}.${this._runtime.deployment.ens.parentName}`,
          }
        : {}),
      address: this._runtime.address,
      at: new Date().toISOString(),
    });
  }

  async stop(): Promise<void> {
    this._started = false;
    this.events.emit({
      type: "agent.shutdown",
      agentRole: "client",
      address: this._runtime.address,
      at: new Date().toISOString(),
    });
  }

  /**
   * Drive an end-to-end job. Returns once the evaluator has settled
   * (or `waitForSettlement` was set to false).
   */
  async runJob(input: RunJobInput): Promise<ClientJobResult> {
    if (!this._started || !this._negotiator) {
      throw new Error("ClientAgent: call start() before runJob()");
    }
    if (input.allowedDeliveryTypes !== undefined && input.allowedDeliveryTypes.length === 0) {
      throw new Error(
        "@acl/agent: runJob.allowedDeliveryTypes must contain at least one entry; pass undefined to use the SDK default",
      );
    }
    if (input.allowedDomains !== undefined && input.allowedDomains.length === 0) {
      throw new Error(
        "@acl/agent: runJob.allowedDomains must contain at least one entry; pass undefined to use the SDK default",
      );
    }
    const r = this._runtime;
    const orch = createJobOrchestrator({
      publicClient: r.publicClient,
      walletClient: r.walletClient,
      deployment: r.deployment,
      ...(r.gasFeeOverrides !== undefined ? { gasFeeOverrides: r.gasFeeOverrides } : {}),
    });

    const allowedDomains = input.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;

    // ---------- 1. LLM picks a domain ----------
    this.events.emit({
      type: "llm.thinking",
      agentRole: "client",
      purpose: "pick-domain",
      modelId: this._config.llm.modelId,
      at: new Date().toISOString(),
    });
    const domain = await this._pickDomain(input.brief, allowedDomains);
    this.events.emit({
      type: "llm.decided",
      agentRole: "client",
      purpose: "pick-domain",
      modelId: this._config.llm.modelId,
      output: domain,
      at: new Date().toISOString(),
    });

    // ---------- 2. Gateway search ----------
    this.events.emit({
      type: "discovery.search",
      agentRole: "client",
      query: { taskDomain: domain.taskDomain },
      at: new Date().toISOString(),
    });
    const candidates = await searchAgents({
      gatewayUrl: this._config.gatewayUrl,
      taskDomain: domain.taskDomain,
    });
    if (candidates.length === 0) {
      throw new Error(`@acl/agent: no providers indexed for taskDomain=${domain.taskDomain}`);
    }
    const limited = candidates.slice(0, input.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
    for (const c of limited) {
      this.events.emit({
        type: "discovery.match",
        agentRole: "client",
        ensName: `${c.ensLabel}.${r.deployment.ens.parentName}`,
        minBudget: c.minBudget.toString(),
        ...(c.taskDomains ? { taskDomains: c.taskDomains } : {}),
        at: new Date().toISOString(),
      });
    }

    // Roll up the limited candidate pool into one event so the UI can
    // render the negotiation surface (ENS list, capabilities, min budget)
    // without re-deriving it from the per-match stream.
    this.events.emit({
      type: "discovery.candidates",
      agentRole: "client",
      query: { taskDomain: domain.taskDomain },
      candidates: limited.map((c) => {
        const ctxText = safeHexToText(c.metadata[ACL_METADATA_KEYS.agentContext]);
        const ctx = parseAgentContext(ctxText);
        const taskDomainsList = c.taskDomains
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const parsedCtx = safeJsonObject(ctxText);
        return {
          ensName: `${c.ensLabel}.${r.deployment.ens.parentName}`,
          agentId: c.agentId.toString(),
          minBudget: c.minBudget.toString(),
          capabilities: ctx.capabilities,
          taskDomains: taskDomainsList,
          ...(parsedCtx !== null ? { agentContext: parsedCtx } : {}),
        };
      }),
      at: new Date().toISOString(),
    });

    // ---------- 3. LLM ranks providers ----------
    this.events.emit({
      type: "llm.thinking",
      agentRole: "client",
      purpose: "rank-providers",
      modelId: this._config.llm.modelId,
      at: new Date().toISOString(),
    });
    const rank = await this._rankProviders(input.brief, limited, r.deployment.ens.parentName);
    this.events.emit({
      type: "llm.decided",
      agentRole: "client",
      purpose: "rank-providers",
      modelId: this._config.llm.modelId,
      output: rank,
      at: new Date().toISOString(),
    });

    const allowedDeliveryTypes = input.allowedDeliveryTypes ?? DEFAULT_ALLOWED_DELIVERY_TYPES;
    const isInftJob = allowedDeliveryTypes.includes(INFT_DELIVERY_TYPE);

    // ---------- 4. LLM authors TaskSpec (provider-independent) ----------
    // The TaskSpec is sourced from the brief + domain + delivery types
    // and does not depend on which provider we ultimately negotiate
    // with, so we author it once before walking the ranked list. Each
    // attempt re-uses the same TaskSpec; only the JobProposal `amount`
    // / `provider` / `hook` differ per attempt.
    this.events.emit({
      type: "llm.thinking",
      agentRole: "client",
      purpose: "author-taskspec",
      modelId: this._config.llm.modelId,
      at: new Date().toISOString(),
    });
    const taskSpec = await this._authorTaskSpec(
      input.brief,
      domain.taskDomain,
      input.sourceMaterial,
      allowedDeliveryTypes,
    );
    this.events.emit({
      type: "llm.decided",
      agentRole: "client",
      purpose: "author-taskspec",
      modelId: this._config.llm.modelId,
      output: {
        title: taskSpec.title,
        objective: taskSpec.objective,
        deliveryType: taskSpec.deliveryType,
        taskDomain: taskSpec.taskDomain,
        requiredFormat: taskSpec.requiredFormat,
        acceptanceCriteria: taskSpec.acceptanceCriteria,
        ...(taskSpec.evaluationRubric ? { evaluationRubric: taskSpec.evaluationRubric } : {}),
        ...(taskSpec.forbiddenClaims ? { forbiddenClaims: taskSpec.forbiddenClaims } : {}),
      },
      at: new Date().toISOString(),
    });

    // ---------- 5–6. Walk ranked candidates, negotiate over AXL ----------
    const paymentToken = input.paymentToken ?? r.deployment.galileo.testUSDC;
    const evaluatorAddr = input.evaluator ?? r.deployment.galileo.aclEvaluator;
    const expiresAt =
      input.expiresAt ?? BigInt(Math.floor(Date.now() / 1_000) + DEFAULT_JOB_EXPIRY_SECONDS);
    const resolver = createAgentResolver({
      deployment: r.deployment,
      ...(this._config.sepoliaRpcUrl !== undefined
        ? { sepoliaRpcUrl: this._config.sepoliaRpcUrl }
        : {}),
      galileoRpcUrl: r.galileoRpcUrl,
    });
    const negotiationTimeoutMs =
      this._config.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
    const maxAttempts = Math.max(
      1,
      Math.min(
        this._config.maxNegotiationAttempts ?? DEFAULT_MAX_NEGOTIATION_ATTEMPTS,
        rank.rankedEnsNames.length,
      ),
    );

    let agreed: {
      provider: AgentProfile;
      proposal: JobProposal;
      taskSpec: TaskSpec;
      hookConfig: HookConfig | undefined;
      draftAmount: bigint;
    } | null = null;
    const failures: string[] = [];

    for (let attempt = 0; attempt < maxAttempts && !agreed; attempt++) {
      const ensName = rank.rankedEnsNames[attempt];
      if (!ensName) break;
      let provider: AgentProfile;
      try {
        const resolved = await resolver.resolve(ensName);
        if (!resolved) {
          throw new Error(`ENS resolution returned null for ${ensName}`);
        }
        provider = resolved.profile;
        if (!provider.axlPeerId) {
          throw new Error(`provider ${provider.ensName} has no acl.axl-peer-id metadata`);
        }
        if (!isInftJob && input.maxBudget < provider.minBudget) {
          throw new Error(
            `maxBudget (${input.maxBudget}) below provider minBudget (${provider.minBudget})`,
          );
        }
      } catch (err) {
        const reason = (err as Error).message;
        const willRetry = attempt + 1 < maxAttempts;
        // For unknown counterpart info we synthesize neutral values.
        this.events.emit({
          type: "negotiation.failed",
          agentRole: "client",
          attempt,
          maxAttempts,
          counterpartEnsName: ensName,
          counterpart: zeroAddress,
          reason,
          willRetry,
          at: new Date().toISOString(),
        });
        failures.push(`${ensName}: ${reason}`);
        continue;
      }
      this.events.emit({
        type: "negotiation.attempt",
        agentRole: "client",
        attempt,
        maxAttempts,
        counterpartEnsName: provider.ensName,
        counterpart: provider.agentAddress,
        at: new Date().toISOString(),
      });
      try {
        const result = await this._negotiateOnce({
          provider,
          taskSpec,
          input,
          paymentToken,
          evaluatorAddr,
          expiresAt,
          isInftJob,
          negotiationTimeoutMs,
        });
        agreed = result;
      } catch (err) {
        const reason = (err as Error).message;
        const willRetry = attempt + 1 < maxAttempts;
        this.events.emit({
          type: "negotiation.failed",
          agentRole: "client",
          attempt,
          maxAttempts,
          counterpartEnsName: provider.ensName,
          counterpart: provider.agentAddress,
          reason,
          willRetry,
          at: new Date().toISOString(),
        });
        failures.push(`${provider.ensName}: ${reason}`);
      }
    }

    if (!agreed) {
      throw new Error(
        `@acl/agent: negotiation failed after ${maxAttempts} attempt(s): ${failures.join(" | ")}`,
      );
    }
    const provider = agreed.provider;
    const agreedProposal: JobProposal = agreed.proposal;
    const agreedTaskSpec: TaskSpec = agreed.taskSpec;
    const hookConfig = agreed.hookConfig;

    // ---------- 7. Upload TaskSpec ----------
    const taskSpecHash = hashTaskSpec(agreedTaskSpec);
    const taskSpecUpload = await r.storage.uploadTaskSpec(agreedTaskSpec);
    this.events.emit({
      type: "storage.upload",
      agentRole: "client",
      kind: "taskSpec",
      rootHash: taskSpecUpload.rootHash,
      ...(taskSpecUpload.txHash ? { txHash: taskSpecUpload.txHash } : {}),
      txSeq: taskSpecUpload.txSeq,
      at: new Date().toISOString(),
    });

    // ---------- 8. createJob → setProvider → setBudget → fund ----------
    //
    // We pin every chain arg to `agreedProposal.*` (the dual-signed
    // EIP-712 commitment) rather than re-deriving them from the loose
    // `RunJobInput`. Otherwise a malformed `evaluator` / `expiresAt` /
    // `hook` would slip past negotiation and land on chain — fine in
    // the happy path because the negotiator already pinned them, but
    // a footgun for future call-sites that mutate the proposal across
    // the negotiate → fund boundary.
    const created = await orch.createJob({
      provider: zeroAddress,
      evaluator: agreedProposal.evaluator,
      expiredAt: agreedProposal.expiresAt,
      description: encodeJobDescription(taskSpecHash),
      hook: agreedProposal.hook,
    });
    this.events.emit({
      type: "job.created",
      agentRole: "client",
      jobId: created.jobId.toString(),
      chainId: r.deployment.galileo.chainId,
      txHash: created.txHash,
      at: new Date().toISOString(),
    });

    const setProvTx = await orch.setProvider({
      jobId: created.jobId,
      provider: provider.agentAddress,
      ...(hookConfig?.optParams?.setProvider !== undefined
        ? { optParams: hookConfig.optParams.setProvider }
        : {}),
    });
    this.events.emit({
      type: "tx.sent",
      agentRole: "client",
      label: "setProvider",
      chainId: r.deployment.galileo.chainId,
      txHash: setProvTx,
      at: new Date().toISOString(),
    });
    await waitForReceiptResilient(r.publicClient, setProvTx);
    this.events.emit({
      type: "tx.confirmed",
      agentRole: "client",
      label: "setProvider",
      chainId: r.deployment.galileo.chainId,
      txHash: setProvTx,
      at: new Date().toISOString(),
    });

    const setBudgetTx = await orch.setBudget({
      jobId: created.jobId,
      amount: agreedProposal.amount,
      ...(hookConfig?.optParams?.setBudget !== undefined
        ? { optParams: hookConfig.optParams.setBudget }
        : {}),
    });
    this.events.emit({
      type: "tx.sent",
      agentRole: "client",
      label: "setBudget",
      chainId: r.deployment.galileo.chainId,
      txHash: setBudgetTx,
      at: new Date().toISOString(),
    });
    await waitForReceiptResilient(r.publicClient, setBudgetTx);
    this.events.emit({
      type: "tx.confirmed",
      agentRole: "client",
      label: "setBudget",
      chainId: r.deployment.galileo.chainId,
      txHash: setBudgetTx,
      at: new Date().toISOString(),
    });

    const fundTx = await orch.fund({
      jobId: created.jobId,
      expectedBudget: agreedProposal.amount,
      paymentToken: agreedProposal.paymentToken,
      ...(hookConfig?.optParams?.fund !== undefined
        ? { optParams: hookConfig.optParams.fund }
        : {}),
    });
    this.events.emit({
      type: "job.funded",
      agentRole: "client",
      jobId: created.jobId.toString(),
      chainId: r.deployment.galileo.chainId,
      txHash: fundTx,
      budget: agreedProposal.amount.toString(),
      at: new Date().toISOString(),
    });
    await waitForReceiptResilient(r.publicClient, fundTx);

    // ---------- 9. (Optional) wait for evaluator settlement ----------
    if (input.waitForSettlement === false) {
      return {
        jobId: created.jobId,
        approved: false,
        txHashes: {
          createJob: created.txHash,
          setProvider: setProvTx,
          fund: fundTx,
        },
        taskSpecRoot: taskSpecUpload.rootHash,
      };
    }

    // ---------- 9a. (Optional) buyer-as-evaluator self-complete ----------
    //
    // When the caller opts into `selfComplete`, the agent waits for the
    // provider's `submit(...)`, then issues `AgenticCommerce.complete`
    // itself. This is the canonical Flow-2 (iNFT acquisition) path: the
    // job's `evaluator == client.address`, and the on-chain reason is a
    // commitment over the delivered iNFT pointer. We don't run the 0G
    // Compute attestation pipeline here — there's nothing to evaluate
    // beyond hook acceptance.
    let selfCompleteSettleTx: Hex | undefined;
    let selfCompleteAttestationRoot: Hex | undefined;
    if (input.selfComplete) {
      const submitted = await this._waitForSubmit(
        created.jobId,
        input.settlementTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      );
      const attestationRoot = this._resolveSelfCompleteRoot({
        ...(input.selfCompleteAttestationRoot !== undefined
          ? { explicit: input.selfCompleteAttestationRoot }
          : {}),
        hookConfig,
      });
      selfCompleteAttestationRoot = attestationRoot;
      selfCompleteSettleTx = await orch.complete({
        jobId: created.jobId,
        attestationRoot,
        ...(hookConfig?.optParams?.complete !== undefined
          ? { optParams: hookConfig.optParams.complete }
          : {}),
      });
      await waitForReceiptResilient(r.publicClient, selfCompleteSettleTx);
      this.events.emit({
        type: "job.settled.client-side",
        agentRole: "client",
        jobId: created.jobId.toString(),
        chainId: r.deployment.galileo.chainId,
        finalState: "completed",
        approved: true,
        attestationRoot,
        txHash: selfCompleteSettleTx,
        deliverableRoot: submitted.deliverableRoot,
        providerProfile: provider,
        capabilities: provider.agentContext?.capabilities ?? [],
        brief: input.brief,
        runJobInput: input,
        selfComplete: true,
        taskSpec: agreedTaskSpec,
        getAttestation: async () => null,
        getScoreNormalized: async () => null,
        at: new Date().toISOString(),
      });
      return {
        jobId: created.jobId,
        approved: true,
        txHashes: {
          createJob: created.txHash,
          setProvider: setProvTx,
          fund: fundTx,
          settle: selfCompleteSettleTx,
        },
        attestationRoot,
        taskSpecRoot: taskSpecUpload.rootHash,
        deliverableRoot: submitted.deliverableRoot,
      };
    }

    const settle = await this._waitForSettlement(
      orch,
      created.jobId,
      input.settlementTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    );

    // Lazy-load the on-chain attestation bundle from 0G Storage on
    // demand. Callers that only care about the on-chain receipt skip
    // the network round-trip entirely.
    const storage = r.storage;
    const attestationRoot = settle.attestationRoot;
    this.events.emit({
      type: "job.settled.client-side",
      agentRole: "client",
      jobId: created.jobId.toString(),
      chainId: r.deployment.galileo.chainId,
      finalState: settle.approved ? "completed" : "rejected",
      approved: settle.approved,
      attestationRoot,
      txHash: settle.txHash,
      ...(settle.deliverableRoot ? { deliverableRoot: settle.deliverableRoot } : {}),
      providerProfile: provider,
      capabilities: provider.agentContext?.capabilities ?? [],
      brief: input.brief,
      runJobInput: input,
      selfComplete: false,
      taskSpec: agreedTaskSpec,
      getAttestation: async () => {
        if (!storage) return null;
        try {
          return await storage.downloadAttestationBundle(attestationRoot);
        } catch (err) {
          // Storage SDK doesn't expose a structured 404 vs transient
          // error surface (every error gets wrapped as "@acl/storage
          // downloadBytes: …" with no class info). Preserve the
          // existing `null` return for back-compat ("UI just renders
          // 'no attestation yet'") while emitting an error event so
          // observers can distinguish "still propagating" from "the
          // gateway is unreachable".
          this._emitFetchError("getAttestation", attestationRoot, err);
          return null;
        }
      },
      getScoreNormalized: async () => {
        if (!storage) return null;
        try {
          const bundle = await storage.downloadAttestationBundle(attestationRoot);
          return bundle?.normalizedVerdict?.score ?? null;
        } catch (err) {
          this._emitFetchError("getScoreNormalized", attestationRoot, err);
          return null;
        }
      },
      at: new Date().toISOString(),
    });

    return {
      jobId: created.jobId,
      approved: settle.approved,
      txHashes: {
        createJob: created.txHash,
        setProvider: setProvTx,
        fund: fundTx,
        settle: settle.txHash,
      },
      attestationRoot: settle.attestationRoot,
      taskSpecRoot: taskSpecUpload.rootHash,
      ...(settle.deliverableRoot ? { deliverableRoot: settle.deliverableRoot } : {}),
    };
  }

  // ---------- LLM steps ----------

  private async _pickDomain(
    brief: string,
    allowed: ReadonlyArray<string>,
  ): Promise<{ taskDomain: string; reason: string }> {
    const userPrompt = [
      `<brief>\n${brief}\n</brief>`,
      `<allowed-domains>\n${allowed.join("\n")}\n</allowed-domains>`,
    ].join("\n\n");
    const resp = await this._config.llm.chat(
      [
        {
          role: "system",
          content: this._systemPrompt(this._prompts.pickDomain),
        },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0, responseFormat: "json" },
    );
    const parsed = parseJsonLenient(resp.content) as {
      taskDomain?: string;
      reason?: string;
    } | null;
    const fallback = allowed[0] ?? "general";
    const td =
      parsed?.taskDomain && allowed.includes(parsed.taskDomain) ? parsed.taskDomain : fallback;
    return { taskDomain: td, reason: parsed?.reason ?? "" };
  }

  private async _rankProviders(
    brief: string,
    candidates: Array<{
      ensLabel: string;
      taskDomains: string;
      minBudget: bigint;
    }>,
    parentName: string,
  ): Promise<{ rankedEnsNames: string[]; rationale: string }> {
    if (candidates.length === 0) {
      throw new Error("@acl/agent: _rankProviders called with empty candidate list");
    }
    const summary = candidates
      .map(
        (c) =>
          `- ensName: ${c.ensLabel}.${parentName}\n  taskDomains: ${c.taskDomains}\n  minBudget: ${c.minBudget}`,
      )
      .join("\n");
    const userPrompt = [
      `<brief>\n${brief}\n</brief>`,
      `<candidates>\n${summary}\n</candidates>`,
    ].join("\n\n");
    const resp = await this._config.llm.chat(
      [
        {
          role: "system",
          content: this._systemPrompt(this._prompts.rankProviders),
        },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0, responseFormat: "json" },
    );
    const parsed = parseJsonLenient(resp.content) as {
      ranked?: unknown;
      pickedEnsName?: unknown;
      rationale?: unknown;
    } | null;
    const allEnsNames = candidates.map((c) => `${c.ensLabel}.${parentName}`);
    // The LLM is allowed to return either the new `ranked: string[]`
    // shape or the legacy `pickedEnsName: string` (single pick) shape;
    // we accept both so a caller-overridden prompt can opt out of the
    // ordered-list contract without breaking the SDK. Anything we
    // can't validate falls back to the gateway's own ordering.
    const fromArray =
      Array.isArray(parsed?.ranked) &&
      parsed.ranked.every((s: unknown): s is string => typeof s === "string")
        ? (parsed.ranked as string[])
        : null;
    const fromSingle =
      typeof parsed?.pickedEnsName === "string" ? [parsed.pickedEnsName as string] : null;
    const llmOrder = fromArray ?? fromSingle ?? [];
    // Keep only valid ENS names, in the LLM's order, deduped, then
    // append any candidate the LLM omitted (in gateway order). This
    // gives every discovered provider a fair fallback slot even when
    // the model truncates its answer.
    const seen = new Set<string>();
    const orderedKnown = llmOrder.filter((ens) => {
      const ok = allEnsNames.includes(ens) && !seen.has(ens);
      if (ok) seen.add(ens);
      return ok;
    });
    for (const ens of allEnsNames) {
      if (!seen.has(ens)) orderedKnown.push(ens);
    }
    return {
      rankedEnsNames: orderedKnown,
      rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "",
    };
  }

  private async _authorTaskSpec(
    brief: string,
    taskDomain: string,
    sourceMaterial: unknown,
    allowedDeliveryTypes: ReadonlyArray<string>,
  ): Promise<TaskSpec> {
    const userPrompt = [
      `<brief>\n${brief}\n</brief>`,
      `<allowed-delivery-types>\n${allowedDeliveryTypes.join("\n")}\n</allowed-delivery-types>`,
      sourceMaterial !== undefined
        ? `<source-material>\n${typeof sourceMaterial === "string" ? sourceMaterial : JSON.stringify(sourceMaterial)}\n</source-material>`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const resp = await this._config.llm.chat(
      [
        {
          role: "system",
          content: this._systemPrompt(this._prompts.authorTaskSpec),
        },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.1, responseFormat: "json" },
    );
    const parsed = parseJsonLenient(resp.content) as {
      title?: string;
      objective?: string;
      acceptanceCriteria?: string[];
      requiredFormat?: string;
      deliveryType?: string;
      forbiddenClaims?: unknown;
      evaluationRubric?: unknown;
    } | null;
    if (
      !parsed ||
      typeof parsed.title !== "string" ||
      typeof parsed.objective !== "string" ||
      !Array.isArray(parsed.acceptanceCriteria) ||
      typeof parsed.requiredFormat !== "string"
    ) {
      throw new Error("@acl/agent: LLM returned malformed TaskSpec body");
    }
    // `allowedDeliveryTypes` is guaranteed `length >= 1` by `runJob`'s
    // entry-point validation, so `[0]` is always defined.
    const fallbackDeliveryType = allowedDeliveryTypes[0] as string;
    const deliveryType =
      typeof parsed.deliveryType === "string" && allowedDeliveryTypes.includes(parsed.deliveryType)
        ? parsed.deliveryType
        : fallbackDeliveryType;
    const forbiddenClaims = Array.isArray(parsed.forbiddenClaims)
      ? parsed.forbiddenClaims.filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        )
      : [];
    const evaluationRubric =
      typeof parsed.evaluationRubric === "string" && parsed.evaluationRubric.trim().length > 0
        ? parsed.evaluationRubric
        : undefined;
    return {
      title: parsed.title,
      objective: parsed.objective,
      acceptanceCriteria: parsed.acceptanceCriteria.filter(
        (s): s is string => typeof s === "string",
      ),
      requiredFormat: parsed.requiredFormat,
      deliveryType,
      taskDomain,
      createdAt: new Date().toISOString(),
      ...(forbiddenClaims.length > 0 ? { forbiddenClaims } : {}),
      ...(evaluationRubric !== undefined ? { evaluationRubric } : {}),
      ...(sourceMaterial !== undefined ? { extensions: { sourceMaterial } } : {}),
    };
  }

  /**
   * Run a single PROPOSE → (ACCEPT | COUNTER → ACCEPT/REJECT) round
   * with `provider`. Resolves with the agreed proposal + TaskSpec when
   * the round terminates in a dual-signed ACCEPT; throws on REJECT,
   * AXL timeout, malformed counter, or signature-verification failure
   * so the caller can decide whether to fall back to the next-ranked
   * provider.
   */
  private async _negotiateOnce(args: {
    provider: AgentProfile;
    taskSpec: TaskSpec;
    input: RunJobInput;
    paymentToken: Address;
    evaluatorAddr: Address;
    expiresAt: bigint;
    isInftJob: boolean;
    negotiationTimeoutMs: number;
  }): Promise<{
    provider: AgentProfile;
    proposal: JobProposal;
    taskSpec: TaskSpec;
    hookConfig: HookConfig | undefined;
    draftAmount: bigint;
  }> {
    if (!this._negotiator) {
      throw new Error("ClientAgent: negotiator not initialised");
    }
    const { provider, taskSpec, input, paymentToken, evaluatorAddr, expiresAt, isInftJob } = args;
    const r = this._runtime;
    const axlPeerId = provider.axlPeerId;
    if (!axlPeerId) {
      // Defensive — runJob already gated this, but the helper stays
      // self-contained so future call-sites don't have to repeat the
      // check.
      throw new Error(`provider ${provider.ensName} has no acl.axl-peer-id metadata`);
    }
    // For iNFT-sale jobs the commission floor is irrelevant — the
    // buyer's `maxBudget` IS the offer (typically the seller's
    // `acl.cap.inft-sale.min-price`). For Flow-1 commission jobs we
    // keep the midpoint heuristic against `provider.minBudget`.
    const draftAmount = isInftJob
      ? input.maxBudget
      : pickOpeningBudget({
          maxBudget: input.maxBudget,
          providerMinBudget: provider.minBudget,
          ...(input.openingBudget !== undefined ? { openingBudget: input.openingBudget } : {}),
        });
    // Normalise the caller's `hook?: Address | HookConfig` per attempt
    // — the hook is parameterised by the picked provider's `agentId`
    // so we can't hoist it above the loop.
    let hookConfig: HookConfig | undefined =
      input.hook === undefined
        ? undefined
        : typeof input.hook === "string"
          ? { address: input.hook }
          : input.hook;
    if (hookConfig === undefined && !isInftJob && input.autoReputationHook !== false) {
      hookConfig = reputationHook({
        deployment: r.deployment,
        providerAgentId: provider.agentId,
      });
    }
    const draft = {
      client: r.address,
      provider: provider.agentAddress,
      evaluator: evaluatorAddr,
      paymentToken,
      amount: draftAmount,
      hook: hookConfig?.address ?? zeroAddress,
      expiresAt,
      nonce: generateNonce(),
    };

    const { envelope: proposeEnv, proposal: localProposal } = await this._negotiator.propose({
      destPeerId: axlPeerId,
      taskSpec,
      draft,
    });
    this.events.emit({
      type: "negotiation.send",
      agentRole: "client",
      verb: "PROPOSE",
      counterpart: provider.agentAddress,
      amount: draftAmount.toString(),
      paymentToken,
      at: new Date().toISOString(),
    });

    const reply = await this._negotiator.waitForOneOf(["ACCEPT", "COUNTER", "REJECT"], {
      timeoutMs: args.negotiationTimeoutMs,
      replyToId: proposeEnv.id,
    });

    if (reply.type === "REJECT") {
      this.events.emit({
        type: "negotiation.receive",
        agentRole: "client",
        verb: "REJECT",
        counterpart: provider.agentAddress,
        ...(reply.payload.reason ? { reason: reply.payload.reason } : {}),
        at: new Date().toISOString(),
      });
      throw new Error(`provider rejected proposal: ${reply.payload.reason ?? "no reason"}`);
    }

    if (reply.type === "COUNTER") {
      const theirProposal = deserializeJobProposal(reply.payload.proposal);
      // Bind the body to the EIP-712 hash before signing on ACCEPT.
      // Without this check a malicious provider could COUNTER with a
      // taskSpec body that hashes differently than `proposal.taskSpecHash`,
      // breaking the off-chain dual-signed commitment vs the on-chain
      // `Job.description` (which the SDK derives from the body).
      try {
        assertTaskSpecMatchesProposal(reply.payload.taskSpec, theirProposal);
      } catch (err) {
        await this._negotiator.error({
          destPeerId: axlPeerId,
          replyTo: reply.id,
          code: "taskSpec-mismatch",
          message: (err as Error).message,
        });
        throw new Error(`provider COUNTER had taskSpec/hash mismatch: ${(err as Error).message}`);
      }
      this.events.emit({
        type: "negotiation.receive",
        agentRole: "client",
        verb: "COUNTER",
        counterpart: provider.agentAddress,
        amount: theirProposal.amount.toString(),
        paymentToken,
        ...(reply.payload.reason ? { reason: reply.payload.reason } : {}),
        at: new Date().toISOString(),
      });
      this.events.emit({
        type: "llm.thinking",
        agentRole: "client",
        purpose: "evaluate-counter",
        modelId: this._config.llm.modelId,
        at: new Date().toISOString(),
      });
      const counterDecision = await this._reactToCounter({
        brief: input.brief,
        originalAmount: draftAmount,
        counterAmount: theirProposal.amount,
        maxBudget: input.maxBudget,
        providerReason: reply.payload.reason ?? "",
      });
      this.events.emit({
        type: "llm.decided",
        agentRole: "client",
        purpose: "evaluate-counter",
        modelId: this._config.llm.modelId,
        output: counterDecision,
        at: new Date().toISOString(),
      });
      if (counterDecision.decision !== "ACCEPT" || theirProposal.amount > input.maxBudget) {
        await this._negotiator.reject({
          destPeerId: axlPeerId,
          replyTo: reply.id,
          reason: counterDecision.reason,
        });
        this.events.emit({
          type: "negotiation.send",
          agentRole: "client",
          verb: "REJECT",
          counterpart: provider.agentAddress,
          reason: counterDecision.reason,
          at: new Date().toISOString(),
        });
        throw new Error(`rejected counter (${counterDecision.reason})`);
      }
      const agreedTaskSpec = reply.payload.taskSpec;
      await this._negotiator.accept({
        destPeerId: axlPeerId,
        replyTo: reply.id,
        proposal: theirProposal,
      });
      this.events.emit({
        type: "negotiation.send",
        agentRole: "client",
        verb: "ACCEPT",
        counterpart: provider.agentAddress,
        amount: theirProposal.amount.toString(),
        paymentToken,
        at: new Date().toISOString(),
      });
      return {
        provider,
        proposal: theirProposal,
        taskSpec: agreedTaskSpec,
        hookConfig,
        draftAmount,
      };
    }

    // reply.type === 'ACCEPT' — provider signed our original proposal.
    try {
      await this._negotiator.verifyAccept(reply.payload, provider.agentAddress, localProposal);
    } catch (err) {
      throw new Error(`provider ACCEPT failed verification: ${(err as Error).message}`);
    }
    const agreedProposal = deserializeJobProposal(reply.payload.proposal);
    await this._negotiator.accept({
      destPeerId: axlPeerId,
      replyTo: reply.id,
      proposal: agreedProposal,
    });
    this.events.emit({
      type: "negotiation.receive",
      agentRole: "client",
      verb: "ACCEPT",
      counterpart: provider.agentAddress,
      amount: agreedProposal.amount.toString(),
      paymentToken,
      at: new Date().toISOString(),
    });
    this.events.emit({
      type: "negotiation.send",
      agentRole: "client",
      verb: "ACCEPT",
      counterpart: provider.agentAddress,
      amount: agreedProposal.amount.toString(),
      paymentToken,
      at: new Date().toISOString(),
    });
    return {
      provider,
      proposal: agreedProposal,
      taskSpec,
      hookConfig,
      draftAmount,
    };
  }

  private async _reactToCounter(args: {
    brief: string;
    originalAmount: bigint;
    counterAmount: bigint;
    maxBudget: bigint;
    providerReason: string;
  }): Promise<{ decision: "ACCEPT" | "REJECT"; reason: string }> {
    const userPrompt = [
      `<brief>\n${args.brief}\n</brief>`,
      `<original-amount>${args.originalAmount.toString()}</original-amount>`,
      `<counter-amount>${args.counterAmount.toString()}</counter-amount>`,
      `<max-budget>${args.maxBudget.toString()}</max-budget>`,
      `<provider-reason>\n${args.providerReason}\n</provider-reason>`,
    ].join("\n\n");
    const resp = await this._config.llm.chat(
      [
        {
          role: "system",
          content: this._systemPrompt(this._prompts.negotiateResponse),
        },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0, responseFormat: "json" },
    );
    const parsed = parseJsonLenient(resp.content) as {
      decision?: string;
      reason?: string;
    } | null;
    const decision = parsed?.decision === "ACCEPT" ? "ACCEPT" : "REJECT";
    return { decision, reason: parsed?.reason ?? "" };
  }

  /**
   * Surface lazy-fetch failures (`getAttestation`, `getScoreNormalized`)
   * as `agent.error` events so observers can tell "still propagating"
   * from "the gateway is unreachable". The underlying call still
   * returns `null` for back-compat.
   */
  private _emitFetchError(
    op: "getAttestation" | "getScoreNormalized",
    rootHash: Hex,
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    this.events.emit({
      type: "agent.error",
      agentRole: "client",
      message: `${op} failed for root ${rootHash}: ${message}`,
      at: new Date().toISOString(),
    });
  }

  private _systemPrompt(base: string): string {
    return this._config.persona ? `${base}\n\nPersona: ${this._config.persona}` : base;
  }

  // ---------- chain helpers ----------

  private async _waitForSettlement(
    _orch: ReturnType<typeof createJobOrchestrator>,
    jobId: bigint,
    timeoutMs: number,
  ): Promise<{
    approved: boolean;
    txHash: Hex;
    attestationRoot: Hex;
    deliverableRoot?: Hex;
  }> {
    const r = this._runtime;
    let deliverableRoot: Hex | undefined;
    // Poll only the three events we need (JobSubmitted to capture the
    // deliverable root, plus the two terminal events) — the lifecycle
    // watcher's default polls all eight, which would 2.6×–4× our
    // `eth_getLogs` traffic on a public RPC for no benefit here.
    for await (const ev of watchJobLifecycle(jobId, {
      publicClient: r.publicClient,
      deployment: r.deployment,
      pollIntervalMs: this._pollIntervalMs(),
      events: ["JobSubmitted", "JobCompleted", "JobRejected"],
      timeoutMs,
    })) {
      if (ev.type === "JobSubmitted") {
        deliverableRoot = ev.deliverable;
        continue;
      }
      // The two remaining filtered types (`JobCompleted` /
      // `JobRejected`) both carry the attestation `reason` plus a
      // `txHash` — which is all the caller needs. The watcher
      // returns immediately after this iteration since both are
      // terminal-and-subscribed. TypeScript can't narrow on the
      // `events` filter alone so we widen here.
      if (ev.type === "JobCompleted" || ev.type === "JobRejected") {
        return {
          approved: ev.type === "JobCompleted",
          txHash: ev.txHash,
          attestationRoot: ev.reason,
          ...(deliverableRoot ? { deliverableRoot } : {}),
        };
      }
    }
    throw new Error(`@acl/agent: settlement timed out after ${timeoutMs}ms`);
  }

  /**
   * Wait for the provider's `JobSubmitted(jobId, provider, deliverable)`
   * event, polling at the cadence configured by
   * {@link ClientAgentConfig.settlementPollIntervalMs} until either
   * the event lands or the timeout fires. Used by the
   * buyer-as-evaluator (Flow-2) path so the client knows when the on-
   * chain hook escrow has accepted the iNFT and it's safe to call
   * `complete(...)`.
   */
  private async _waitForSubmit(
    jobId: bigint,
    timeoutMs: number,
  ): Promise<{ deliverableRoot: Hex; txHash: Hex }> {
    const r = this._runtime;
    for await (const ev of watchJobLifecycle(jobId, {
      publicClient: r.publicClient,
      deployment: r.deployment,
      pollIntervalMs: this._pollIntervalMs(),
      events: ["JobSubmitted"],
      timeoutMs,
    })) {
      if (ev.type === "JobSubmitted") {
        return { deliverableRoot: ev.deliverable, txHash: ev.txHash };
      }
    }
    throw new Error(`@acl/agent: JobSubmitted timed out after ${timeoutMs}ms for jobId=${jobId}`);
  }

  private _pollIntervalMs(): number {
    return this._config.settlementPollIntervalMs ?? DEFAULT_SETTLEMENT_POLL_INTERVAL_MS;
  }

  /**
   * Pick the `attestationRoot` to commit on-chain when the client
   * self-completes (Flow-2 / iNFT acquisition).
   *
   * Resolution order:
   *  1. caller-provided `explicit` → used verbatim.
   *  2. {@link attestationRootForInftHook} on the supplied `HookConfig`
   *     against this agent's deployment — when the hook is the
   *     canonical `inftDeliveryHook(...)` it returns the keccak of
   *     `abi.encode(nftContract, tokenId, providerAgentId)`, which is
   *     exactly what the hook will check in `setBudget`.
   *  3. otherwise → throw. The SDK refuses to fabricate a meaningless
   *     attestation root.
   */
  private _resolveSelfCompleteRoot(args: {
    explicit?: Hex;
    hookConfig: HookConfig | undefined;
  }): Hex {
    if (args.explicit !== undefined) return args.explicit;
    const root = attestationRootForInftHook({
      hookConfig: args.hookConfig,
      deployment: this._runtime.deployment,
    });
    if (root !== null) return root;
    throw new Error(
      "@acl/agent: selfComplete=true requires either an explicit selfCompleteAttestationRoot or a HookConfig pointing at deployment.galileo.inftDeliveryHook with setBudget optParams set",
    );
  }
}

// ---------- helpers ----------

/**
 * Pick the client's opening bid for a negotiation. When the caller passes
 * an explicit `openingBudget` it is validated to lie in
 * `[providerMinBudget, maxBudget]`. Otherwise we open at the **midpoint**
 * of that range (rounded down to keep the result a safe `bigint`), which
 * leaves room on both sides for a healthy AXL COUNTER round.
 */
export function pickOpeningBudget(args: {
  maxBudget: bigint;
  providerMinBudget: bigint;
  openingBudget?: bigint;
}): bigint {
  const { maxBudget, providerMinBudget, openingBudget } = args;
  if (maxBudget < providerMinBudget) {
    throw new Error(
      `pickOpeningBudget: maxBudget (${maxBudget}) below providerMinBudget (${providerMinBudget})`,
    );
  }
  if (openingBudget !== undefined) {
    if (openingBudget < providerMinBudget || openingBudget > maxBudget) {
      throw new Error(
        `pickOpeningBudget: openingBudget (${openingBudget}) must lie in [${providerMinBudget}, ${maxBudget}]`,
      );
    }
    return openingBudget;
  }
  return (providerMinBudget + maxBudget) / 2n;
}
