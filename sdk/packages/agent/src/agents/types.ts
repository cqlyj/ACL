import type { AccountLike, TaskSpec } from "@acl/core";
import { DEFAULT_LIFECYCLE_POLL_INTERVAL_MS } from "@acl/settlement";
import type { Address, Hex } from "viem";
import type { AgentEventBus } from "../events/bus.js";
import type { LLMBackend } from "../llm/backend.js";
import type { ClientPrompts, ProviderPrompts } from "../llm/prompts.js";
import type { AgentRuntimeOverrides } from "../runtime.js";

/**
 * Inputs shared by every Agent class. Composed by each role-specific
 * config block — keeps the surface symmetrical so a single user
 * mental-model handles all three roles.
 *
 * The `AgentRuntimeOverrides` mixin (deployment / RPC URLs / transport
 * tuning / etc.) is forwarded verbatim to {@link createAgentRuntime}
 * via {@link pickRuntimeOverrides}. The fields below are role-shared
 * but *not* runtime-kernel inputs.
 */
export type AgentBaseConfig = AgentRuntimeOverrides & {
  /** Agent's signing key. Either a private key string or a viem `Account`. */
  account: AccountLike;
  /** Shared event bus. When omitted, the agent creates its own. */
  events?: AgentEventBus;
};

/**
 * Configuration for {@link ClientAgent}.
 */
export type ClientAgentConfig = AgentBaseConfig & {
  /** LLM backend that drives discovery, negotiation, and TaskSpec authoring. */
  llm: LLMBackend;
  /** AXL bridge URL the client uses for negotiation messages. */
  axlApiUrl: string;
  /**
   * Base URL of the ACL gateway used for searching providers. Required
   * because the gateway is the indexer powering search. Single URL
   * for v1 — multi-gateway redundancy can be layered later.
   */
  gatewayUrl: string;
  /**
   * ENS sub-label this client publishes under. Optional; required only
   * when the client wants to be discoverable (rare). Most clients are
   * one-shot buyers and stay anonymous.
   */
  ensLabel?: string;
  /**
   * Free-form persona prompt. Surfaces to the LLM as the system prompt
   * suffix when authoring the TaskSpec. Default: empty.
   */
  persona?: string;
  /**
   * Overrides the AXL recv timeout (ms) the client uses while waiting
   * for the provider's PROPOSE reply (ACCEPT / COUNTER / REJECT) and
   * any subsequent COUNTER → ACCEPT / REJECT round-trip. Defaults to
   * {@link DEFAULT_NEGOTIATION_TIMEOUT_MS}; bump this when the
   * counterpart's LLM is slow (e.g. under heavy retry pressure on
   * rate-limited public endpoints).
   */
  negotiationTimeoutMs?: number;
  /**
   * Maximum number of providers the client will negotiate with before
   * giving up. The LLM ranks every discovered candidate best-first; on
   * REJECT or timeout the client falls through to the next-ranked
   * provider until either an ACCEPT lands or the attempt budget is
   * exhausted. Defaults to {@link DEFAULT_MAX_NEGOTIATION_ATTEMPTS}.
   *
   * Capped by the number of candidates returned from gateway search at
   * call time (no point trying more providers than exist). Set to `1`
   * to disable fallback (legacy behaviour).
   */
  maxNegotiationAttempts?: number;
  /**
   * Cadence (ms) at which {@link ClientAgent.runJob} polls the chain
   * for `JobSubmitted` (during deliverable wait) and `JobCompleted` /
   * `JobRejected` (during settlement wait). Defaults to
   * {@link DEFAULT_SETTLEMENT_POLL_INTERVAL_MS}. Lower it for faster
   * test suites; raise it when running against a rate-limited public
   * RPC.
   */
  settlementPollIntervalMs?: number;
  /**
   * Optional partial override for the LLM prompts the client uses at
   * each step of `runJob` (`pickDomain`, `rankProviders`,
   * `authorTaskSpec`, `negotiateResponse`). Missing entries fall back
   * to {@link DEFAULT_CLIENT_PROMPTS}. Use this when the SDK defaults
   * don't fit your vertical (e.g. a different output schema or
   * decision heuristic) without forking the SDK.
   */
  prompts?: Partial<ClientPrompts>;
};

/**
 * Default ceiling the {@link ClientAgent} will wait for a provider
 * reply during negotiation. Generous on purpose — a single LLM
 * round-trip on the public 0G Compute Router can take 30–60s under
 * load, and the SDK's built-in 408/425/429/5xx retry adds a few
 * extra seconds on top of that.
 */
export const DEFAULT_NEGOTIATION_TIMEOUT_MS = 180_000;

/**
 * Default {@link ClientAgentConfig.maxNegotiationAttempts}. Three is a
 * pragmatic ceiling: the gateway typically returns 2-5 providers per
 * `taskDomain` in v1 deployments, and most demo wallets only fund the
 * first few candidates with operating capital, so going wider rarely
 * yields a better outcome and just lengthens the failure path.
 */
export const DEFAULT_MAX_NEGOTIATION_ATTEMPTS = 3;

/**
 * Default cadence the chain-watching loops in `ClientAgent` /
 * `ProviderAgent` / `EvaluatorAgent` use when no override is supplied.
 * Sized for the public 0G testnet RPC: too low and the SDK starts
 * spamming `eth_getLogs`; too high and demos feel sluggish. Aliased
 * to {@link DEFAULT_LIFECYCLE_POLL_INTERVAL_MS} from `@acl/settlement`
 * so the standalone `watchJobLifecycle` watcher and the agent
 * runtimes share a single source of truth.
 */
export const DEFAULT_CHAIN_POLL_INTERVAL_MS =
  DEFAULT_LIFECYCLE_POLL_INTERVAL_MS;

/** Default `ClientAgent.settlementPollIntervalMs`. */
export const DEFAULT_SETTLEMENT_POLL_INTERVAL_MS =
  DEFAULT_CHAIN_POLL_INTERVAL_MS;

/**
 * Default `ProviderAgent.axlPollIntervalMs`.
 *
 * Distinct from `DEFAULT_AXL_BRIDGE_RECV_POLL_INTERVAL_MS` exported by
 * `@acl/negotiation`, which controls the lower-level AXL bridge HTTP
 * recv cadence rather than the provider's high-level inbox poll.
 */
export const DEFAULT_PROVIDER_AXL_POLL_INTERVAL_MS = 1_000;

/**
 * Default cadence the provider's pending-TaskSpec sweeper runs at.
 * Much coarser than the AXL/chain polls — it's just GC-ing entries
 * that haven't seen a `JobFunded` within the configured TTL.
 */
export const DEFAULT_PENDING_SWEEP_INTERVAL_MS = 30_000;

/**
 * Configuration for {@link ProviderAgent}.
 */
export type ProviderAgentConfig = AgentBaseConfig & {
  llm: LLMBackend;
  axlApiUrl: string;
  /** Provider's ENS name (e.g. `"researcher.acl.eth"`). */
  ensName: string;
  /**
   * Acceptance policy. The LLM consults these explicit knobs alongside
   * the (optional) free-form `persona` when deciding ACCEPT / COUNTER
   * / REJECT.
   */
  acceptPolicy: {
    /**
     * Minimum acceptable budget in `paymentTokens[0]` smallest-unit
     * for the default ("commission" / `deliveryType !== 'iNFT'`)
     * job lane.
     */
    minBudget: bigint;
    /**
     * Optional minimum sale price (smallest-unit of `paymentTokens[0]`)
     * the agent accepts for `deliveryType === 'iNFT'` jobs. The
     * provider's LLM ACCEPT/COUNTER step uses this as the budget
     * floor instead of `minBudget` when the inbound TaskSpec opts
     * into the iNFT lane. Omit when the agent doesn't advertise an
     * iNFT-sale capability.
     */
    iNftSalePrice?: bigint;
    /** Domains the agent advertises and will entertain proposals for. */
    taskDomains: string[];
    /** ERC-20s the agent accepts as payment. First entry is the primary. */
    paymentTokens: Address[];
    /** Hard cap on concurrent active jobs. Default: 1. */
    maxConcurrentJobs?: number;
  };
  /**
   * Free-form persona / strategy hints surfaced to the LLM when it
   * decides whether to accept. Optional; the explicit knobs above are
   * sufficient for most demos.
   */
  persona?: string;
  /**
   * AXL recv timeout (ms) the provider uses while waiting for the
   * client's reply to its COUNTER. Defaults to
   * {@link DEFAULT_NEGOTIATION_TIMEOUT_MS}.
   */
  negotiationTimeoutMs?: number;
  /**
   * Cadence (ms) the provider uses for AXL inbox polling. Defaults
   * to {@link DEFAULT_PROVIDER_AXL_POLL_INTERVAL_MS}. Lower it for snappier
   * negotiation in tests; raise it under heavy AXL load to spread
   * the bridge's HTTP API requests.
   */
  axlPollIntervalMs?: number;
  /**
   * Cadence (ms) the provider uses for `JobFunded` chain-log polling.
   * Defaults to {@link DEFAULT_CHAIN_POLL_INTERVAL_MS}.
   */
  chainPollIntervalMs?: number;
  /**
   * Cadence (ms) the provider uses for sweeping pending TaskSpecs
   * whose negotiation never reached `JobFunded`. Defaults to
   * {@link DEFAULT_PENDING_SWEEP_INTERVAL_MS}.
   */
  pendingSweepIntervalMs?: number;
  /**
   * Optional deliverable-production strategy. The SDK's default
   * pipeline (LLM → 0G Storage → `submit(deliverable=root)`) is the
   * Flow-1 happy path; pass a `produceDeliverable` here to override
   * for vertical flows.
   *
   * For the Flow-2 (iNFT acquisition) path the example returns
   * `{ deliverable: inftDeliverableCommitment(...), contentType:
   * 'application/vnd.acl.inft-pointer', beforeSubmit: () =>
   * approveHook(...) }`. The orchestrator submits the canonical
   * pointer commitment as the `deliverable` arg to ERC-8183
   * `submit(...)` — the iNFT delivery hook then pulls the token
   * into escrow inside `_onBeforeSubmit`.
   *
   * The strategy MUST be deterministic given the same `(taskSpec,
   * jobId)` so retries don't drift the on-chain commitment.
   */
  produceDeliverable?: ProduceDeliverableStrategy;
  /**
   * Optional partial override for the LLM prompts the provider uses
   * (`decide`, `deliverable`). Missing entries fall back to
   * {@link DEFAULT_PROVIDER_PROMPTS}.
   */
  prompts?: Partial<ProviderPrompts>;
};

/**
 * Output of {@link ProduceDeliverableStrategy}. The SDK takes the
 * `deliverable` bytes as the `submit(...)` payload, optionally calls
 * `beforeSubmit()` immediately before the on-chain write, and surfaces
 * `contentType` on the `job.delivered.provider-side` event.
 *
 * `submitOptParams` is forwarded as the `submit()` `optParams` arg.
 * Default `'0x'` keeps every existing flow working unchanged.
 */
export type ProduceDeliverableResult = {
  /** Bytes32 root passed as `submit(jobId, deliverable)`. */
  deliverable: Hex;
  /** Display content-type on the lifecycle event. e.g. `'text/markdown'`. */
  contentType: string;
  /** Pre-submit hook (e.g. ERC-721 approval). Optional. */
  beforeSubmit?: () => Promise<void>;
  /** Bytes forwarded as `submit(jobId, deliverable, optParams)`. Default `'0x'`. */
  submitOptParams?: Hex;
  /**
   * Skip the SDK's default `0G Storage` upload entirely. When `true`
   * the `deliverable` value is treated as already-canonical (e.g. an
   * iNFT pointer commitment) and `r.storage.uploadDeliverable(...)`
   * is NOT called. Default `false` for back-compat.
   */
  skipStorageUpload?: boolean;
};

/** Inputs forwarded to a custom {@link ProduceDeliverableStrategy}. */
export type ProduceDeliverableInput = {
  jobId: bigint;
  taskSpec: TaskSpec;
  /** Provider's own EOA. */
  provider: Address;
  /** Negotiated `taskSpec` root the provider already uploaded to 0G Storage. */
  taskSpecRoot: Hex;
};

/**
 * Custom deliverable-production strategy. Return `null` (or
 * `undefined`) to fall through to the SDK's default LLM-text path —
 * useful when the strategy only handles a subset of TaskSpecs (e.g.
 * `deliveryType === 'iNFT'`) and Flow-1 jobs should keep using the
 * built-in producer.
 */
export type ProduceDeliverableStrategy = (
  input: ProduceDeliverableInput,
) => Promise<ProduceDeliverableResult | null | undefined>;

/**
 * Configuration for {@link EvaluatorAgent}.
 */
export type EvaluatorAgentConfig = AgentBaseConfig & {
  /**
   * Optional 0G Compute Direct provider override. When omitted the
   * evaluator picks the first provider whose model matches
   * `modelMatch` (default: `qwen-2.5-7b-instruct`).
   */
  computeProvider?: Address;
  /** Substring or RegExp filter for picking a 0G Compute model. */
  modelMatch?: string | RegExp;
  /** Override the evaluator system prompt. */
  systemPrompt?: string;
  /**
   * From-block to start scanning `JobSubmitted` events. Defaults to
   * the most recent block at start time so a fresh evaluator only
   * processes new submissions.
   */
  fromBlock?: bigint;
  /**
   * Polling interval (ms) for new `JobSubmitted` events. Defaults to
   * {@link DEFAULT_CHAIN_POLL_INTERVAL_MS}.
   */
  pollIntervalMs?: number;
  /**
   * Override the `ACLEvaluator` contract address. Defaults to
   * `deployment.galileo.aclEvaluator`. Useful when a custom
   * `ACLEvaluator` is being run alongside the canonical deployment
   * (e.g. an integration test). The agent only filters jobs whose
   * `Job.evaluator` matches this address.
   */
  aclEvaluator?: Address;
};

/** Result of {@link ClientAgent.runJob}. */
export type ClientJobResult = {
  jobId: bigint;
  approved: boolean;
  txHashes: {
    createJob: Hex;
    setProvider: Hex;
    fund: Hex;
    settle?: Hex;
  };
  attestationRoot?: Hex;
  taskSpecRoot: Hex;
  deliverableRoot?: Hex;
};
