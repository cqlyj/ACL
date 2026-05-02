import { type Chain, defineChain } from "viem";
import type { AclDeployment } from "./addresses.js";

/**
 * Canonical Multicall3 deployment address. Multicall3 is deployed at the same
 * address on 250+ EVM chains, including 0G Galileo testnet (chain id 16602).
 *
 * @see https://www.multicall3.com/deployments
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Canonical public 0G Galileo testnet RPC URL.
 *
 * Operators MAY swap in a paid endpoint (e.g. QuickNode) for write-heavy work
 * such as deployment scripts, but the gateway's log indexer is happiest on
 * the public endpoint because most paid plans cap `eth_getLogs` at very
 * small windows (QuickNode's discover plan is 5 blocks). We therefore expose
 * this constant separately so the gateway CLI can default to it without
 * forcing the same URL on the rest of the stack.
 *
 * @see https://docs.0g.ai/developer-hub/testnet/testnet-overview
 */
export const GALILEO_PUBLIC_RPC_URL = "https://evmrpc-testnet.0g.ai" as const;

/**
 * Native currency of 0G Galileo. Pulled into named constants so SDK consumers
 * and the CLI agree on what `chain.nativeCurrency` looks like — viem's account
 * formatters key off the `symbol`, and `defineChain` blocks were otherwise
 * duplicated across the gateway CLI, the discovery resolver factory, and the
 * agent runtime.
 *
 * @see https://docs.0g.ai/developer-hub/testnet/testnet-overview
 */
export const GALILEO_NATIVE_CURRENCY = {
  /**
   * Display name. The 0G docs use "0G" colloquially; the explorer uses "0G"
   * for the gas token. Keep this in sync with both.
   */
  name: "0G",
  /**
   * Internal symbol used by viem when formatting balances. The 0G testnet
   * token is named A0GI (Anonymous 0G).
   */
  symbol: "A0GI",
  /** EVM-standard 18-decimal precision. */
  decimals: 18,
} as const;

/**
 * 0G Galileo testnet chain default name (matches the explorer label so debug
 * messages print a human-readable chain).
 */
export const GALILEO_CHAIN_NAME = "0G Galileo" as const;

/**
 * Build a viem `Chain` for 0G Galileo from a deployment + RPC URL. Centralised
 * here so every place that needs a `PublicClient` against Galileo (the gateway
 * CLI, the discovery resolver factory, agent runtime, application code) ends
 * up wiring identical chain metadata — same id, same RPC list, same
 * Multicall3 binding. Pass an explicit `rpcUrl` to override the deployment
 * default (e.g. when consumers swap in a private endpoint).
 *
 * @example
 * ```ts
 * import { ACL_TESTNET, defineGalileoChain } from '@acl/core';
 * const galileo = defineGalileoChain(ACL_TESTNET, process.env.ZG_RPC);
 * const client = createPublicClient({ chain: galileo, transport: http() });
 * ```
 */
export function defineGalileoChain(deployment: AclDeployment, rpcUrl?: string): Chain {
  const url = rpcUrl ?? deployment.galileo.rpcUrl;
  return defineChain({
    id: deployment.galileo.chainId,
    name: GALILEO_CHAIN_NAME,
    nativeCurrency: { ...GALILEO_NATIVE_CURRENCY },
    rpcUrls: {
      default: { http: [url] },
    },
    contracts: {
      multicall3: { address: MULTICALL3_ADDRESS },
    },
  });
}
