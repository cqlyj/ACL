import { describe, expect, test } from "bun:test";

import { INFT_SALE_CAPABILITY_KEYS, parseInftSaleCapability } from "./inft-sale-capability.js";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x3333333333333333333333333333333333333333";

describe("INFT_SALE_CAPABILITY_KEYS", () => {
  test("matches the exact wire keys the smart contracts and example app use", () => {
    expect(INFT_SALE_CAPABILITY_KEYS).toEqual({
      contract: "acl.cap.inft-sale.contract",
      tokenId: "acl.cap.inft-sale.token-id",
      minPrice: "acl.cap.inft-sale.min-price",
      paymentToken: "acl.cap.inft-sale.payment-token",
      verifier: "acl.cap.inft-sale.verifier",
    });
  });
});

describe("parseInftSaleCapability", () => {
  test("returns null for undefined / empty extra maps", () => {
    expect(parseInftSaleCapability(undefined)).toBeNull();
    expect(parseInftSaleCapability({})).toBeNull();
  });

  test("returns null when any of the three required fields is missing", () => {
    expect(
      parseInftSaleCapability({
        [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
        [INFT_SALE_CAPABILITY_KEYS.tokenId]: "7",
        // min-price intentionally missing
      }),
    ).toBeNull();
    expect(
      parseInftSaleCapability({
        [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
        [INFT_SALE_CAPABILITY_KEYS.minPrice]: "100",
        // token-id intentionally missing
      }),
    ).toBeNull();
    expect(
      parseInftSaleCapability({
        [INFT_SALE_CAPABILITY_KEYS.tokenId]: "7",
        [INFT_SALE_CAPABILITY_KEYS.minPrice]: "100",
        // contract intentionally missing
      }),
    ).toBeNull();
  });

  test("returns null when contract is not a valid address", () => {
    expect(
      parseInftSaleCapability({
        [INFT_SALE_CAPABILITY_KEYS.contract]: "not-an-address",
        [INFT_SALE_CAPABILITY_KEYS.tokenId]: "7",
        [INFT_SALE_CAPABILITY_KEYS.minPrice]: "100",
      }),
    ).toBeNull();
  });

  test("returns null when tokenId / minPrice are non-numeric strings", () => {
    expect(
      parseInftSaleCapability({
        [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
        [INFT_SALE_CAPABILITY_KEYS.tokenId]: "seven",
        [INFT_SALE_CAPABILITY_KEYS.minPrice]: "100",
      }),
    ).toBeNull();
  });

  test("happy path: returns checksummed addresses + bigints, payment/verifier nullable", () => {
    const cap = parseInftSaleCapability({
      [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
      [INFT_SALE_CAPABILITY_KEYS.tokenId]: "12",
      [INFT_SALE_CAPABILITY_KEYS.minPrice]: "25000000",
    });
    expect(cap).not.toBeNull();
    if (!cap) throw new Error("unreachable");
    expect(cap.contract).toBe(CONTRACT);
    expect(cap.tokenId).toBe(12n);
    expect(cap.minPrice).toBe(25_000_000n);
    expect(cap.paymentToken).toBeNull();
    expect(cap.verifier).toBeNull();
  });

  test("optional paymentToken / verifier are surfaced when valid, null when malformed", () => {
    const ok = parseInftSaleCapability({
      [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
      [INFT_SALE_CAPABILITY_KEYS.tokenId]: "1",
      [INFT_SALE_CAPABILITY_KEYS.minPrice]: "1",
      [INFT_SALE_CAPABILITY_KEYS.paymentToken]: TOKEN,
      [INFT_SALE_CAPABILITY_KEYS.verifier]: VERIFIER,
    });
    expect(ok?.paymentToken).toBe(TOKEN);
    expect(ok?.verifier).toBe(VERIFIER);

    const dropped = parseInftSaleCapability({
      [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
      [INFT_SALE_CAPABILITY_KEYS.tokenId]: "1",
      [INFT_SALE_CAPABILITY_KEYS.minPrice]: "1",
      [INFT_SALE_CAPABILITY_KEYS.paymentToken]: "garbage",
      [INFT_SALE_CAPABILITY_KEYS.verifier]: 12345,
    });
    expect(dropped?.paymentToken).toBeNull();
    expect(dropped?.verifier).toBeNull();
  });

  test("coerces JSON-number / bigint forms of tokenId + minPrice", () => {
    const cap = parseInftSaleCapability({
      [INFT_SALE_CAPABILITY_KEYS.contract]: CONTRACT,
      [INFT_SALE_CAPABILITY_KEYS.tokenId]: 7,
      [INFT_SALE_CAPABILITY_KEYS.minPrice]: 100n,
    });
    expect(cap?.tokenId).toBe(7n);
    expect(cap?.minPrice).toBe(100n);
  });
});
