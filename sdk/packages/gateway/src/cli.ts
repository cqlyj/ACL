#!/usr/bin/env bun
import {
  ACL_TESTNET,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_TRANSPORT_RETRY_COUNT,
  DEFAULT_TRANSPORT_RETRY_DELAY_MS,
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  GALILEO_PUBLIC_RPC_URL,
  defineGalileoChain,
} from "@acl/core";
import { http, type Address, type Hex, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_RESPONSE_TTL_SECONDS } from "./constants.js";
import {
  DEFAULT_INDEXER_BLOCK_RANGE,
  DEFAULT_INDEXER_POLL_INTERVAL_MS,
  IdentityRegistryIndexer,
} from "./indexer.js";
import { ResolverService } from "./resolver-service.js";
import { createGateway } from "./server.js";

/**
 * `acl-gateway` — boot a CCIP-Read gateway from environment variables.
 *
 * Required:
 *   GATEWAY_SIGNER_PRIVATE_KEY   0x-prefixed key (must be authorised on the resolver)
 *
 * Optional (sensible defaults from @acl/core/addresses):
 *   GATEWAY_PORT                 default 3000
 *   GATEWAY_HOST                 default 0.0.0.0
 *   ACL_OFFCHAIN_RESOLVER        Sepolia resolver address
 *   ACL_IDENTITY_REGISTRY        IdentityRegistry on 0G Galileo
 *   ACL_PARENT_NAME              parent ENS name (default `acl.eth`)
 *   GATEWAY_RPC                  RPC the indexer hits with `eth_getLogs`.
 *                                Defaults to the public 0G Galileo endpoint
 *                                (`https://evmrpc-testnet.0g.ai`). Paid
 *                                plans (e.g. QuickNode discover) that cap
 *                                log ranges at ~5 blocks make the backfill
 *                                impractical, so we intentionally do NOT
 *                                inherit `ZG_RPC` here. Override only if
 *                                you maintain a private endpoint without a
 *                                range cap.
 *   ZG_CHAIN_ID                  default 16602
 *   GATEWAY_FROM_BLOCK           start block for the indexer. Defaults to
 *                                `deployment.galileo.identityRegistryDeployBlock`
 *                                so a fresh boot doesn't scan from genesis
 *                                on a long-lived public chain. Set to `0`
 *                                explicitly to force a from-zero rescan.
 *   GATEWAY_BLOCK_RANGE          max blocks per eth_getLogs request (default
 *                                5000). The indexer halves this on RPC
 *                                range-limit errors and grows it back on
 *                                success, so the value is mostly an upper
 *                                bound.
 *   GATEWAY_POLL_INTERVAL_MS     default 5000
 *   GATEWAY_RESPONSE_TTL         signed response validity (seconds, default 300)
 */

const DEFAULT_GATEWAY_PORT = 3000;
const DEFAULT_GATEWAY_HOST = "0.0.0.0";

function readEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function readEnvAddress(name: string, fallback: Address): Address {
  const v = process.env[name];
  if (!v) return fallback;
  return v as Address;
}

function readEnvNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new Error(`Env var ${name}=${v} is not a finite number`);
  }
  return n;
}

function readEnvBigInt(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (!v) return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`Env var ${name}=${v} is not a valid integer`);
  }
}

async function main() {
  const port = readEnvNumber("GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
  const host = readEnv("GATEWAY_HOST", DEFAULT_GATEWAY_HOST);
  const signerPrivateKey = readEnv("GATEWAY_SIGNER_PRIVATE_KEY") as Hex;
  const responseTtlSeconds = readEnvNumber(
    "GATEWAY_RESPONSE_TTL",
    DEFAULT_RESPONSE_TTL_SECONDS,
  );
  const fromBlock = readEnvBigInt(
    "GATEWAY_FROM_BLOCK",
    ACL_TESTNET.galileo.identityRegistryDeployBlock,
  );
  const blockRange = readEnvBigInt(
    "GATEWAY_BLOCK_RANGE",
    DEFAULT_INDEXER_BLOCK_RANGE,
  );
  const pollIntervalMs = readEnvNumber(
    "GATEWAY_POLL_INTERVAL_MS",
    DEFAULT_INDEXER_POLL_INTERVAL_MS,
  );
  const parentName = readEnv("ACL_PARENT_NAME", ACL_TESTNET.ens.parentName);

  const resolverAddress = readEnvAddress(
    "ACL_OFFCHAIN_RESOLVER",
    ACL_TESTNET.ens.aclOffchainResolver,
  );
  const identityRegistry = readEnvAddress(
    "ACL_IDENTITY_REGISTRY",
    ACL_TESTNET.galileo.identityRegistry,
  );
  // The gateway's only chain interaction is `eth_getLogs` (driven by the
  // MetadataSet backfill) plus `eth_blockNumber` polls. Most paid 0G plans
  // (e.g. QuickNode discover) cap log ranges at ~5 blocks, which makes
  // the backfill prohibitively slow. We therefore default the gateway to
  // the public 0G endpoint regardless of `ZG_RPC` (which Forge scripts
  // and other writers continue to use as their primary RPC). Operators
  // with an unrestricted private RPC can opt back in by setting
  // `GATEWAY_RPC=<their-url>` explicitly.
  const gatewayRpc = readEnv("GATEWAY_RPC", GALILEO_PUBLIC_RPC_URL);
  const zgChainId = readEnvNumber("ZG_CHAIN_ID", ACL_TESTNET.galileo.chainId);

  const account = privateKeyToAccount(signerPrivateKey);
  console.log(`[gateway] signer address: ${account.address}`);
  console.log(`[gateway] resolver:       ${resolverAddress}`);
  console.log(`[gateway] registry:       ${identityRegistry}`);
  console.log(`[gateway] parent name:    ${parentName}`);
  console.log(`[gateway] RPC:            ${gatewayRpc}`);

  // Re-bind the deployment chain id + RPC URL when overridden via env so
  // the chain object viem uses is consistent end-to-end.
  const deployment = {
    ...ACL_TESTNET,
    galileo: { ...ACL_TESTNET.galileo, chainId: zgChainId, rpcUrl: gatewayRpc },
  };
  const galileo = defineGalileoChain(deployment, gatewayRpc);
  // Same transport tuning as `@acl/core/clients` so the gateway tolerates
  // the public 0G RPC's transient 5xx / slow propagation under load.
  const client = createPublicClient({
    chain: galileo,
    transport: http(gatewayRpc, {
      retryCount: DEFAULT_TRANSPORT_RETRY_COUNT,
      retryDelay: DEFAULT_TRANSPORT_RETRY_DELAY_MS,
      timeout: DEFAULT_TRANSPORT_TIMEOUT_MS,
    }),
    pollingInterval: DEFAULT_POLLING_INTERVAL_MS,
  });

  const indexer = new IdentityRegistryIndexer({
    client,
    identityRegistry,
    fromBlock,
    pollIntervalMs,
    blockRange,
  });

  console.log("[gateway] backfilling MetadataSet events...");
  const t0 = Date.now();
  await indexer.start();
  console.log(
    `[gateway] indexed ${indexer.agents().length} agents in ${Date.now() - t0}ms`,
  );

  const resolverService = new ResolverService({
    indexer,
    parentName,
    registryChainId: zgChainId,
    registryAddress: identityRegistry,
  });

  const app = createGateway({
    resolverAddress,
    signerPrivateKey,
    indexer,
    resolverService,
    responseTtlSeconds,
  });

  Bun.serve({ port, hostname: host, fetch: app.fetch });
  console.log(`[gateway] listening on http://${host}:${port}`);
  console.log(`[gateway] healthz: http://${host}:${port}/healthz`);
}

main().catch((err) => {
  console.error("[gateway] fatal", err);
  process.exit(1);
});
