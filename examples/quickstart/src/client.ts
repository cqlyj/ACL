/**
 * Client process — the buyer. Spawns its OWN AXL bridge (a separate
 * `gensyn-axl/node` binary) peered to the provider's bridge over TLS,
 * then runs ONE end-to-end commerce job through `ClientAgent.runJob`:
 *
 *   1. LLM picks a `taskDomain` from `ALLOWED_DOMAINS`.
 *   2. Gateway returns providers whose `acl.task-domains` match.
 *   3. LLM ranks the candidates and picks the best.
 *   4. AXL: client ↔ provider negotiate (HELLO/PROPOSE/COUNTER/ACCEPT).
 *   5. Client uploads the TaskSpec to 0G Storage, calls
 *      `AgenticCommerce.createJob` / `setProvider` / `fund`.
 *   6. Provider executes, uploads deliverable, calls `submit(...)`.
 *   7. Evaluator runs 0G Compute, verifies TEE signature, settles.
 *   8. Settlement releases escrow + writes a feedback entry on
 *      `ACLReputationRegistry`.
 *
 * Exits as soon as the on-chain `JobCompleted` / `JobRejected` fires.
 */
import { ClientAgent, createZGRouterBackend } from "@acl/agent";
import {
  ALLOWED_DOMAINS,
  BRIEF,
  CLIENT_PERSONA,
  MAX_BUDGET,
  env,
} from "./config.js";
import { spawnLocalAxl } from "./lib/axl.js";
import { logEvent } from "./lib/log.js";

async function main() {
  const { child: bridge, apiUrl } = await spawnLocalAxl("client");

  const agent = new ClientAgent({
    account: env.clientPk(),
    galileoRpcUrl: env.galileoRpcUrl,
    ...(env.sepoliaRpcUrl ? { sepoliaRpcUrl: env.sepoliaRpcUrl } : {}),
    llm: createZGRouterBackend({
      apiKey: env.zgRouterApiKey(),
      model: env.zgRouterModel,
      ...(env.zgRouterBaseUrl ? { baseUrl: env.zgRouterBaseUrl } : {}),
    }),
    axlApiUrl: apiUrl,
    gatewayUrl: env.gatewayUrl(),
    persona: CLIENT_PERSONA,
  });

  agent.events.on((ev) => logEvent("client", ev));
  await agent.start();
  console.log(`[client   ] live (address=${agent.address}) — running job…\n`);

  try {
    const result = await agent.runJob({
      brief: BRIEF,
      maxBudget: MAX_BUDGET,
      allowedDomains: [...ALLOWED_DOMAINS],
    });
    console.log("\n[client   ] ✓ job complete");
    console.log(`[client   ]   jobId            = ${result.jobId}`);
    console.log(`[client   ]   approved         = ${result.approved}`);
    console.log(`[client   ]   taskSpec root    = ${result.taskSpecRoot}`);
    console.log(
      `[client   ]   deliverable root = ${result.deliverableRoot ?? "n/a"}`,
    );
    console.log(
      `[client   ]   attestation root = ${result.attestationRoot ?? "n/a"}`,
    );
    for (const [label, tx] of Object.entries(result.txHashes)) {
      if (tx)
        console.log(
          `[client   ]     ${label.padEnd(11)} https://chainscan-galileo.0g.ai/tx/${tx}`,
        );
    }
    if (result.deliverableRoot) {
      const d = await agent.runtime.storage.downloadJson(
        result.deliverableRoot,
      );
      console.log("\n[client   ] deliverable from 0G Storage:");
      console.log(JSON.stringify(d, null, 2));
    }
  } finally {
    await agent.stop().catch(() => undefined);
    bridge.kill("SIGINT");
    setTimeout(() => bridge.kill("SIGKILL"), 1500).unref();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[client   ] fatal: ${(err as Error).stack ?? err}`);
    process.exit(1);
  },
);
