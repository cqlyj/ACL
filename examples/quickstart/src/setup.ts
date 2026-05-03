/**
 * One-time on-chain setup for the quickstart provider.
 *
 *   1. Spawn the provider's AXL bridge briefly to read its public peer
 *      id. The same peer key (`.axl/provider.pem`) is reused by
 *      `provider.ts` so the on-chain `acl.axl-peer-id` value stays
 *      stable across runs.
 *   2. Register the provider in `ACLIdentityRegistry` and publish the
 *      canonical ACL metadata (agent address, evaluator address,
 *      payment tokens, min budget, task domains, AXL peer id, ENS
 *      label, agent-context capabilities).
 *
 * Idempotent: re-running with a cached agent id reuses it instead of
 * minting a fresh one. Cached at `.axl/provider.agent-id`.
 *
 * Loud progress logs (see `lib/setup-log.ts`) so the operator sees
 * forward motion through the ~25–30s on-chain phase.
 *
 * No iNFT is minted here — the quickstart is the Flow-1 commission
 * lane only. See `examples/kelp-postmortem` for the full ERC-7857
 * iNFT acquisition flow.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACL_TESTNET, createAgentRuntime, registerAclAgent } from "@acl/agent";
import { privateKeyToAccount } from "viem/accounts";
import {
  CAPABILITIES,
  PROVIDER_MIN_BUDGET,
  TASK_DOMAINS,
  env,
} from "./config.js";
import { AXL_DIR, spawnLocalAxl } from "./lib/axl.js";
import { setupLog } from "./lib/setup-log.js";

async function main() {
  mkdirSync(AXL_DIR, { recursive: true });
  const idCachePath = resolve(AXL_DIR, "provider.agent-id");
  const log = setupLog();

  log.info(`ENS label: ${env.providerEnsLabel}.${ACL_TESTNET.ens.parentName}`);
  log.info(`task domains: ${TASK_DOMAINS.join(", ")}`);

  log.step("spawning provider AXL bridge briefly to read peer id");
  const { child, peerId } = await spawnLocalAxl("provider", {
    peers: [],
    quiet: true,
  });
  child.kill("SIGINT");
  log.ok(`AXL peer id = ${peerId}`);

  const providerKey = env.providerPk();
  const providerAccount = privateKeyToAccount(providerKey);
  const runtime = createAgentRuntime({
    account: providerKey,
    galileoRpcUrl: env.galileoRpcUrl,
    ...(env.sepoliaRpcUrl ? { sepoliaRpcUrl: env.sepoliaRpcUrl } : {}),
  });

  const existingAgentId = existsSync(idCachePath)
    ? BigInt(readFileSync(idCachePath, "utf8").trim())
    : undefined;
  if (existingAgentId !== undefined) {
    log.info(`reusing cached agentId=${existingAgentId}`);
  }
  log.step(
    existingAgentId === undefined
      ? "registering on ACLIdentityRegistry (mint + 10 setMetadata, ~30s)"
      : "refreshing on-chain metadata (10 setMetadata, ~25s)",
  );
  const result = await registerAclAgent({
    publicClient: runtime.publicClient,
    walletClient: runtime.walletClient,
    identityRegistry: runtime.deployment.galileo.identityRegistry,
    ...(existingAgentId !== undefined ? { existingAgentId } : {}),
    ensLabel: env.providerEnsLabel,
    agentAddress: providerAccount.address,
    evaluatorAddress: runtime.deployment.galileo.aclEvaluator,
    axlPeerId: peerId,
    taskDomains: [...TASK_DOMAINS],
    paymentTokens: [runtime.deployment.galileo.testUSDC],
    minBudget: PROVIDER_MIN_BUDGET,
    chainId: runtime.deployment.galileo.chainId,
    capabilities: [...CAPABILITIES],
  });
  if (result.minted) writeFileSync(idCachePath, result.agentId.toString());
  log.ok(`agentId=${result.agentId} (${result.minted ? "minted" : "reused"})`);
  for (const tx of result.txHashes) {
    log.tx(tx);
  }
  log.ok("setup complete — provider is now discoverable through the gateway");
}

main().catch((err) => {
  console.error(`[setup    ] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
