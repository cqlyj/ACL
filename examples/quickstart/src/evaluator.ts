/**
 * Evaluator process. Boots an `EvaluatorAgent` that watches every
 * `JobSubmitted` event whose `evaluator == ACLEvaluator`, runs the
 * deliverable through 0G Compute (`qwen-2.5-7b-instruct`), verifies
 * the TEE signature locally and on-chain via `ecrecover`, then writes
 * the verdict back through `ACLEvaluator.settle()`.
 *
 * The evaluator does NOT need an AXL bridge — it interacts only with
 * the chain and 0G Compute, not with the client/provider over AXL.
 */
import { EvaluatorAgent, ensureEvaluatorOperator } from "@acl/agent";
import { env } from "./config.js";
import { logEvent } from "./lib/log.js";

async function main() {
  const operatorPk = env.evaluatorOperatorPk();
  const ownerPk = env.evaluatorOwnerPk();

  const agent = new EvaluatorAgent({
    account: operatorPk,
    galileoRpcUrl: env.galileoRpcUrl,
    ...(env.sepoliaRpcUrl ? { sepoliaRpcUrl: env.sepoliaRpcUrl } : {}),
  });

  agent.events.on((ev) => logEvent("evaluator", ev));

  if (ownerPk) {
    await ensureEvaluatorOperator({
      ownerPrivateKey: ownerPk,
      operator: agent.address,
      deployment: agent.runtime.deployment,
      galileoRpcUrl: env.galileoRpcUrl,
    });
  }

  await agent.start();
  console.log(`[evaluator] live (operator=${agent.address}) — Ctrl-C to stop`);

  const shutdown = async () => {
    console.log("[evaluator] shutting down…");
    await agent.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[evaluator] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
