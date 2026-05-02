import { describe, expect, test } from "bun:test";

import { isRpcRangeLimitError } from "./rpc-errors.js";

describe("isRpcRangeLimitError", () => {
  test("returns false for null/undefined/empty", () => {
    expect(isRpcRangeLimitError(null)).toBe(false);
    expect(isRpcRangeLimitError(undefined)).toBe(false);
    expect(isRpcRangeLimitError(new Error(""))).toBe(false);
  });

  test("matches Alchemy-style 'eth_getLogs is limited' error", () => {
    expect(isRpcRangeLimitError(new Error("eth_getLogs is limited to a 500 block range"))).toBe(
      true,
    );
  });

  test("matches Infura-style 'block range' error", () => {
    expect(isRpcRangeLimitError(new Error("query block range too large"))).toBe(true);
  });

  test("matches QuickNode-style response-size cap", () => {
    expect(isRpcRangeLimitError(new Error("query returned more than 10000 results"))).toBe(true);
  });

  test("matches viem-shaped errors via `details` and `shortMessage`", () => {
    const err = {
      message: "RPC failed",
      details: "your request exceeds the limit of 1000 logs",
      shortMessage: "log query rejected",
    } as unknown;
    expect(isRpcRangeLimitError(err)).toBe(true);
  });

  test("does not match unrelated network errors", () => {
    expect(isRpcRangeLimitError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isRpcRangeLimitError(new Error("invalid signature"))).toBe(false);
    expect(isRpcRangeLimitError(new Error("Internal JSON-RPC error: timeout"))).toBe(false);
  });

  test("matches case-insensitively", () => {
    expect(isRpcRangeLimitError(new Error("ETH_GETLOGS IS LIMITED to 1000 blocks"))).toBe(true);
  });
});
