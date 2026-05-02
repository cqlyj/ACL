/**
 * `watchJobLifecycle(jobId, opts)` — async-iterable polling watcher
 * over the AgenticCommerce events for a single ERC-8183 job. Yields a
 * typed union of lifecycle events (JobCreated, ProviderSet,
 * BudgetSet, JobFunded, JobSubmitted, JobCompleted, JobRejected,
 * JobExpired) as they land on chain, in the order they appear, and
 * ends when a terminal state is observed or `signal.aborted`.
 *
 * Sits on top of {@link getLogsPaginated} with a `(txHash, logIndex)`
 * dedup so a fork-replayed log doesn't yield twice. The poller is
 * forwards-only by default (`fromBlock = await getBlockNumber()`);
 * pass an explicit `fromBlock` to replay history.
 */
import { ACL_TESTNET, type AclDeployment, abis } from "@acl/core";
import { type Address, type Hex, type PublicClient, decodeEventLog } from "viem";

import { ORDERED_LIFECYCLE_EVENTS } from "./events.js";
import { getLogsPaginated } from "./log-paginate.js";

/**
 * Default cadence for the watcher's `eth_getLogs` poll. Sized for the
 * public 0G testnet RPC: too low and the SDK starts spamming the
 * provider; too high and demos feel sluggish. The agent SDK
 * re-exports this value as `DEFAULT_CHAIN_POLL_INTERVAL_MS` so callers
 * who want the watcher cadence to match `ProviderAgentConfig.chainPollIntervalMs`
 * can rely on a single source of truth.
 */
export const DEFAULT_LIFECYCLE_POLL_INTERVAL_MS = 4_000;

export type JobLifecycleEvent =
  | {
      type: "JobCreated";
      jobId: bigint;
      client: Address;
      provider: Address;
      evaluator: Address;
      expiredAt: bigint;
      hook: Address;
      txHash: Hex;
      blockNumber: bigint;
    }
  | {
      type: "ProviderSet";
      jobId: bigint;
      provider: Address;
      txHash: Hex;
      blockNumber: bigint;
    }
  | {
      type: "BudgetSet";
      jobId: bigint;
      amount: bigint;
      txHash: Hex;
      blockNumber: bigint;
    }
  | {
      type: "JobFunded";
      jobId: bigint;
      client: Address;
      amount: bigint;
      txHash: Hex;
      blockNumber: bigint;
    }
  | {
      type: "JobSubmitted";
      jobId: bigint;
      provider: Address;
      deliverable: Hex;
      txHash: Hex;
      blockNumber: bigint;
    }
  | {
      type: "JobCompleted";
      jobId: bigint;
      evaluator: Address;
      reason: Hex;
      txHash: Hex;
      blockNumber: bigint;
    }
  | {
      type: "JobRejected";
      jobId: bigint;
      rejector: Address;
      reason: Hex;
      txHash: Hex;
      blockNumber: bigint;
    }
  | { type: "JobExpired"; jobId: bigint; txHash: Hex; blockNumber: bigint };

export type WatchJobLifecycleOptions = {
  publicClient: PublicClient;
  /** Defaults to {@link ACL_TESTNET}. */
  deployment?: AclDeployment;
  /** Lower bound for log scan. Defaults to "current head" (forward-only mode). */
  fromBlock?: bigint;
  /** Cancel the watcher externally. Iterator returns once the signal aborts. */
  signal?: AbortSignal;
  /** Override the poll cadence (ms). Defaults to 4 seconds. */
  pollIntervalMs?: number;
  /**
   * Optional allow-list of event names. When supplied the watcher only
   * polls `eth_getLogs` for those events; absent events are treated as
   * "don't care" for both yielding AND terminal detection.
   *
   * Use this to stay compatible with `eth_getLogs`-rate-limited public
   * RPCs when only a subset of the lifecycle is of interest (e.g. a
   * Flow-2 buyer that only needs `JobSubmitted` after self-funding,
   * or a settlement waiter that only needs the two terminal events).
   * Defaults to all eight lifecycle events when omitted.
   */
  events?: ReadonlyArray<JobLifecycleEvent["type"]>;
  /**
   * Optional wall-clock timeout (ms). When the iterator runs longer
   * than this without observing a terminal event, it throws.
   * Implemented via an internal `AbortController + setTimeout`, so it
   * composes with `signal` (whichever fires first wins). Omit for the
   * old "run until terminal or external abort" semantics.
   */
  timeoutMs?: number;
};

const TERMINAL_EVENTS = new Set<JobLifecycleEvent["type"]>([
  "JobCompleted",
  "JobRejected",
  "JobExpired",
]);

/**
 * Async-iterable watcher. Yields typed events as they land. Ends on
 * terminal state (`JobCompleted` / `JobRejected` / `JobExpired`) or
 * when `opts.signal` aborts. Throws when `opts.timeoutMs` elapses.
 */
export async function* watchJobLifecycle(
  jobId: bigint,
  opts: WatchJobLifecycleOptions,
): AsyncIterable<JobLifecycleEvent> {
  const deployment = opts.deployment ?? ACL_TESTNET;
  const contract = deployment.galileo.agenticCommerce;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_LIFECYCLE_POLL_INTERVAL_MS;
  const filter = opts.events ? new Set(opts.events) : null;
  const eventsToPoll = filter
    ? ORDERED_LIFECYCLE_EVENTS.filter((e) => filter.has(e.name as JobLifecycleEvent["type"]))
    : ORDERED_LIFECYCLE_EVENTS;

  // Compose `opts.signal` with an optional internal timeout so callers
  // get a single "stop" surface. We never reach into `opts.signal`
  // directly past this point — `combinedSignal` is the source of truth.
  const internalAbort = new AbortController();
  const timer =
    opts.timeoutMs !== undefined ? setTimeout(() => internalAbort.abort(), opts.timeoutMs) : null;
  const externalAbort = (): void => internalAbort.abort();
  if (opts.signal) {
    if (opts.signal.aborted) internalAbort.abort();
    else opts.signal.addEventListener("abort", externalAbort, { once: true });
  }
  const combinedSignal = internalAbort.signal;

  let cursor = opts.fromBlock ?? (await opts.publicClient.getBlockNumber());

  // Local `(txHash, logIndex)` dedup so the same RPC re-emit doesn't
  // yield twice. `getLogsPaginated` already dedups within a single
  // call, but the poll loop can read overlapping windows across
  // cycles after a reorg, so we need a higher-level guard too.
  const seen = new Set<string>();

  try {
    while (!combinedSignal.aborted) {
      const head = await opts.publicClient.getBlockNumber();
      if (head >= cursor) {
        const collected: Array<{
          log: {
            blockNumber: bigint | null;
            logIndex: number | null;
            transactionHash: Hex | null;
            data: Hex;
            topics: readonly Hex[];
          };
          eventName: string;
        }> = [];
        for (const event of eventsToPoll) {
          const logs = await getLogsPaginated(opts.publicClient, {
            address: contract,
            event,
            args: { jobId },
            fromBlock: cursor,
            toBlock: head,
          });
          for (const log of logs) {
            collected.push({ log: log as never, eventName: event.name });
          }
        }
        // Sort by block number then log index for stable lifecycle order.
        collected.sort((a, b) => {
          const ab = a.log.blockNumber ?? 0n;
          const bb = b.log.blockNumber ?? 0n;
          if (ab !== bb) return ab < bb ? -1 : 1;
          return (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0);
        });

        for (const { log, eventName } of collected) {
          const dedupKey = `${log.transactionHash ?? "0x"}:${log.logIndex ?? 0}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          const decoded = decodeEventLog({
            abi: abis.agenticCommerceAbi,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
            strict: true,
          });
          if ((decoded.args as { jobId?: bigint }).jobId !== jobId) continue;
          const event = _shapeEvent(decoded.eventName, decoded.args, log);
          if (event) yield event;
          // Only terminate on a terminal event the caller actually
          // subscribed to. With `events: ['JobSubmitted']` callers
          // can early-exit from a non-terminal event; with no filter
          // the watcher keeps the original "stop on any terminal"
          // semantics.
          if (
            TERMINAL_EVENTS.has(eventName as JobLifecycleEvent["type"]) &&
            (filter === null || filter.has(eventName as JobLifecycleEvent["type"]))
          ) {
            return;
          }
        }
        cursor = head + 1n;
      }
      if (combinedSignal.aborted) break;
      await new Promise((res) => setTimeout(res, pollMs));
    }
    if (opts.timeoutMs !== undefined && internalAbort.signal.aborted) {
      // Distinguish caller-aborted vs timeout-aborted: if the EXTERNAL
      // signal didn't trigger, we hit the timer ourselves.
      if (!opts.signal?.aborted) {
        throw new Error(
          `@acl/settlement: watchJobLifecycle timed out after ${opts.timeoutMs}ms for jobId=${jobId}`,
        );
      }
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", externalAbort);
  }
}

function _shapeEvent(
  name: string,
  args: unknown,
  log: { blockNumber: bigint | null; transactionHash: Hex | null },
): JobLifecycleEvent | null {
  const blockNumber = log.blockNumber ?? 0n;
  const txHash = log.transactionHash ?? ("0x" as Hex);
  const a = args as Record<string, unknown>;
  switch (name) {
    case "JobCreated":
      return {
        type: "JobCreated",
        jobId: a.jobId as bigint,
        client: a.client as Address,
        provider: a.provider as Address,
        evaluator: a.evaluator as Address,
        expiredAt: a.expiredAt as bigint,
        hook: a.hook as Address,
        txHash,
        blockNumber,
      };
    case "ProviderSet":
      return {
        type: "ProviderSet",
        jobId: a.jobId as bigint,
        provider: a.provider as Address,
        txHash,
        blockNumber,
      };
    case "BudgetSet":
      return {
        type: "BudgetSet",
        jobId: a.jobId as bigint,
        amount: a.amount as bigint,
        txHash,
        blockNumber,
      };
    case "JobFunded":
      return {
        type: "JobFunded",
        jobId: a.jobId as bigint,
        client: a.client as Address,
        amount: a.amount as bigint,
        txHash,
        blockNumber,
      };
    case "JobSubmitted":
      return {
        type: "JobSubmitted",
        jobId: a.jobId as bigint,
        provider: a.provider as Address,
        deliverable: a.deliverable as Hex,
        txHash,
        blockNumber,
      };
    case "JobCompleted":
      return {
        type: "JobCompleted",
        jobId: a.jobId as bigint,
        evaluator: a.evaluator as Address,
        reason: a.reason as Hex,
        txHash,
        blockNumber,
      };
    case "JobRejected":
      return {
        type: "JobRejected",
        jobId: a.jobId as bigint,
        rejector: a.rejector as Address,
        reason: a.reason as Hex,
        txHash,
        blockNumber,
      };
    case "JobExpired":
      return {
        type: "JobExpired",
        jobId: a.jobId as bigint,
        txHash,
        blockNumber,
      };
    default:
      return null;
  }
}
