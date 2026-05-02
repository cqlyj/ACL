import { ACL_METADATA_KEYS, abis, buildAgentContext, waitForReceiptResilient } from "@acl/core";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  encodeAbiParameters,
  parseAbiItem,
  stringToBytes,
  toHex,
} from "viem";

/**
 * Programmatic agent registration on `ACLIdentityRegistry`.
 *
 * Consumers can ship an end-to-end agent in a few lines:
 *
 * ```ts
 * const { agentId } = await registerAclAgent({
 *   publicClient, walletClient,
 *   identityRegistry: deployment.galileo.identityRegistry,
 *   ensLabel: 'researcher',
 *   agentAddress, evaluatorAddress, axlPeerId,
 *   taskDomains: ['security', 'research'],
 *   paymentTokens: [deployment.galileo.testUSDC],
 *   minBudget: 100n * 10n ** 6n,
 *   chainId: 16602,
 * });
 * ```
 *
 * Idempotent in spirit: when `existingAgentId` is provided, we skip
 * `register()` and only re-write metadata. Useful for hot-reloading
 * a provider's advertised taskDomains without minting a new id.
 */

export type RegisterAclAgentInput = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  identityRegistry: Address;

  /**
   * If set, skip `register()` and reuse this agentId for the metadata
   * writes. The caller MUST own this agent id (or hold operator rights).
   */
  existingAgentId?: bigint;

  /** ENS sub-label, e.g. `"researcher"` for `researcher.acl.eth`. */
  ensLabel: string;
  /** Address the agent transacts as (escrow signer, AXL session signer). */
  agentAddress: Address;
  /** Trusted-party evaluator address (typically the ACLEvaluator deployment). */
  evaluatorAddress: Address;
  /** AXL public peer id (returned by `bootstrapAxl`). */
  axlPeerId: string;
  /** Task domains the agent advertises. Joined with `","` for storage. */
  taskDomains: string[];
  /** Delivery types the agent accepts. Joined with `","` for storage. */
  deliveryTypes?: string[];
  /** ERC-20s the agent accepts as payment. Stored as `abi.encode(address[])`. */
  paymentTokens: Address[];
  /** Minimum budget in `paymentTokens[0]` smallest-unit. */
  minBudget: bigint;
  /** Chain id of the registry. Stored as `abi.encode(uint256)`. */
  chainId: number;
  /**
   * ENSIP-26 capability tokens the agent advertises. Lowercased + deduped
   * by `buildAgentContext` before storage. Combined with
   * {@link agentContextExtra} into the on-chain `agent-context` JSON.
   *
   * When BOTH `capabilities` and `agentContextExtra` are absent / empty
   * the bootstrap skips the `agent-context` write entirely so non-ACL
   * agents don't accidentally publish an empty record.
   */
  capabilities?: ReadonlyArray<string>;
  /**
   * Forwards-compatible JSON fields to merge into the `agent-context`
   * record. Useful for things like `acl.cap.inft-sale.contract` /
   * `acl.cap.inft-sale.token-id` that don't have a dedicated SDK
   * helper yet.
   */
  agentContextExtra?: Record<string, unknown>;
};

export type RegisterAclAgentResult = {
  agentId: bigint;
  /** Tx hashes in the order they were submitted, oldest first. */
  txHashes: Hex[];
  /** True when `register()` was actually called (vs reused via `existingAgentId`). */
  minted: boolean;
};

const REGISTERED_EVENT = parseAbiItem(
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
);

/**
 * Register or update an ACL agent's identity + canonical metadata.
 * Mirrors the on-chain `script/RegisterAgent.s.sol` write set so the
 * SDK and Foundry script produce the exact same agent shape.
 */
export async function registerAclAgent(
  input: RegisterAclAgentInput,
): Promise<RegisterAclAgentResult> {
  const account = input.walletClient.account;
  if (!account) {
    throw new Error("@acl/agent: walletClient has no `account` configured");
  }
  const txHashes: Hex[] = [];
  let agentId = input.existingAgentId;
  let minted = false;

  if (agentId === undefined) {
    const txHash = await input.walletClient.writeContract({
      account,
      chain: input.walletClient.chain,
      address: input.identityRegistry,
      abi: abis.aclIdentityRegistryAbi,
      functionName: "register",
      args: [],
    });
    txHashes.push(txHash);
    const receipt = await waitForReceiptResilient(input.publicClient, txHash);
    agentId = _parseAgentIdFromLogs(receipt.logs, input.identityRegistry);
    minted = true;
  }

  const writes: Array<{ key: string; value: Hex }> = [
    {
      key: ACL_METADATA_KEYS.agentAddress,
      value: encodeAbiParameters([{ type: "address" }], [input.agentAddress]),
    },
    {
      key: ACL_METADATA_KEYS.evaluatorAddress,
      value: encodeAbiParameters([{ type: "address" }], [input.evaluatorAddress]),
    },
    {
      key: ACL_METADATA_KEYS.paymentTokens,
      value: encodeAbiParameters([{ type: "address[]" }], [input.paymentTokens]),
    },
    {
      key: ACL_METADATA_KEYS.minBudget,
      value: encodeAbiParameters([{ type: "uint256" }], [input.minBudget]),
    },
    {
      key: ACL_METADATA_KEYS.chainId,
      value: encodeAbiParameters([{ type: "uint256" }], [BigInt(input.chainId)]),
    },
    {
      key: ACL_METADATA_KEYS.taskDomains,
      value: toHex(stringToBytes(input.taskDomains.join(","))),
    },
    {
      key: ACL_METADATA_KEYS.deliveryTypes,
      value: toHex(stringToBytes((input.deliveryTypes ?? ["text"]).join(","))),
    },
    {
      key: ACL_METADATA_KEYS.axlPeerId,
      value: toHex(stringToBytes(input.axlPeerId)),
    },
    {
      key: ACL_METADATA_KEYS.ensLabel,
      value: toHex(stringToBytes(input.ensLabel)),
    },
  ];

  // ENSIP-26 `agent-context`: skip the write entirely when the caller
  // didn't supply capabilities OR extra fields. The gateway returns
  // `capabilities: []` for missing records, so an empty record adds
  // nothing but a wasted setMetadata tx.
  const agentContextJson = buildAgentContext({
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    ...(input.agentContextExtra !== undefined ? { extra: input.agentContextExtra } : {}),
  });
  if (agentContextJson !== null) {
    writes.push({
      key: ACL_METADATA_KEYS.agentContext,
      value: toHex(stringToBytes(agentContextJson)),
    });
  }

  // Sequence each setMetadata strictly: pin an explicit pending-nonce
  // per call so back-to-back writes don't collide on the same slot
  // (some RPCs reject a same-nonce replacement as "underpriced" before
  // viem even sees it). We refresh against `pending` after every wait
  // so a stuck tx in the mempool doesn't poison the next one.
  for (const w of writes) {
    const nonce = await input.publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    const txHash = await input.walletClient.writeContract({
      account,
      chain: input.walletClient.chain,
      address: input.identityRegistry,
      abi: abis.aclIdentityRegistryAbi,
      functionName: "setMetadata",
      args: [agentId, w.key, w.value],
      nonce,
    });
    txHashes.push(txHash);
    await waitForReceiptResilient(input.publicClient, txHash);
  }

  return { agentId, txHashes, minted };
}

function _parseAgentIdFromLogs(
  logs: ReadonlyArray<{ address: Address; topics: readonly Hex[]; data: Hex }>,
  identityRegistry: Address,
): bigint {
  const lc = identityRegistry.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== lc) continue;
    try {
      const decoded = decodeEventLog({
        abi: [REGISTERED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (decoded.eventName === "Registered") return decoded.args.agentId as bigint;
    } catch {
      // Topic mismatch — keep scanning.
    }
  }
  throw new Error("@acl/agent: no Registered log in receipt");
}
