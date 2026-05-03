/**
 * Pretty stdout printer for `AgentEvent` payloads. The agent classes
 * surface every interesting protocol step on their event bus —
 * discovery, AXL negotiation, on-chain calls, evaluator verdicts — so
 * tailing the bus is enough to follow the demo without any web UI.
 */
import type { AgentEvent } from "@acl/agent";

const tag = (role: string) => `[${role.padEnd(9)}]`;

export function logEvent(
  role: "client" | "provider" | "evaluator",
  ev: AgentEvent,
): void {
  const t = tag(role);
  switch (ev.type) {
    case "agent.boot":
      console.log(
        `${t} ready ${ev.address.slice(0, 10)}…${ev.ensName ? ` (${ev.ensName})` : ""}`,
      );
      break;
    case "agent.shutdown":
      console.log(`${t} shutdown`);
      break;
    case "discovery.search":
      console.log(
        `${t} gateway search taskDomain=${ev.query.taskDomain ?? "*"}`,
      );
      break;
    case "discovery.match":
      console.log(
        `${t}   ↳ ${ev.ensName}${ev.minBudget ? ` (minBudget=${ev.minBudget})` : ""}`,
      );
      break;
    case "negotiation.send":
      console.log(
        `${t} AXL → ${ev.verb}${ev.amount ? ` budget=${ev.amount}` : ""} → ${ev.counterpart.slice(0, 10)}…${ev.reason ? ` (${truncate(ev.reason, 80)})` : ""}`,
      );
      break;
    case "negotiation.receive":
      console.log(
        `${t} AXL ← ${ev.verb}${ev.amount ? ` budget=${ev.amount}` : ""} ← ${ev.counterpart.slice(0, 10)}…${ev.reason ? ` (${truncate(ev.reason, 80)})` : ""}`,
      );
      break;
    case "storage.upload":
      console.log(
        `${t} 0G Storage upload (${ev.kind}) root=${ev.rootHash.slice(0, 10)}… txSeq=${ev.txSeq}`,
      );
      break;
    case "storage.download":
      console.log(
        `${t} 0G Storage download (${ev.kind}) root=${ev.rootHash.slice(0, 10)}…`,
      );
      break;
    case "tx.sent":
      console.log(
        `${t} tx → ${ev.label} ${ev.txHash.slice(0, 10)}… (chain ${ev.chainId})`,
      );
      break;
    case "tx.confirmed":
      console.log(`${t} tx ✓ ${ev.label} ${ev.txHash.slice(0, 10)}…`);
      break;
    case "job.created":
      console.log(`${t} JobCreated id=${ev.jobId}`);
      break;
    case "job.funded":
      console.log(`${t} JobFunded id=${ev.jobId} budget=${ev.budget}`);
      break;
    case "job.submitted":
      console.log(
        `${t} JobSubmitted id=${ev.jobId} deliverable=${ev.deliverableRoot.slice(0, 10)}… (${ev.contentType})`,
      );
      break;
    case "job.delivered.provider-side":
      console.log(
        `${t} submit() id=${ev.jobId} deliverable=${ev.deliverableRoot.slice(0, 10)}… (${ev.contentType})`,
      );
      break;
    case "job.evaluated.evaluator-side":
      console.log(
        `${t} verdict id=${ev.jobId} approved=${ev.approved} score=${ev.score}`,
      );
      break;
    case "evaluator.evaluated":
      console.log(
        `${t} 0G Compute (${ev.modelId}) approved=${ev.approved} score=${ev.score} teeVerified=${ev.teeVerified}`,
      );
      break;
    case "job.settled":
      console.log(`${t} settle() id=${ev.jobId} approved=${ev.approved}`);
      break;
    case "job.settled.client-side":
      console.log(
        `${t} JobCompleted id=${ev.jobId} approved=${ev.approved} finalState=${ev.finalState}`,
      );
      break;
    case "llm.thinking":
      // Suppress — too chatty for the CLI.
      break;
    case "llm.decided":
      if (
        ev.purpose === "pick-domain" ||
        ev.purpose === "decide" ||
        ev.purpose === "rank-providers"
      ) {
        console.log(
          `${t} LLM (${ev.purpose}) ${truncate(JSON.stringify(ev.output), 120)}`,
        );
      }
      break;
    case "log":
      if (ev.level !== "info") console.log(`${t} ${ev.level} ${ev.message}`);
      break;
    case "agent.error":
      console.error(`${t} error ${ev.message}`);
      break;
    default:
      // Falls through silently. Uncomment to debug:
      // console.log(`${t} ${ev.type}`);
      break;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
