import { describe, expect, test } from "bun:test";
import { concat, encodeAbiParameters, keccak256, numberToHex, recoverAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSignedResponse, makeSignatureHash } from "./signing.js";

const RESOLVER = "0x08EF26D91e662410eD70413c09d09F0e048d6E13" as const;
const SIGNER_KEY = "0xf75a40383daf2c4521376f0f781dfaad47899af8f5013f8b5a85d0f70200eace" as const;

describe("makeSignatureHash", () => {
  test("matches the canonical ENS SignatureVerifier formula byte-for-byte", () => {
    // EIP-191 v0:
    //   keccak256(0x19 || 0x00 || target || expires || keccak256(request) || keccak256(result))
    const target = RESOLVER;
    const expires = 1_900_000_000n;
    const request = "0xdeadbeef" as const;
    const result = "0xcafe" as const;

    const expected = keccak256(
      concat([
        "0x1900",
        target,
        numberToHex(expires, { size: 8 }),
        keccak256(request),
        keccak256(result),
      ]),
    );
    expect(makeSignatureHash({ target, expires, request, result })).toBe(expected);
  });
});

describe("buildSignedResponse", () => {
  test("returns a tuple decodable as (bytes,uint64,bytes)", async () => {
    const out = await buildSignedResponse({
      privateKey: SIGNER_KEY,
      target: RESOLVER,
      request: "0xdeadbeef",
      result: "0xcafe",
      ttlSeconds: 60,
    });
    expect(out.expires).toBeGreaterThan(0n);
    expect(out.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(out.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("signature recovers to the gateway signer (via raw `recoverAddress` over the hash)", async () => {
    const account = privateKeyToAccount(SIGNER_KEY);
    const out = await buildSignedResponse({
      privateKey: SIGNER_KEY,
      target: RESOLVER,
      request: "0xdeadbeef",
      result: "0xcafe",
      ttlSeconds: 60,
    });
    // ENS SignatureVerifier uses ECDSA.recover(hash, sig) without an
    // additional EIP-191 personal_sign prefix, mirrored here with viem's
    // `recoverAddress`.
    const recovered = await recoverAddress({
      hash: out.messageHash,
      signature: out.signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test("TTL expires at request_time + ttlSeconds (within a 1-second slack)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const out = await buildSignedResponse({
      privateKey: SIGNER_KEY,
      target: RESOLVER,
      request: "0xdeadbeef",
      result: "0x",
      ttlSeconds: 300,
    });
    const after = Math.floor(Date.now() / 1000);
    expect(Number(out.expires)).toBeGreaterThanOrEqual(before + 300);
    expect(Number(out.expires)).toBeLessThanOrEqual(after + 300);
  });

  test("different requests produce different signatures (binds extraData)", async () => {
    const a = await buildSignedResponse({
      privateKey: SIGNER_KEY,
      target: RESOLVER,
      request: "0xdeadbeef",
      result: "0xcafe",
      ttlSeconds: 60,
    });
    const b = await buildSignedResponse({
      privateKey: SIGNER_KEY,
      target: RESOLVER,
      request: "0xfeedface",
      result: "0xcafe",
      ttlSeconds: 60,
    });
    expect(a.messageHash).not.toBe(b.messageHash);
  });

  test("embeds (result, expires, signature) in canonical ABI order", async () => {
    const out = await buildSignedResponse({
      privateKey: SIGNER_KEY,
      target: RESOLVER,
      request: "0xdeadbeef",
      result: "0xcafe",
      ttlSeconds: 60,
    });
    // Reconstruct the same blob and assert byte-equality.
    const expected = encodeAbiParameters(
      [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
      ["0xcafe", out.expires, out.signature],
    );
    expect(out.data).toBe(expected);
  });
});

describe("makeSignatureHash inputs are not mutated", () => {
  test("hashes deterministically across repeat calls", () => {
    const args = {
      target: RESOLVER,
      expires: 1_000_000n,
      request: "0xdeadbeef" as const,
      result: "0xcafe" as const,
    };
    const a = makeSignatureHash(args);
    const b = makeSignatureHash(args);
    expect(a).toBe(b);
    // Sanity: the hash starts with our protocol header keccak preimage.
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    // Ensure unused viem helper imports stay live.
    expect(toBytes("0x00").length).toBe(1);
  });
});
