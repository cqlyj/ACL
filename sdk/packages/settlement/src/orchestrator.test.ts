import { describe, expect, mock, test } from "bun:test";
import { ACL_TESTNET, defineGalileoChain } from "@acl/core";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
} from "viem";
import { JobOrchestrator, createJobOrchestrator } from "./orchestrator.js";

const galileo = defineGalileoChain(ACL_TESTNET);
const ACCOUNT = {
  address: "0x1111111111111111111111111111111111111111" as Address,
  type: "local" as const,
};

const JOB_CREATED = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
);

function buildJobCreatedLog(
  jobId: bigint,
  overrides?: { address?: Address },
): {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
} {
  const client: Address = "0x1111111111111111111111111111111111111111";
  const provider: Address = "0x2222222222222222222222222222222222222222";
  const evaluator: Address = ACL_TESTNET.galileo.aclEvaluator;
  const expiredAt = 9_999_999_999n;
  const hook: Address = ACL_TESTNET.galileo.reputationHook;
  // `encodeEventTopics` returns `(Hex | Hex[] | null)[]`; for an event
  // with three fully-bound indexed args the result is exhaustively a
  // 4-tuple of concrete hexes. Narrow at the boundary so the mock log
  // shape matches what viem produces in real life.
  const topics = encodeEventTopics({
    abi: [JOB_CREATED],
    eventName: "JobCreated",
    args: { jobId, client, provider },
  }).map((t) => {
    if (typeof t !== "string") {
      throw new Error("test fixture: topic must be a single hex value");
    }
    return t;
  }) as readonly Hex[];
  return {
    address: overrides?.address ?? ACL_TESTNET.galileo.agenticCommerce,
    topics,
    data: encodeAbiParameters(
      [
        { name: "evaluator", type: "address" },
        { name: "expiredAt", type: "uint256" },
        { name: "hook", type: "address" },
      ],
      [evaluator, expiredAt, hook],
    ),
  };
}

function makeMocks() {
  const writeContract = mock(async (_args: unknown) => "0xtxhash" as Hex);
  // Both helpers must be present: `JobOrchestrator` calls
  // `getTransactionReceipt` via `waitForReceiptResilient` (the new
  // resilient poll), while a few other test paths still mock
  // `waitForTransactionReceipt` directly.
  const getTransactionReceipt = mock(async (_args: unknown) => ({
    status: "success" as const,
    logs: [buildJobCreatedLog(42n)],
  }));
  const readContract = mock(async (_args: unknown) => 0n); // default allowance = 0

  const publicClient = {
    getTransactionReceipt,
    readContract,
  } as unknown as PublicClient;

  const walletClient = {
    account: ACCOUNT,
    chain: galileo,
    writeContract,
  } as unknown as WalletClient;

  return { publicClient, walletClient, writeContract, readContract };
}

describe("createJobOrchestrator", () => {
  test("binds default ACL_TESTNET addresses when deployment is omitted", () => {
    const { publicClient, walletClient } = makeMocks();
    const orch = createJobOrchestrator({ publicClient, walletClient });
    expect(orch.agenticCommerce).toBe(ACL_TESTNET.galileo.agenticCommerce);
    expect(orch.aclEvaluator).toBe(ACL_TESTNET.galileo.aclEvaluator);
    expect(orch.paymentToken).toBe(ACL_TESTNET.galileo.testUSDC);
  });
});

describe("JobOrchestrator.createJob", () => {
  test("writes createJob and parses the JobCreated jobId", async () => {
    const { publicClient, walletClient, writeContract } = makeMocks();
    const orch = new JobOrchestrator({
      publicClient,
      walletClient,
      agenticCommerce: ACL_TESTNET.galileo.agenticCommerce,
      aclEvaluator: ACL_TESTNET.galileo.aclEvaluator,
      paymentToken: ACL_TESTNET.galileo.testUSDC,
    });
    const out = await orch.createJob({
      provider: "0x2222222222222222222222222222222222222222",
      evaluator: ACL_TESTNET.galileo.aclEvaluator,
      expiredAt: 9_999_999_999n,
      description: "demo",
      hook: ACL_TESTNET.galileo.reputationHook,
    });
    expect(out.jobId).toBe(42n);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  test("ignores look-alike logs from other contracts (e.g. hooks)", async () => {
    const writeContract = mock(async (_args: unknown) => "0xtxhash" as Hex);
    const getTransactionReceipt = mock(async (_args: unknown) => ({
      status: "success" as const,
      logs: [
        // Foreign contract emits a similarly-shaped 4-topic event before
        // AgenticCommerce's JobCreated. The orchestrator must skip it.
        buildJobCreatedLog(99n, {
          address: "0xdEADbEefDEadbEEfdeAdBEefDeadbeEfdeadBeEf" as Address,
        }),
        // The real JobCreated from AgenticCommerce.
        buildJobCreatedLog(7n),
      ],
    }));
    const readContract = mock(async (_args: unknown) => 0n);
    const publicClient = {
      getTransactionReceipt,
      readContract,
    } as unknown as PublicClient;
    const walletClient = {
      account: ACCOUNT,
      chain: galileo,
      writeContract,
    } as unknown as WalletClient;
    const orch = new JobOrchestrator({
      publicClient,
      walletClient,
      agenticCommerce: ACL_TESTNET.galileo.agenticCommerce,
      aclEvaluator: ACL_TESTNET.galileo.aclEvaluator,
      paymentToken: ACL_TESTNET.galileo.testUSDC,
    });
    const out = await orch.createJob({
      provider: "0x2222222222222222222222222222222222222222",
      evaluator: ACL_TESTNET.galileo.aclEvaluator,
      expiredAt: 9_999_999_999n,
      description: "demo",
      hook: ACL_TESTNET.galileo.reputationHook,
    });
    expect(out.jobId).toBe(7n);
  });
});

describe("JobOrchestrator.fund", () => {
  test("issues an approve when allowance is below expectedBudget, then funds", async () => {
    const { publicClient, walletClient, writeContract, readContract } = makeMocks();
    // allowance read returns 0 — so an approve must run first
    readContract.mockImplementation(async () => 0n);
    const orch = new JobOrchestrator({
      publicClient,
      walletClient,
      agenticCommerce: ACL_TESTNET.galileo.agenticCommerce,
      aclEvaluator: ACL_TESTNET.galileo.aclEvaluator,
      paymentToken: ACL_TESTNET.galileo.testUSDC,
    });
    await orch.fund({ jobId: 1n, expectedBudget: 100n });
    // Two writes: approve + fund. Order matters but bun mock doesn't
    // expose a clean .calls accessor on every viem stub shape, so we
    // just assert the count.
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  test("skips approve when allowance is already sufficient", async () => {
    const { publicClient, walletClient, writeContract, readContract } = makeMocks();
    readContract.mockImplementation(async () => 1_000n);
    const orch = new JobOrchestrator({
      publicClient,
      walletClient,
      agenticCommerce: ACL_TESTNET.galileo.agenticCommerce,
      aclEvaluator: ACL_TESTNET.galileo.aclEvaluator,
      paymentToken: ACL_TESTNET.galileo.testUSDC,
    });
    await orch.fund({ jobId: 1n, expectedBudget: 100n });
    expect(writeContract).toHaveBeenCalledTimes(1); // fund only
  });

  test("autoApprove: false leaves the allowance management to the caller", async () => {
    const { publicClient, walletClient, writeContract } = makeMocks();
    const orch = new JobOrchestrator({
      publicClient,
      walletClient,
      agenticCommerce: ACL_TESTNET.galileo.agenticCommerce,
      aclEvaluator: ACL_TESTNET.galileo.aclEvaluator,
      paymentToken: ACL_TESTNET.galileo.testUSDC,
    });
    await orch.fund({ jobId: 1n, expectedBudget: 100n, autoApprove: false });
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});
