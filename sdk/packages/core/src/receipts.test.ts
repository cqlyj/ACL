import { describe, expect, it, mock } from "bun:test";
import type { PublicClient, TransactionReceipt } from "viem";
import {
  DEFAULT_RECEIPT_POLLING_MS,
  DEFAULT_RECEIPT_TIMEOUT_MS,
  waitForReceiptResilient,
} from "./receipts.js";

function _mockClient(impls: Array<() => Promise<unknown>>): {
  client: PublicClient;
  calls: () => number;
} {
  let i = 0;
  const calls = () => i;
  const client = {
    getTransactionReceipt: mock(async () => {
      const fn = impls[i] ?? impls[impls.length - 1];
      i += 1;
      return fn?.();
    }),
  } as unknown as PublicClient;
  return { client, calls };
}

const _stubReceipt = (hash: string) => ({ transactionHash: hash }) as unknown as TransactionReceipt;

describe("waitForReceiptResilient", () => {
  it("returns the receipt as soon as `getTransactionReceipt` resolves", async () => {
    const receipt = _stubReceipt("0xabc");
    const { client, calls } = _mockClient([async () => receipt]);
    const got = await waitForReceiptResilient(client, "0xabc", {
      timeoutMs: 1_000,
      pollingIntervalMs: 10,
    });
    expect(got).toBe(receipt);
    expect(calls()).toBe(1);
  });

  it("retries while `getTransactionReceipt` rejects, then returns", async () => {
    const receipt = _stubReceipt("0xfeed");
    const { client, calls } = _mockClient([
      async () => {
        throw new Error("TransactionReceiptNotFoundError");
      },
      async () => {
        throw new Error("TransactionReceiptNotFoundError");
      },
      async () => receipt,
    ]);
    const got = await waitForReceiptResilient(client, "0xfeed", {
      timeoutMs: 5_000,
      pollingIntervalMs: 5,
    });
    expect(got).toBe(receipt);
    expect(calls()).toBe(3);
  });

  it("throws the last underlying error when the deadline elapses", async () => {
    const { client } = _mockClient([
      async () => {
        throw new Error("persistent RPC failure");
      },
    ]);
    await expect(
      waitForReceiptResilient(client, "0xdead", {
        timeoutMs: 30,
        pollingIntervalMs: 5,
      }),
    ).rejects.toThrow(/persistent RPC failure/);
  });

  it("exposes tolerant defaults for slow public RPC", () => {
    expect(DEFAULT_RECEIPT_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_RECEIPT_POLLING_MS).toBe(2_000);
  });
});
