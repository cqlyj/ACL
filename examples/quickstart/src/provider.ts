/**
 * Provider process — the seller. Spawns its OWN AXL bridge (a separate
 * `gensyn-axl/node` binary), peered to the client's bridge over TLS,
 * then runs a `ProviderAgent` that:
 *
 *   - listens on AXL for `JobProposal` envelopes,
 *   - decides ACCEPT / COUNTER / REJECT via the LLM,
 *   - pulls the funded TaskSpec from 0G Storage,
 *   - drafts a deliverable via the LLM,
 *   - uploads it to 0G Storage and submits the Merkle root to ERC-8183.
 *
 * The agent stays running until SIGINT.
 */
import { ACL_TESTNET, ProviderAgent, createZGRouterBackend } from "@acl/agent";
import {
  PROVIDER_MIN_BUDGET,
  PROVIDER_PERSONA,
  TASK_DOMAINS,
  env,
} from "./config.js";
import { spawnLocalAxl } from "./lib/axl.js";
import { logEvent } from "./lib/log.js";

async function main() {
  const { child: bridge, apiUrl } = await spawnLocalAxl("provider");

  const agent = new ProviderAgent({
    account: env.providerPk(),
    galileoRpcUrl: env.galileoRpcUrl,
    ...(env.sepoliaRpcUrl ? { sepoliaRpcUrl: env.sepoliaRpcUrl } : {}),
    llm: createZGRouterBackend({
      apiKey: env.zgRouterApiKey(),
      model: env.zgRouterModel,
      ...(env.zgRouterBaseUrl ? { baseUrl: env.zgRouterBaseUrl } : {}),
    }),
    axlApiUrl: apiUrl,
    ensName: `${env.providerEnsLabel}.${ACL_TESTNET.ens.parentName}`,
    persona: PROVIDER_PERSONA,
    acceptPolicy: {
      minBudget: PROVIDER_MIN_BUDGET,
      taskDomains: [...TASK_DOMAINS],
      paymentTokens: [ACL_TESTNET.galileo.testUSDC],
      maxConcurrentJobs: 1,
    },
  });

  agent.events.on((ev) => logEvent("provider", ev));
  await agent.start();
  console.log(
    `[provider ] live (peer=${agent.peerId.slice(0, 12)}…) — Ctrl-C to stop`,
  );

  const shutdown = async () => {
    console.log("[provider ] shutting down…");
    await agent.stop().catch(() => undefined);
    bridge.kill("SIGINT");
    setTimeout(() => bridge.kill("SIGKILL"), 1500).unref();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[provider ] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
