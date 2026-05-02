import { isRpcRangeLimitError } from "@acl/core";
import type { AbiEvent, Address, Log, PublicClient } from "viem";

/**
 * `eth_getLogs` paginator that respects RPC providers' max-block
 * windows. Public testnet RPC tiers (Alchemy free, QuickNode Discover,
 * etc.) cap the from→to range — typically between 5 and 10_000 blocks
 * — and reject anything bigger with an opaque error.
 *
 * The settlement / agent runtimes need to be tolerant of any of those
 * caps because we can't predict whose RPC the developer will plug in.
 * Strategy:
 *
 *   1. Try the full window in one call (fast path).
 *   2. On "range too wide" style errors, halve the window and retry.
 *   3. Floor at a 1-block window so we never spin forever.
 *
 * The block range we paginate over is small in steady-state (poll
 * cadence is seconds, not days), so the worst case is still O(log W)
 * extra round-trips on first start — acceptable for an SDK that
 * favours "works on every RPC" over "minimum requests".
 */
export async function getLogsPaginated<E extends AbiEvent>(
  publicClient: PublicClient,
  params: {
    address: Address;
    event: E;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  },
): Promise<Log[]> {
  if (params.fromBlock > params.toBlock) return [];
  const out: Log[] = [];
  const chunks: Array<{ from: bigint; to: bigint }> = [
    { from: params.fromBlock, to: params.toBlock },
  ];
  while (chunks.length > 0) {
    const slice = chunks.shift();
    if (!slice) break;
    try {
      const logs = await publicClient.getLogs({
        address: params.address,
        event: params.event,
        ...(params.args ? { args: params.args as never } : {}),
        fromBlock: slice.from,
        toBlock: slice.to,
      });
      out.push(...logs);
    } catch (err) {
      if (slice.from === slice.to) throw err; // can't shrink further
      if (!isRpcRangeLimitError(err)) throw err;
      const mid = slice.from + (slice.to - slice.from) / 2n;
      chunks.unshift({ from: slice.from, to: mid }, { from: mid + 1n, to: slice.to });
    }
  }
  return _dedupLogs(out);
}

/**
 * Deduplicate logs by `(transactionHash, logIndex)`. Public RPC tiers
 * (notably 0G's testnet endpoint) sometimes return the same log
 * multiple times within a single `eth_getLogs` response — most often
 * after a fork-choice flip or when the node is mid-resync. Our agent
 * loops use the chain log as the source-of-truth trigger, so a single
 * duplicated log would push the agent through the full pipeline
 * (downloads + LLM + settle) twice. Dedup at the boundary: cheap and
 * keeps the rest of the code race-free.
 *
 * `null` log identity (pending logs from `eth_subscribe` / mempool)
 * is preserved untouched — those are not deliverable on `eth_getLogs`
 * but we don't want to silently drop them either.
 */
function _dedupLogs(logs: Log[]): Log[] {
  const seen = new Set<string>();
  const out: Log[] = [];
  for (const log of logs) {
    if (log.transactionHash === null || log.logIndex === null) {
      out.push(log);
      continue;
    }
    const key = `${log.transactionHash}:${log.logIndex.toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out;
}
