/**
 * Pre-baked viem client factories for the two chains the ACL SDK touches:
 *
 *   - **Galileo** (0G testnet, ERC-8183 + identity / reputation / validation
 *     registries + ACLEvaluator) — used by every package _except_ the
 *     `ensClient` plumbing.
 *   - **Sepolia** (host of the `*.acl.eth` ENS records via the ACL
 *     off-chain resolver) — used by `@acl/discovery` for ENSIP-10 lookups.
 *
 * Centralising these here removes the duplicated `defineChain` /
 * `createPublicClient` / `createWalletClient` / `privateKeyToAccount`
 * boilerplate that would otherwise appear in every consumer script and
 * downstream agent.
 */

import {
  http,
  type Chain,
  type Hex,
  type LocalAccount,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ACL_TESTNET, type AclDeployment } from "./addresses.js";
import { defineGalileoChain } from "./chains.js";

/**
 * Default ENS host RPC. ACL agent records live on Sepolia (the
 * `*.acl.eth` domain is registered there); we point at PublicNode's
 * free Sepolia endpoint as a sensible default for fresh checkouts.
 * Production consumers should pass their own URL via `sepoliaRpcUrl`.
 */
export const SEPOLIA_PUBLIC_RPC_URL =
  "https://ethereum-sepolia-rpc.publicnode.com" as const;

/**
 * Default HTTP transport tuning. Public 0G testnet RPC (and other
 * permissionless endpoints) are slow and routinely return transient
 * 5xx / timeouts under modest load. Out-of-the-box viem defaults
 * (`retryCount: 3`, `retryDelay: 150`, `timeout: 10_000`) are too
 * aggressive — a handful of agents polling logs and submitting
 * transactions in parallel will hit "fetch failed" before the request
 * lands. These constants bias for "slow but reliable" so the SDK works
 * out of the box on public RPC; consumers running their own dedicated
 * node can lower them via `transportOptions`.
 */
export const DEFAULT_TRANSPORT_RETRY_COUNT = 5 as const;
export const DEFAULT_TRANSPORT_RETRY_DELAY_MS = 1_000 as const;
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000 as const;
/**
 * Default `PublicClient.pollingInterval`. Faster than viem's `4_000`
 * default so `waitForTransactionReceipt` notices a confirmation as soon
 * as the public RPC propagates it (helps with the "tx confirmed but
 * receipt lookup times out" failure mode on public 0G endpoints).
 */
export const DEFAULT_POLLING_INTERVAL_MS = 2_000 as const;

/** Knob for tuning the underlying viem `http` transport. */
export type HttpTransportOptions = {
  retryCount?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

/**
 * Optional gas / fee overrides applied to every `walletClient.writeContract`
 * issued through the SDK (orchestrator, iNFT client, etc.). Defaults are
 * EIP-1559 — Galileo natively supports it; the legacy fallback is exposed
 * for operators running against a private chain that disabled type-2 txs.
 *
 * The discriminator field `type` is intentionally narrow so consumers can
 * destructure with exhaustive-check confidence:
 *
 * ```ts
 * if (overrides.type === 'eip1559') {
 *   tx.maxFeePerGas = overrides.maxFeePerGas;
 *   tx.maxPriorityFeePerGas = overrides.maxPriorityFeePerGas;
 * } else {
 *   tx.gasPrice = overrides.gasPrice;
 * }
 * ```
 */
export type GasFeeOverrides =
  | {
      type: "eip1559";
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    }
  | {
      type: "legacy";
      gasPrice: bigint;
    };

/**
 * Spread the fee overrides into a viem `writeContract` / `sendTransaction`
 * argument bag. Centralised so every write site looks the same and so the
 * EIP-1559 vs legacy branch lives in one place.
 *
 * Returns a partial of the fee fields rather than mutating an input — keeps
 * the call site readable: `{ ...feeFields(overrides), ...rest }`.
 */
export function feeFields(
  overrides: GasFeeOverrides | undefined,
):
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint }
  | Record<string, never> {
  if (overrides === undefined) return {};
  if (overrides.type === "eip1559") {
    return {
      maxFeePerGas: overrides.maxFeePerGas,
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
    };
  }
  return { gasPrice: overrides.gasPrice };
}

/**
 * Inputs accepted in any place the SDK needs a viem-style account.
 * Restricted to {@link LocalAccount} (which {@link PrivateKeyAccount}
 * extends) plus a 0x-prefixed private-key hex string — the SDK signs
 * locally everywhere (EIP-712 proposals, EVM transactions on
 * Galileo) so a `JsonRpcAccount` (remote signing) wouldn't work.
 */
export type AccountLike = LocalAccount | Hex;

/**
 * Coerce {@link AccountLike} into a concrete viem account. A plain
 * `0x...`-prefixed private-key string spawns a {@link PrivateKeyAccount};
 * a pre-built {@link LocalAccount} is passed through unchanged.
 * Exported so consumers can normalise an incoming env-var without
 * re-implementing the branch.
 */
export function toAccount(input: AccountLike): LocalAccount {
  if (typeof input === "string") {
    return privateKeyToAccount(input);
  }
  return input;
}

/**
 * Pull the local account off a wallet client and throw a clear,
 * package-attributed error if one wasn't bound. Centralised so every
 * write path in the SDK fails identically when called against a
 * read-only wallet.
 *
 * @example
 * ```ts
 * const account = requireWalletAccount(walletClient, "@acl/inft");
 * ```
 */
export function requireWalletAccount(
  walletClient: WalletClient,
  packageTag: string,
): NonNullable<WalletClient["account"]> {
  const account = walletClient.account;
  if (!account) {
    throw new Error(
      `${packageTag}: walletClient is missing an account; pass \`account\` when creating it`,
    );
  }
  return account;
}

export type CreateGalileoClientsOptions = {
  /** Pinned ACL deployment. Defaults to {@link ACL_TESTNET}. */
  deployment?: AclDeployment;
  /**
   * Override the Galileo RPC URL. Defaults to
   * `deployment.galileo.rpcUrl` (which itself defaults to the public
   * 0G testnet endpoint).
   */
  rpcUrl?: string;
  /**
   * Optional local account / private-key. When provided, the helper
   * also returns a `walletClient` bound to that account; omit it for
   * read-only contexts.
   */
  account?: AccountLike;
  /**
   * Tuning for the underlying viem `http` transport. Defaults bias for
   * slow public RPC endpoints; consumers running a dedicated node can
   * lower them.
   */
  transportOptions?: HttpTransportOptions;
  /**
   * Override the public client polling interval (ms). Defaults to
   * {@link DEFAULT_POLLING_INTERVAL_MS}.
   */
  pollingIntervalMs?: number;
  /**
   * Optional gas/fee overrides applied to every write the SDK issues
   * through this wallet client. Stored on the returned
   * {@link GalileoClients} so orchestrators / iNFT clients can spread
   * them per-call. Defaults to EIP-1559 estimation by viem (Galileo
   * natively supports type-2 transactions).
   */
  gasFeeOverrides?: GasFeeOverrides;
};

export type GalileoClients = {
  /** The viem `Chain` object built from `deployment` + `rpcUrl`. */
  chain: Chain;
  /** Galileo public client (reads, multicall, log queries). */
  publicClient: PublicClient;
  /**
   * Galileo wallet client. Only present when an `account` was
   * supplied; absent otherwise to make the type tell you when a write
   * path is unavailable.
   */
  walletClient?: WalletClient;
  /** Resolved viem account, when supplied. */
  account?: LocalAccount;
  /**
   * Caller-supplied fee overrides. The orchestrator / iNFT client
   * spread these into every `writeContract` so a consumer running
   * against a chain that demands legacy gas can pin one config and
   * have every SDK write honor it.
   */
  gasFeeOverrides?: GasFeeOverrides;
};

/**
 * Build the canonical Galileo client triad in one call.
 *
 * The `walletClient` is only attached when an `account` (or private
 * key) is supplied — keeps the surface honest about read-only vs
 * read-write contexts.
 *
 * @example
 * ```ts
 * import { createGalileoClients } from "@acl/core";
 *
 * const { publicClient, walletClient } = createGalileoClients({
 *   account: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
 * });
 * ```
 */
export function createGalileoClients(
  opts: CreateGalileoClientsOptions = {},
): GalileoClients {
  const deployment = opts.deployment ?? ACL_TESTNET;
  const chain = defineGalileoChain(deployment, opts.rpcUrl);
  const transport = http(opts.rpcUrl ?? deployment.galileo.rpcUrl, {
    retryCount:
      opts.transportOptions?.retryCount ?? DEFAULT_TRANSPORT_RETRY_COUNT,
    retryDelay:
      opts.transportOptions?.retryDelayMs ?? DEFAULT_TRANSPORT_RETRY_DELAY_MS,
    timeout: opts.transportOptions?.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS,
  });
  const publicClient = createPublicClient({
    chain,
    transport,
    pollingInterval: opts.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
  });
  if (opts.account === undefined) {
    return {
      chain,
      publicClient,
      ...(opts.gasFeeOverrides !== undefined
        ? { gasFeeOverrides: opts.gasFeeOverrides }
        : {}),
    };
  }
  const account = toAccount(opts.account);
  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });
  return {
    chain,
    publicClient,
    walletClient,
    account,
    ...(opts.gasFeeOverrides !== undefined
      ? { gasFeeOverrides: opts.gasFeeOverrides }
      : {}),
  };
}

/**
 * Build a Sepolia `PublicClient` for ENS resolution. Centralised so
 * every script and helper picks up the same `viem/chains/sepolia`
 * metadata + a single default RPC URL.
 *
 * Uses the same transport tuning as {@link createGalileoClients} (slow
 * public endpoints can also rate-limit Sepolia).
 */
export function createEnsClient(
  rpcUrl?: string,
  transportOptions?: HttpTransportOptions,
): PublicClient {
  return createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl ?? SEPOLIA_PUBLIC_RPC_URL, {
      retryCount: transportOptions?.retryCount ?? DEFAULT_TRANSPORT_RETRY_COUNT,
      retryDelay:
        transportOptions?.retryDelayMs ?? DEFAULT_TRANSPORT_RETRY_DELAY_MS,
      timeout: transportOptions?.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS,
    }),
  });
}
