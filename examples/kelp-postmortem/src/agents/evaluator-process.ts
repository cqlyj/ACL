/**
 * Evaluator process. Boots an `EvaluatorAgent` and streams events
 * back to the coordinator. The evaluator picks a 0G Compute provider
 * via the SDK's `qwen-2.5-7b-instruct` match and verifies every TEE
 * response before forwarding to `ACLEvaluator.settle()`.
 *
 * One operator caveat: the evaluator's account MUST be authorised on
 * `ACLEvaluator` (`setOperator`). When `EVALUATOR_OWNER_PRIVATE_KEY`
 * is supplied, the SDK's {@link ensureEvaluatorOperator} helper
 * idempotently authorises the operator before the agent starts —
 * so fresh demo wallets boot cleanly without manual setup.
 */

import { EvaluatorAgent, ensureEvaluatorOperator } from "@acl/agent";
import { COORDINATOR_URL, config } from "../config.js";
import { forwardEventsToCoordinator } from "../event-forwarder.js";
import { exitWhenOrphaned } from "../parent-watchdog.js";

async function main() {
  exitWhenOrphaned();
  const coordinatorUrl = COORDINATOR_URL;
  const operatorPk = config.evaluatorOperatorPrivateKey();
  const ownerPk = config.evaluatorOwnerPrivateKey();

  const agent = new EvaluatorAgent({
    account: operatorPk,
    galileoRpcUrl: config.galileoRpcUrl,
    ...(config.sepoliaRpcUrl ? { sepoliaRpcUrl: config.sepoliaRpcUrl } : {}),
  });

  const off = forwardEventsToCoordinator({
    events: agent.events,
    coordinatorUrl,
    source: "evaluator",
  });

  if (ownerPk) {
    await ensureEvaluatorOperator({
      ownerPrivateKey: ownerPk,
      operator: agent.address,
      deployment: config.deployment,
      galileoRpcUrl: config.galileoRpcUrl,
    });
  }

  console.log(`[evaluator] starting agent (operator=${agent.address})`);
  await agent.start();
  console.log("[evaluator] live");

  const shutdown = async () => {
    off();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[evaluator] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
