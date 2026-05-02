import { describe, expect, test } from "bun:test";

import { INFT_SALE_HOOK_REASONS, INFT_SALE_HOOK_REASON_SELECTORS } from "./hook-reasons.js";

describe("INFT_SALE_HOOK_REASONS", () => {
  test("mirrors every error declared in INFTDeliveryHook.sol — order-stable", () => {
    expect(INFT_SALE_HOOK_REASONS).toEqual({
      OnlyCommerce: "OnlyCommerce",
      NoEscrowData: "NoEscrowData",
      NotDeposited: "NotDeposited",
      AlreadyDeposited: "AlreadyDeposited",
      JobNotRecoverable: "JobNotRecoverable",
      NotProvider: "NotProvider",
      MissingTransferProofs: "MissingTransferProofs",
    });
  });
});

describe("INFT_SALE_HOOK_REASON_SELECTORS", () => {
  test("has one selector per reason name and they're all 4-byte hex", () => {
    const names = Object.keys(INFT_SALE_HOOK_REASONS);
    expect(Object.keys(INFT_SALE_HOOK_REASON_SELECTORS).sort()).toEqual(names.sort());
    for (const sel of Object.values(INFT_SALE_HOOK_REASON_SELECTORS)) {
      expect(sel).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });

  test("selectors are mutually distinct (no two errors collide)", () => {
    const sels = Object.values(INFT_SALE_HOOK_REASON_SELECTORS);
    expect(new Set(sels).size).toBe(sels.length);
  });
});
