/**
 * Client process. Boots a `ClientAgent`, then waits on stdin (one
 * line of JSON per job) for `runJob` invocations from the coordinator.
 *
 * Wire protocol (stdin → stdout):
 *   {"action":"runJob","input":{ ...RunJobInput }}
 *   → emits per-line JSON envelopes:
 *     {"type":"job-started"}
 *     {"type":"job-finished","result":{ ...ClientJobResult }}
 *     {"type":"job-error","error":"..."}
 *
 * The coordinator owns process lifecycle; this script only handles
 * one in-flight job at a time and exits on SIGINT.
 *
 * Flow-2 trigger. When `DEMO_ORACLE_PRIVATE_KEY` is configured, the
 * process also instantiates a {@link BuyerFlow} that subscribes to
 * `job.settled.client-side` events. The flow gates strictly on
 * `approved=true`, decides ACQUIRE/SKIP via the LLM, and (on
 * ACQUIRE) issues the buyer-as-evaluator iNFT runJob.
 */

import readline from "node:readline";
import {
  ClientAgent,
  type ClientAgentConfig,
  type RunJobInput,
  createZGRouterBackend,
  serializeAgentEvent,
} from "@acl/agent";
import { createDemoLocalReencryptionOracle } from "@acl/inft";
import { type Hex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AXL_BRIDGES, COORDINATOR_URL, config } from "../config.js";
import { forwardEventsToCoordinator } from "../event-forwarder.js";
import { BuyerFlow } from "../inft/buyer-flow.js";
import { exitWhenOrphaned } from "../parent-watchdog.js";

async function main() {
  exitWhenOrphaned();
  const coordinatorUrl = COORDINATOR_URL;

  const llm = createZGRouterBackend({
    apiKey: config.zgRouterApiKey(),
    model: config.zgRouterModel,
    ...(config.zgRouterBaseUrl ? { baseUrl: config.zgRouterBaseUrl } : {}),
  });

  const agentConfig: ClientAgentConfig = {
    account: config.clientPrivateKey(),
    galileoRpcUrl: config.galileoRpcUrl,
    ...(config.sepoliaRpcUrl ? { sepoliaRpcUrl: config.sepoliaRpcUrl } : {}),
    llm,
    axlApiUrl: `http://127.0.0.1:${AXL_BRIDGES.client.apiPort}`,
    gatewayUrl: config.gatewayUrl(),
    persona:
      "You are a procurement agent commissioning a security-focused post-mortem of a recent DeFi exploit.",
  };
  const agent = new ClientAgent(agentConfig);

  const off = forwardEventsToCoordinator({
    events: agent.events,
    coordinatorUrl,
    source: "client",
  });

  // ---------- Phase-2 BuyerFlow wiring ----------
  //
  // BuyerFlow consumes the SDK's rich `job.settled.client-side` event
  // payload directly (provider profile, capabilities, brief, runJobInput,
  // selfComplete flag), so the example doesn't need its own
  // discovery-tracking sidecar anymore.
  const demoOraclePk = config.demoOraclePrivateKey();
  let detachBuyerFlow: (() => void) | null = null;
  if (demoOraclePk) {
    // Demo-local oracle: in production this is a TEE-backed
    // `ReencryptionOracle`. Here it decrypts via the coordinator's
    // in-process key registry and signs OwnershipProofs with the
    // configured demo EOA — the trust model the testnet verifier
    // already accepts (`setOracle(DEMO_ORACLE_ADDRESS)`).
    const oracleSigner = privateKeyToAccount(demoOraclePk);
    const oracle = createDemoLocalReencryptionOracle({
      oracleSigner,
      verifierAddress: agent.runtime.deployment.galileo.trustedPartyVerifier,
      chainId: BigInt(agent.runtime.deployment.galileo.chainId),
      fetchDataKey: (tokenId) => fetchSellerDataKey(coordinatorUrl, tokenId),
    });
    const buyerFlow = new BuyerFlow({
      client: agent,
      llm,
      buyerPrivateKey: config.clientPrivateKey(),
      oracle,
    });
    // BuyerFlow now emits its outcomes (`phase2.completed` /
    // `phase2.failed`) through the agent bus as `app.event` payloads,
    // which `forwardEventsToCoordinator` already pipes into SSE.
    // We just attach and let the bus do the work — no separate
    // stdout channel needed.
    detachBuyerFlow = buyerFlow.attach();
    emit({ type: "phase2-ready", oracle: oracleSigner.address });
  } else {
    emit({
      type: "phase2-disabled",
      reason: "DEMO_ORACLE_PRIVATE_KEY missing",
    });
  }

  await agent.start();
  emit({ type: "client-ready", address: agent.address });

  const rl = readline.createInterface({ input: process.stdin });
  let busy = false;
  rl.on("line", async (line) => {
    if (busy) {
      emit({ type: "job-error", error: "client busy with previous job" });
      return;
    }
    let envelope: { action?: string; input?: RunJobInput };
    try {
      envelope = JSON.parse(line);
    } catch {
      emit({ type: "job-error", error: "invalid JSON on stdin" });
      return;
    }
    if (envelope.action !== "runJob" || !envelope.input) {
      emit({
        type: "job-error",
        error: 'expected {"action":"runJob","input":{...}}',
      });
      return;
    }
    busy = true;
    emit({ type: "job-started" });
    try {
      const input = envelope.input;
      // Spread the JSON envelope verbatim and only re-coerce the
      // numeric fields JSON can't carry natively (bigint).
      const result = await agent.runJob({
        ...input,
        maxBudget: BigInt(input.maxBudget as unknown as string),
        ...(input.expiresAt !== undefined
          ? { expiresAt: BigInt(input.expiresAt as unknown as string) }
          : {}),
        ...(input.openingBudget !== undefined
          ? { openingBudget: BigInt(input.openingBudget as unknown as string) }
          : {}),
      });
      emit({
        type: "job-finished",
        result: {
          jobId: result.jobId.toString(),
          approved: result.approved,
          attestationRoot: result.attestationRoot,
          deliverableRoot: result.deliverableRoot,
          taskSpecRoot: result.taskSpecRoot,
          txHashes: result.txHashes,
        },
      });
    } catch (err) {
      emit({ type: "job-error", error: (err as Error).message });
    } finally {
      busy = false;
    }
  });

  const shutdown = async () => {
    detachBuyerFlow?.();
    off();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function emit(payload: Record<string, unknown>): void {
  // Phase-2's `bundle` field can contain `bigint` values (the recovered
  // provider bundle includes things like `lastJobId`). Use the SDK's
  // shared serialiser so this stdout protocol matches the SSE bridge.
  process.stdout.write(`${serializeAgentEvent(payload)}\n`);
}

/**
 * Hit the coordinator's in-process iNFT key registry — the demo's
 * stand-in for a TEE attestation channel. Returns the seller's raw
 * AES key for `tokenId` so the demo-local oracle can decrypt the
 * IntelligentData blob during a Phase-2 acquisition.
 */
async function fetchSellerDataKey(coordinatorUrl: string, tokenId: bigint): Promise<Uint8Array> {
  const url = `${coordinatorUrl}/api/inft-keys/${tokenId.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Phase-2: coordinator key registry returned ${res.status} for tokenId=${tokenId}`,
    );
  }
  const body = (await res.json()) as { dataKey?: Hex };
  if (!body.dataKey) {
    throw new Error(`Phase-2: coordinator key registry has no dataKey for tokenId=${tokenId}`);
  }
  return hexToBytes(body.dataKey);
}

main().catch((err) => {
  console.error(`[client] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
