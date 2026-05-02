import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";

import { normalizeAddress } from "./normalize.js";

// EIP-55 mixed-case form vs the same address in pure lowercase.
const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";
const LOWERCASE = CHECKSUMMED.toLowerCase();

describe("normalizeAddress", () => {
  test("re-checksums a lowercased valid address", () => {
    const got = normalizeAddress(LOWERCASE);
    expect(got).toBe(CHECKSUMMED);
  });

  test("returns checksummed input verbatim", () => {
    const got = normalizeAddress(CHECKSUMMED);
    expect(got).toBe(CHECKSUMMED);
  });

  test("returns null for the empty string", () => {
    expect(normalizeAddress("")).toBeNull();
  });

  test("returns null for non-hex / wrong-length input", () => {
    expect(normalizeAddress("not-an-address")).toBeNull();
    // 0x + 39 hex chars (one short of the 40 required for a 20-byte address).
    expect(normalizeAddress(`0x${"a".repeat(39)}`)).toBeNull();
    // 0x + 41 hex chars (one too many).
    expect(normalizeAddress(`0x${"a".repeat(41)}`)).toBeNull();
  });

  test("matches viem.getAddress on every valid input", () => {
    expect(normalizeAddress(LOWERCASE)).toBe(getAddress(LOWERCASE));
    expect(normalizeAddress(CHECKSUMMED)).toBe(getAddress(CHECKSUMMED));
  });
});
