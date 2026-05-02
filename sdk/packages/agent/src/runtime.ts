/**
 * `createAgentRuntime` — the chain wiring kernel every ACL agent
 * needs, regardless of the role it plays on a job.
 *
 * It pulls the duplicated viem / ethers / 0G boilerplate out of
 * consumer apps so the smallest valid bootstrap is one call:
 *
 * ```ts
 * import { createAgentRuntime } from '@acl/agent';
 *
 * const runtime = createAgentRuntime({
 *   account: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
 * });
 * ```
 *
 * From there an app reaches for the protocol primitives directly
 * (`createAgentResolver` from `@acl/discovery`, `createNegotiator`
 * from `@acl/negotiation`, `createJobOrchestrator` from
 * `@acl/settlement`, etc.). Composition is by design — different
 * end-to-end flows (Simple Job, iNFT commerce, anything else built
 * on ERC-8183) need different choreographies, so the SDK keeps the
 * pieces and lets the app glue them together.
 */

import {
  ACL_TESTNET,
  type AccountLike,
  type AclDeployment,
  type GalileoClients,
  type GasFeeOverrides,
  type HttpTransportOptions,
  createEnsClient,
  createGalileoClients,
  toAccount,
} from "@acl/core";
import { type AclStorage, createAclStorage, createEthersSignerFromPrivateKey } from "@acl/storage";
import type { JsonRpcSigner, Wallet } from "ethers";
import type { Address, Chain, LocalAccount, PublicClient } from "viem";

/**
 * Concrete ethers signer types accepted by the 0G SDKs (storage +
 * compute). Mirrors the upstream `EvaluatorConfig.signer` and
 * `AclStorageConfig.signer` shapes — a generic `ethers.Signer` would
 * be wider than the SDKs accept.
 */
export type AgentEthersSigner = JsonRpcSigner | Wallet;

/**
 * Optional overrides every agent role exposes through its config and
 * forwards verbatim to {@link createAgentRuntime}. Kept as a single
 * type so role configs and the runtime kernel stay in lock-step on
 * names + defaults — and so {@link pickRuntimeOverrides} can pull
 * exactly these fields off any `AgentBaseConfig` without picking up
 * unrelated fields like `events` or LLM config.
 *
 * Field semantics:
 *   - `deployment`: pinned ACL deployment; defaults to {@link ACL_TESTNET}.
 *   - `galileoRpcUrl`: defaults to `deployment.galileo.rpcUrl`.
 *   - `sepoliaRpcUrl`: defaults to `SEPOLIA_PUBLIC_RPC_URL` from `@acl/core`.
 *   - `storageIndexerUrl`: defaults to the testnet turbo indexer
 *     (`ZG_STORAGE_TURBO_INDEXER`).
 *   - `ethersSigner`: pre-built ethers signer for the 0G SDKs. Required
 *     only when `account` is a non-private-key viem account AND the
 *     agent needs storage / evaluator features.
 *   - `transportOptions`: tuning for the Galileo HTTP transport.
 *   - `pollingIntervalMs`: viem `PublicClient` polling cadence.
 */
export type AgentRuntimeOverrides = {
  deployment?: AclDeployment;
  galileoRpcUrl?: string;
  sepoliaRpcUrl?: string;
  storageIndexerUrl?: string;
  ethersSigner?: AgentEthersSigner;
  transportOptions?: HttpTransportOptions;
  pollingIntervalMs?: number;
  /**
   * Gas/fee overrides applied to every write the runtime issues
   * (orchestrator, iNFT client, …). Threaded straight into
   * {@link createGalileoClients}; consumers running against a chain
   * that disabled EIP-1559 set `{ type: 'legacy', gasPrice }` here and
   * forget about it.
   */
  gasFeeOverrides?: GasFeeOverrides;
};

/** Inputs accepted by {@link createAgentRuntime}. */
export type AgentRuntimeOptions = AgentRuntimeOverrides & {
  /**
   * Viem account or 0x-prefixed private key the agent signs with.
   * Required — every role takes at least one on-chain action.
   */
  account: AccountLike;
};

/**
 * Pull the runtime-relevant overrides off any agent config. Centralises
 * the verbose `exactOptionalPropertyTypes`-friendly conditional spread
 * so each agent constructor stays a one-liner.
 */
export function pickRuntimeOverrides(config: AgentRuntimeOverrides): AgentRuntimeOverrides {
  return {
    ...(config.deployment !== undefined ? { deployment: config.deployment } : {}),
    ...(config.galileoRpcUrl !== undefined ? { galileoRpcUrl: config.galileoRpcUrl } : {}),
    ...(config.sepoliaRpcUrl !== undefined ? { sepoliaRpcUrl: config.sepoliaRpcUrl } : {}),
    ...(config.storageIndexerUrl !== undefined
      ? { storageIndexerUrl: config.storageIndexerUrl }
      : {}),
    ...(config.ethersSigner !== undefined ? { ethersSigner: config.ethersSigner } : {}),
    ...(config.transportOptions !== undefined ? { transportOptions: config.transportOptions } : {}),
    ...(config.pollingIntervalMs !== undefined
      ? { pollingIntervalMs: config.pollingIntervalMs }
      : {}),
    ...(config.gasFeeOverrides !== undefined ? { gasFeeOverrides: config.gasFeeOverrides } : {}),
  };
}

/** Common runtime kernel returned by {@link createAgentRuntime}. */
export type AgentRuntime = GalileoClients & {
  /** Pinned ACL deployment. */
  readonly deployment: AclDeployment;
  /** Resolved viem account. Always defined inside an agent runtime. */
  readonly account: LocalAccount;
  /** Convenience alias for `account.address`. */
  readonly address: Address;
  /** Viem wallet client bound to `account`. Always defined. */
  readonly walletClient: NonNullable<GalileoClients["walletClient"]>;
  /** ENS-side public client (Sepolia). */
  readonly ensClient: PublicClient;
  /** 0G Storage wrapper bound to the agent's signer + RPC. */
  readonly storage: AclStorage;
  /** Resolved 0G Galileo chain config (Multicall3 + RPC). */
  readonly chain: Chain;
  /** Galileo RPC URL the runtime is using. */
  readonly galileoRpcUrl: string;
  /** Ethers signer used by the 0G SDKs (storage + compute broker). */
  readonly ethersSigner: AgentEthersSigner;
};

/**
 * Build the shared chain-wiring kernel. Returns a single object that
 * exposes everything an ACL agent typically needs:
 *
 *   - `publicClient` / `walletClient` (viem) bound to 0G Galileo
 *   - `ensClient` (viem) bound to Sepolia for ENS / CCIP-Read
 *   - `storage` (AclStorage) for 0G Storage uploads + downloads
 *   - `ethersSigner` for any 0G SDK call that still demands ethers
 *
 * Throws synchronously on any wiring error so the misconfiguration
 * surfaces at construction time, not at the first transaction.
 */
export function createAgentRuntime(opts: AgentRuntimeOptions): AgentRuntime {
  const deployment = opts.deployment ?? ACL_TESTNET;
  const account = toAccount(opts.account);
  const galileoRpcUrl = opts.galileoRpcUrl ?? deployment.galileo.rpcUrl;
  const galileo = createGalileoClients({
    deployment,
    rpcUrl: galileoRpcUrl,
    account,
    ...(opts.transportOptions !== undefined ? { transportOptions: opts.transportOptions } : {}),
    ...(opts.pollingIntervalMs !== undefined ? { pollingIntervalMs: opts.pollingIntervalMs } : {}),
    ...(opts.gasFeeOverrides !== undefined ? { gasFeeOverrides: opts.gasFeeOverrides } : {}),
  });
  if (!galileo.walletClient) {
    // Defence in depth — the helper guarantees `walletClient` whenever
    // `account` is supplied, but TS can't narrow that here.
    throw new Error(
      "createAgentRuntime: walletClient missing despite account; this is a bug in createGalileoClients",
    );
  }
  const ensClient = createEnsClient(opts.sepoliaRpcUrl, opts.transportOptions);
  const ethersSigner = opts.ethersSigner ?? _buildEthersSigner(opts.account, galileoRpcUrl);
  // Resolution order for the storage indexer URL:
  //   1. explicit `storageIndexerUrl` on the runtime options;
  //   2. `process.env.ZG_STORAGE_INDEXER` (a deliberate ergonomic
  //      exception — the runtime is the bridge between consumer apps
  //      and the 0G SDKs, both of which already read env vars; lower
  //      level packages like `@acl/storage` keep zero env reads);
  //   3. the constant default in `@acl/storage`.
  // Documented inline so other packages don't follow the pattern.
  const indexerUrl = opts.storageIndexerUrl ?? process.env.ZG_STORAGE_INDEXER ?? undefined;
  const storage = _buildStorage({
    ethersSigner,
    galileoRpcUrl,
    indexerUrl,
  });
  return {
    deployment,
    account,
    address: account.address,
    chain: galileo.chain,
    publicClient: galileo.publicClient,
    walletClient: galileo.walletClient,
    ensClient,
    storage,
    galileoRpcUrl,
    ethersSigner,
    ...(galileo.gasFeeOverrides !== undefined ? { gasFeeOverrides: galileo.gasFeeOverrides } : {}),
  };
}

/**
 * Build an ethers `Wallet` from the same input used for the viem
 * account. Only works for plain private keys — viem-only accounts
 * (LocalAccount, smart accounts, …) need the caller to pass
 * `ethersSigner` explicitly because the 0G SDKs don't accept viem
 * accounts directly.
 */
function _buildEthersSigner(input: AccountLike, galileoRpcUrl: string): AgentEthersSigner {
  if (typeof input !== "string") {
    throw new Error(
      "createAgentRuntime: cannot derive an ethers signer from a non-private-key viem account; pass `ethersSigner` explicitly so 0G Storage / 0G Compute have a wallet to sign with.",
    );
  }
  return createEthersSignerFromPrivateKey(input, galileoRpcUrl);
}

function _buildStorage(opts: {
  ethersSigner: AgentEthersSigner;
  galileoRpcUrl: string;
  indexerUrl: string | undefined;
}): AclStorage {
  return createAclStorage({
    signer: opts.ethersSigner,
    rpcUrl: opts.galileoRpcUrl,
    ...(opts.indexerUrl !== undefined ? { indexerUrl: opts.indexerUrl } : {}),
  });
}
