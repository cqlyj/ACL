import {
  ACL_METADATA_KEYS,
  abis,
  decodeMetadata,
  isRpcRangeLimitError,
  parseAgentContext,
} from "@acl/core";
import { type Address, type Hex, type PublicClient, decodeEventLog, parseAbiItem } from "viem";

/**
 * In-memory mirror of `ACLIdentityRegistry` metadata. Built by replaying every
 * `MetadataSet` event since deployment and then polling for new ones. The
 * gateway uses this to:
 *
 *   - resolve `<label>.acl.eth` → `agentId` (via the `acl.ens-label` key)
 *   - read every canonical metadata value without round-tripping to the chain
 *     on every resolver request
 *
 * Snapshots are live: the rebuild loop overwrites old values whenever a new
 * `MetadataSet` event fires for a key that already had a value. This matches
 * `setMetadata` semantics on-chain (last write wins).
 */

export type AgentMetadata = Map<string, Hex>;

export type IndexedAgent = {
  agentId: bigint;
  metadata: AgentMetadata;
};

const METADATA_SET_EVENT = parseAbiItem(
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
);

/**
 * Default span scanned per `getLogs` request during backfill. 5000 blocks
 * works against most public RPCs (alchemy/infura cap at 10_000; the public
 * 0G Galileo endpoint has no published cap as of writing). Override via
 * {@link IndexerConfig.blockRange} when a stricter RPC limit applies.
 */
export const DEFAULT_INDEXER_BLOCK_RANGE = 5_000n;

/**
 * Smallest block range the adaptive backoff will collapse to before
 * giving up. One block per request is the floor — anything below would
 * imply the RPC simply doesn't support `eth_getLogs` for the contract.
 */
export const MIN_INDEXER_BLOCK_RANGE = 1n;

/**
 * Default polling interval for incremental tail scans (ms).
 */
export const DEFAULT_INDEXER_POLL_INTERVAL_MS = 5_000;

export type IndexerConfig = {
  client: PublicClient;
  identityRegistry: Address;
  fromBlock?: bigint;
  /**
   * Polling interval for new events (ms). Defaults to
   * {@link DEFAULT_INDEXER_POLL_INTERVAL_MS}.
   */
  pollIntervalMs?: number;
  /**
   * Max block range per `getLogs` call. Some testnet RPCs cap this very
   * low (e.g. QuickNode discover plan caps at 5). The indexer halves the
   * effective range on every `eth_getLogs` failure that looks like a
   * range-limit error, down to {@link MIN_INDEXER_BLOCK_RANGE}, then
   * surfaces the underlying RPC error if the smallest range still fails.
   * Defaults to {@link DEFAULT_INDEXER_BLOCK_RANGE}.
   */
  blockRange?: bigint;
};

export class IdentityRegistryIndexer {
  readonly client: PublicClient;
  readonly identityRegistry: Address;
  private readonly _agents = new Map<bigint, AgentMetadata>();
  private readonly _labelIndex = new Map<string, bigint>();
  /**
   * Per-agent ENSIP-26 capabilities, lowercased + deduped at index time.
   * Rebuilt whenever the agent's `agent-context` record updates.
   */
  private readonly _capabilities = new Map<bigint, string[]>();
  private _lastBlock: bigint | null = null;
  private readonly _fromBlock: bigint;
  private readonly _pollIntervalMs: number;
  private readonly _blockRange: bigint;
  /**
   * Current per-request range, halved on RPC range errors and grown back
   * after each success. Always in [MIN_INDEXER_BLOCK_RANGE, _blockRange].
   */
  private _effectiveBlockRange: bigint;
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;

  constructor(cfg: IndexerConfig) {
    this.client = cfg.client;
    this.identityRegistry = cfg.identityRegistry;
    this._fromBlock = cfg.fromBlock ?? 0n;
    this._pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_INDEXER_POLL_INTERVAL_MS;
    this._blockRange = cfg.blockRange ?? DEFAULT_INDEXER_BLOCK_RANGE;
    this._effectiveBlockRange = this._blockRange;
  }

  /** Snapshot of all known agents — useful for `/agents` debug routes. */
  agents(): IndexedAgent[] {
    return [...this._agents.entries()].map(([agentId, metadata]) => ({
      agentId,
      metadata,
    }));
  }

  agent(agentId: bigint): AgentMetadata | undefined {
    return this._agents.get(agentId);
  }

  /**
   * Resolve an ENS sublabel (e.g. "researcher") to its agentId, or `null`.
   * Case-insensitive: ENS names are UTS46-normalised lowercase, but the
   * call-site that surfaces a label is sometimes user-supplied (e.g. a
   * `cast call` debugging session) so we always lowercase before lookup
   * to match {@link _normalizeLabel}.
   */
  agentIdForLabel(label: string): bigint | null {
    return this._labelIndex.get(_normalizeLabel(label)) ?? null;
  }

  metadata(agentId: bigint, key: string): Hex | undefined {
    return this._agents.get(agentId)?.get(key);
  }

  /**
   * Lowercased + deduped ENSIP-26 capabilities for `agentId`. Empty
   * array when the agent has no `agent-context` record OR the record
   * fails JSON parse — the gateway never throws on missing/malformed
   * records.
   */
  capabilitiesOf(agentId: bigint): string[] {
    return [...(this._capabilities.get(agentId) ?? [])];
  }

  /**
   * Exact-token, case-insensitive capability check. Mirrors the SDK's
   * {@link import('@acl/core').hasCapability} semantics so a query
   * like `?capability=inft-sale` returns the same set on both sides
   * of the gateway boundary.
   */
  hasCapability(agentId: bigint, capability: string): boolean {
    const list = this._capabilities.get(agentId);
    if (!list) return false;
    const needle = capability.trim().toLowerCase();
    if (!needle) return false;
    return list.includes(needle);
  }

  /** Block until the initial backfill completes; safe to call multiple times. */
  async start(): Promise<void> {
    await this._backfill();
    this._scheduleNextPoll();
  }

  stop(): void {
    this._stopped = true;
    if (this._pollTimer) clearTimeout(this._pollTimer);
  }

  private async _backfill(): Promise<void> {
    const head = await this.client.getBlockNumber();
    let cursor = this._fromBlock;
    while (cursor <= head) {
      const toBlock = bigMin(cursor + this._effectiveBlockRange - 1n, head);
      await this._scanRange(cursor, toBlock);
      cursor = toBlock + 1n;
    }
    this._lastBlock = head;
  }

  /**
   * Fetch + ingest a span of `MetadataSet` events. RPCs frequently cap
   * `eth_getLogs` ranges (5–10 000 blocks is typical; QuickNode's free
   * tier caps at 5). When the RPC reports a range error we halve the
   * window and retry — recursively — down to a single block, so the
   * indexer is still functional on the strictest providers.
   */
  private async _scanRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    try {
      const logs = await this.client.getLogs({
        address: this.identityRegistry,
        event: METADATA_SET_EVENT,
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        this._ingestLog(log);
      }
      // Successful scans grow the effective range back toward the
      // configured ceiling so the indexer self-heals after a transient
      // narrow window.
      if (this._effectiveBlockRange < this._blockRange) {
        const grown = this._effectiveBlockRange * 2n;
        this._effectiveBlockRange = grown > this._blockRange ? this._blockRange : grown;
      }
    } catch (err) {
      const span = toBlock - fromBlock + 1n;
      if (span <= MIN_INDEXER_BLOCK_RANGE || !isRpcRangeLimitError(err)) throw err;
      const half = span / 2n;
      const newRange = half > MIN_INDEXER_BLOCK_RANGE ? half : MIN_INDEXER_BLOCK_RANGE;
      this._effectiveBlockRange =
        newRange < this._effectiveBlockRange ? newRange : this._effectiveBlockRange;
      const mid = fromBlock + half - 1n;
      console.warn(
        `[indexer] eth_getLogs ${fromBlock}→${toBlock} failed (${(err as Error).message?.slice(0, 80)}…); retrying with span=${half}`,
      );
      await this._scanRange(fromBlock, mid);
      await this._scanRange(mid + 1n, toBlock);
    }
  }

  private _ingestLog(log: { topics: readonly Hex[] | Hex[]; data: Hex }): void {
    let decoded: ReturnType<typeof decodeEventLog>;
    try {
      decoded = decodeEventLog({
        abi: abis.aclIdentityRegistryAbi,
        eventName: "MetadataSet",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
    } catch {
      return;
    }

    const args = decoded.args as unknown as {
      agentId: bigint;
      metadataKey: string;
      metadataValue: Hex;
    };
    const { agentId, metadataKey: key, metadataValue: value } = args;

    let bag = this._agents.get(agentId);
    if (!bag) {
      bag = new Map();
      this._agents.set(agentId, bag);
    }

    const prev = bag.get(key);
    if (value === "0x") {
      bag.delete(key);
    } else {
      bag.set(key, value);
    }

    if (key === ACL_METADATA_KEYS.ensLabel) {
      this._reindexLabel(agentId, prev, value);
    }
    if (key === ACL_METADATA_KEYS.agentContext) {
      this._reindexCapabilities(agentId, value);
    }
  }

  /**
   * Refresh the per-agent capabilities cache from the just-written
   * `agent-context` record. Tolerant: any non-JSON / schema-mismatched
   * value resets the agent to `[]` rather than throwing — the gateway
   * must never fail an `/agents` request because of one malformed
   * record on a single agent.
   */
  private _reindexCapabilities(agentId: bigint, raw: Hex): void {
    if (raw === "0x") {
      this._capabilities.delete(agentId);
      return;
    }
    const ctx = parseAgentContext(decodeMetadata.asString(raw));
    if (ctx.capabilities.length === 0) {
      this._capabilities.delete(agentId);
    } else {
      this._capabilities.set(agentId, ctx.capabilities);
    }
  }

  private _reindexLabel(agentId: bigint, prev: Hex | undefined, next: Hex): void {
    const prevLabel = prev && prev !== "0x" ? _normalizeLabel(decodeMetadata.asString(prev)) : null;
    const nextLabel = next && next !== "0x" ? _normalizeLabel(decodeMetadata.asString(next)) : null;

    if (prevLabel && this._labelIndex.get(prevLabel) === agentId) {
      this._labelIndex.delete(prevLabel);
    }
    if (nextLabel) {
      this._labelIndex.set(nextLabel, agentId);
    }
  }

  private _scheduleNextPoll(): void {
    if (this._stopped) return;
    this._pollTimer = setTimeout(() => {
      this._poll().catch((err) => console.error("[indexer] poll error", err));
    }, this._pollIntervalMs);
  }

  private async _poll(): Promise<void> {
    if (this._stopped) return;
    const head = await this.client.getBlockNumber();
    if (this._lastBlock !== null && head > this._lastBlock) {
      let cursor = this._lastBlock + 1n;
      while (cursor <= head) {
        const toBlock = bigMin(cursor + this._effectiveBlockRange - 1n, head);
        await this._scanRange(cursor, toBlock);
        cursor = toBlock + 1n;
      }
      this._lastBlock = head;
    }
    this._scheduleNextPoll();
  }
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Lowercase the ENS label form used as a key in {@link IdentityRegistryIndexer._labelIndex}.
 *
 * ENSIP-1 specifies UTS46 normalisation of the full name; for a single
 * label that effectively means lowercasing ASCII codepoints. We keep the
 * normaliser deliberately small here so the indexer doesn't pull in viem's
 * full UTS46 implementation; consumers that need the formal normaliser
 * should do it before calling `agentIdForLabel`.
 */
function _normalizeLabel(label: string): string {
  return label.toLowerCase();
}

/**
 * Re-export the canonical `decodeMetadata` namespace from `@acl/core`
 * so existing gateway consumers (resolver-service, batch-gateway tests)
 * don't have to chase a new import path. Single source of truth lives
 * in `@acl/core`.
 */
export { decodeMetadata };
