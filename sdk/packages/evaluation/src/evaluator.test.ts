import { describe, expect, test } from "bun:test";

// We exercise only the prompt-injection guardrail and the strict-JSON
// parser here — both are pure functions inside evaluator.ts. Live 0G
// Compute calls are covered by the example app under `examples/`.
import {
  DEFAULT_EVALUATOR_SYSTEM_PROMPT,
  isBrokerNotFoundSentinel,
} from "./evaluator.js";

describe("DEFAULT_EVALUATOR_SYSTEM_PROMPT", () => {
  test("forces strict JSON output with the four required keys", () => {
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT).toContain("approved");
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT).toContain("score");
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT).toContain("summary");
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT).toContain("reasoning");
  });

  test("warns the model not to follow injected instructions", () => {
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT.toLowerCase()).toContain("prompt-injection");
  });

  test("forbids markdown / code fences in the output", () => {
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT).toMatch(/no markdown/i);
    expect(DEFAULT_EVALUATOR_SYSTEM_PROMPT).toMatch(/no code fences/i);
  });
});

describe("isBrokerNotFoundSentinel", () => {
  // Sentinel strings are pinned by @0glabs/0g-serving-broker
  // error-handler.js (lines 35, 39) at version ^0.7.5. If these tests
  // start failing it almost certainly means the broker bumped its
  // human-readable error messages — see the JSDoc on the function.
  const ledgerSentinel = new Error(
    'Account does not exist. Please create an account first using "add-account".',
  );
  const subAccountSentinel = new Error(
    'Sub-account not found. Initialize it by transferring funds via "transfer-fund"',
  );

  test("matches the ledger 'not exists' sentinel", () => {
    expect(isBrokerNotFoundSentinel(ledgerSentinel, "ledger")).toBe(true);
  });

  test("matches the sub-account 'not found' sentinel", () => {
    expect(isBrokerNotFoundSentinel(subAccountSentinel, "subaccount")).toBe(true);
  });

  test("does NOT cross-match (ledger sentinel against subaccount kind)", () => {
    expect(isBrokerNotFoundSentinel(ledgerSentinel, "subaccount")).toBe(false);
    expect(isBrokerNotFoundSentinel(subAccountSentinel, "ledger")).toBe(false);
  });

  test("returns false for transient broker / RPC failures (must rethrow)", () => {
    const transient = new Error("network: ECONNRESET");
    expect(isBrokerNotFoundSentinel(transient, "ledger")).toBe(false);
    expect(isBrokerNotFoundSentinel(transient, "subaccount")).toBe(false);
  });

  test("returns false for non-string `message` shapes", () => {
    expect(isBrokerNotFoundSentinel({ message: 12345 }, "ledger")).toBe(false);
    expect(isBrokerNotFoundSentinel({ message: undefined }, "subaccount")).toBe(false);
    expect(isBrokerNotFoundSentinel(null, "ledger")).toBe(false);
    expect(isBrokerNotFoundSentinel(undefined, "subaccount")).toBe(false);
  });
});
