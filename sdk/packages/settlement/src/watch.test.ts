import { describe, expect, mock, test } from "bun:test";
import { ACL_TESTNET } from "@acl/core";
import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  encodeEventTopics,
} from "viem";

import { JOB_COMPLETED_EVENT, JOB_REJECTED_EVENT, JOB_SUBMITTED_EVENT } from "./events.js";
import { type JobLifecycleEvent, watchJobLifecycle } from "./watch.js";

const ZERO32: Hex = `0x${"00".repeat(32)}`;

function jobSubmittedLog(jobId: bigint, deliverable: Hex = ZERO32) {
  const provider: Address = "0x2222222222222222222222222222222222222222";
  const topics = encodeEventTopics({
    abi: [JOB_SUBMITTED_EVENT],
    eventName: "JobSubmitted",
    args: { jobId, provider },
  }) as Hex[];
  return {
    address: ACL_TESTNET.galileo.agenticCommerce as Address,
    topics,
    data: encodeAbiParameters([{ type: "bytes32" }], [deliverable]),
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: "0xaaaa" as Hex,
  };
}

function jobCompletedLog(jobId: bigint, reason: Hex = ZERO32) {
  const evaluator: Address = ACL_TESTNET.galileo.aclEvaluator;
  const topics = encodeEventTopics({
    abi: [JOB_COMPLETED_EVENT],
    eventName: "JobCompleted",
    args: { jobId, evaluator },
  }) as Hex[];
  return {
    address: ACL_TESTNET.galileo.agenticCommerce as Address,
    topics,
    data: encodeAbiParameters([{ type: "bytes32" }], [reason]),
    blockNumber: 101n,
    logIndex: 0,
    transactionHash: "0xbbbb" as Hex,
  };
}

function jobRejectedLog(jobId: bigint, reason: Hex = ZERO32) {
  const rejector: Address = "0x3333333333333333333333333333333333333333";
  const topics = encodeEventTopics({
    abi: [JOB_REJECTED_EVENT],
    eventName: "JobRejected",
    args: { jobId, rejector },
  }) as Hex[];
  return {
    address: ACL_TESTNET.galileo.agenticCommerce as Address,
    topics,
    data: encodeAbiParameters([{ type: "bytes32" }], [reason]),
    blockNumber: 102n,
    logIndex: 0,
    transactionHash: "0xcccc" as Hex,
  };
}

/**
 * Minimal `PublicClient` stub that returns supplied logs verbatim
 * keyed off the AbiEvent's topic0 (the SDK calls `getLogs(...)` once
 * per event type per poll cycle).
 */
function makePublicClient(args: {
  initialBlock: bigint;
  logsByTopic0: Record<Hex, ReturnType<typeof jobSubmittedLog>[]>;
}): PublicClient {
  let block = args.initialBlock;
  return {
    getBlockNumber: mock(async () => {
      block += 1n;
      return block;
    }),
    getLogs: mock(async (params: { event: { type: "event"; name: string } }) => {
      const topic0 = encodeEventTopics({
        abi: [params.event as never],
        eventName: params.event.name,
      })[0] as Hex;
      return args.logsByTopic0[topic0] ?? [];
    }),
  } as unknown as PublicClient;
}

describe("watchJobLifecycle - events filter", () => {
  test("only polls events in the filter (no eth_getLogs for unsubscribed)", async () => {
    const submittedTopic = encodeEventTopics({
      abi: [JOB_SUBMITTED_EVENT],
      eventName: "JobSubmitted",
    })[0] as Hex;
    const completedTopic = encodeEventTopics({
      abi: [JOB_COMPLETED_EVENT],
      eventName: "JobCompleted",
    })[0] as Hex;

    const publicClient = makePublicClient({
      initialBlock: 50n,
      logsByTopic0: {
        [submittedTopic]: [jobSubmittedLog(1n, `0x${"de".repeat(32)}` as Hex)],
        [completedTopic]: [jobCompletedLog(1n, `0x${"be".repeat(32)}` as Hex)],
      },
    });

    const events: JobLifecycleEvent[] = [];
    for await (const ev of watchJobLifecycle(1n, {
      publicClient,
      pollIntervalMs: 1,
      events: ["JobSubmitted"],
      timeoutMs: 1_000,
    })) {
      events.push(ev);
      // We only filtered for `JobSubmitted` (non-terminal-when-filtered),
      // so the watcher would loop forever if we didn't break.
      if (events.length >= 1) break;
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("JobSubmitted");

    // Crucial: `getLogs` must NOT have been called for any of the
    // five non-filtered events. Inspect the mock call records.
    const getLogsMock = publicClient.getLogs as unknown as {
      mock: { calls: Array<[{ event: { name: string } }]> };
    };
    const calledFor = new Set(getLogsMock.mock.calls.map((c) => c[0].event.name));
    expect(calledFor.size).toBe(1);
    expect(calledFor.has("JobSubmitted")).toBe(true);
  });

  test("filtered terminal event still ends the iterator", async () => {
    const submittedTopic = encodeEventTopics({
      abi: [JOB_SUBMITTED_EVENT],
      eventName: "JobSubmitted",
    })[0] as Hex;
    const completedTopic = encodeEventTopics({
      abi: [JOB_COMPLETED_EVENT],
      eventName: "JobCompleted",
    })[0] as Hex;
    const rejectedTopic = encodeEventTopics({
      abi: [JOB_REJECTED_EVENT],
      eventName: "JobRejected",
    })[0] as Hex;

    const publicClient = makePublicClient({
      initialBlock: 50n,
      logsByTopic0: {
        [submittedTopic]: [jobSubmittedLog(1n)],
        [completedTopic]: [jobCompletedLog(1n)],
        [rejectedTopic]: [],
      },
    });

    const events: JobLifecycleEvent[] = [];
    for await (const ev of watchJobLifecycle(1n, {
      publicClient,
      pollIntervalMs: 1,
      events: ["JobSubmitted", "JobCompleted", "JobRejected"],
      timeoutMs: 2_000,
    })) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual(["JobSubmitted", "JobCompleted"]);
  });
});

describe("watchJobLifecycle - timeoutMs", () => {
  test("throws after `timeoutMs` ms when no terminal event lands", async () => {
    // No logs at all — the watcher must hit its internal abort timer.
    const publicClient = makePublicClient({
      initialBlock: 0n,
      logsByTopic0: {},
    });

    const start = Date.now();
    let threw = false;
    try {
      for await (const _ of watchJobLifecycle(1n, {
        publicClient,
        pollIntervalMs: 5,
        events: ["JobCompleted"],
        timeoutMs: 80,
      })) {
        // unreachable
      }
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/timed out after 80ms/);
    }
    const elapsed = Date.now() - start;
    expect(threw).toBe(true);
    // Allow a generous slack for CI; we mainly want to ensure the
    // timer actually fires rather than the test sitting at 30s.
    expect(elapsed).toBeLessThan(2_000);
  });
});
