import { describe, expect, test } from "bun:test";
import { pickOpeningBudget } from "./client.js";

describe("pickOpeningBudget", () => {
  test("defaults to the midpoint of [providerMinBudget, maxBudget]", () => {
    expect(
      pickOpeningBudget({
        maxBudget: 100_000_000n,
        providerMinBudget: 50_000_000n,
      }),
    ).toBe(75_000_000n);
  });

  test("rounds the midpoint down for odd-sum ranges", () => {
    // (50 + 101) / 2 = 75.5 -> 75 (bigint floor division)
    expect(
      pickOpeningBudget({
        maxBudget: 101n,
        providerMinBudget: 50n,
      }),
    ).toBe(75n);
  });

  test("returns providerMinBudget when min == max", () => {
    expect(
      pickOpeningBudget({
        maxBudget: 42n,
        providerMinBudget: 42n,
      }),
    ).toBe(42n);
  });

  test("honours an explicit openingBudget within range", () => {
    expect(
      pickOpeningBudget({
        maxBudget: 100n,
        providerMinBudget: 10n,
        openingBudget: 25n,
      }),
    ).toBe(25n);
  });

  test("allows openingBudget at the lower bound", () => {
    expect(
      pickOpeningBudget({
        maxBudget: 100n,
        providerMinBudget: 10n,
        openingBudget: 10n,
      }),
    ).toBe(10n);
  });

  test("allows openingBudget at the upper bound (max-out by choice)", () => {
    expect(
      pickOpeningBudget({
        maxBudget: 100n,
        providerMinBudget: 10n,
        openingBudget: 100n,
      }),
    ).toBe(100n);
  });

  test("throws when openingBudget is below providerMinBudget", () => {
    expect(() =>
      pickOpeningBudget({
        maxBudget: 100n,
        providerMinBudget: 10n,
        openingBudget: 9n,
      }),
    ).toThrow(/openingBudget \(9\) must lie in \[10, 100\]/);
  });

  test("throws when openingBudget is above maxBudget", () => {
    expect(() =>
      pickOpeningBudget({
        maxBudget: 100n,
        providerMinBudget: 10n,
        openingBudget: 101n,
      }),
    ).toThrow(/openingBudget \(101\) must lie in \[10, 100\]/);
  });

  test("throws when maxBudget is below providerMinBudget", () => {
    // Defensive: the ClientAgent rejects this earlier with a friendlier
    // error, but the helper itself must also refuse to produce a result
    // outside the legal range.
    expect(() =>
      pickOpeningBudget({
        maxBudget: 5n,
        providerMinBudget: 10n,
      }),
    ).toThrow(/maxBudget \(5\) below providerMinBudget \(10\)/);
  });
});
