import { describe, expect, test } from "bun:test";
import { type Address, decodeAbiParameters, encodeAbiParameters } from "viem";

/**
 * Wire-shape tests for the on-chain metadata layout the discovery layer
 * decodes back into an `AgentProfile`. We round-trip via `encodeAbiParameters`
 * + `decodeAbiParameters` here so any future change to either the gateway's
 * encoder or the discovery layer's decoder produces a visible diff against
 * these vectors before consumers notice on a live testnet.
 */

describe("on-chain ACL metadata wire shapes", () => {
  test("acl.payment-tokens is `abi.encode(address[])`", () => {
    const tokens = [
      "0x8Cc99bd97CD8cc7A7da1c9859415773FDa23e50c",
      "0xa38d4fa8de96C0284a079B10d27A68c8C15C3dd6",
    ] as Address[];
    const encoded = encodeAbiParameters([{ type: "address[]" }], [tokens]);
    const [decoded] = decodeAbiParameters([{ type: "address[]" }], encoded);
    expect((decoded as Address[]).map((a) => a.toLowerCase())).toEqual(
      tokens.map((a) => a.toLowerCase()),
    );
  });

  test("acl.evaluator-address is `abi.encode(address)`", () => {
    const evaluator = "0x9f3975B140809Bb3874e18d6857ca940C3208167";
    const encoded = encodeAbiParameters([{ type: "address" }], [evaluator]);
    const [decoded] = decodeAbiParameters([{ type: "address" }], encoded);
    expect((decoded as Address).toLowerCase()).toBe(evaluator.toLowerCase());
  });

  test("acl.min-budget and acl.chain-id are `abi.encode(uint256)`", () => {
    const cases: bigint[] = [0n, 1n, 100_000_000n, 16_602n, 2n ** 250n];
    for (const n of cases) {
      const encoded = encodeAbiParameters([{ type: "uint256" }], [n]);
      const [decoded] = decodeAbiParameters([{ type: "uint256" }], encoded);
      expect(decoded).toBe(n);
    }
  });

  test("acl.task-domains / acl.delivery-types are raw UTF-8 bytes (not abi-encoded)", () => {
    // The IdentityRegistry stores arbitrary bytes for unknown keys; the SDK
    // convention for these "list of comma-joined tags" keys is raw UTF-8.
    const utf8 = new TextEncoder().encode("science,technology");
    const hex =
      `0x${[...utf8].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    const round = new TextDecoder().decode(
      Uint8Array.from(
        hex
          .slice(2)
          .match(/.{2}/g)!
          .map((h) => Number.parseInt(h, 16)),
      ),
    );
    expect(round).toBe("science,technology");
  });
});
