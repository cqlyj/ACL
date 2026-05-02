import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, encodeFunctionData, namehash, toFunctionSelector } from "viem";
import {
  RESOLVER_SELECTORS,
  decodeResolverCall,
  encodeAddrResult,
  encodeBytesResult,
  encodeTextResult,
} from "./resolver-call.js";

const NODE = namehash("researcher.acl.eth");

describe("resolver selectors", () => {
  test("match the canonical ENS resolver function selectors", () => {
    // Cast to plain string on both sides — the constants are literally
    // typed (e.g. `'0x3b3b57de'`) so a structural equality test against
    // viem's `0x${string}` would reject the comparison at the type
    // checker even though the runtime values match.
    expect(String(RESOLVER_SELECTORS.addr)).toBe(
      toFunctionSelector("function addr(bytes32) view returns (address)"),
    );
    expect(String(RESOLVER_SELECTORS.addrMulticoin)).toBe(
      toFunctionSelector("function addr(bytes32, uint256) view returns (bytes)"),
    );
    expect(String(RESOLVER_SELECTORS.text)).toBe(
      toFunctionSelector("function text(bytes32, string) view returns (string)"),
    );
    expect(String(RESOLVER_SELECTORS.contenthash)).toBe(
      toFunctionSelector("function contenthash(bytes32) view returns (bytes)"),
    );
  });
});

describe("decodeResolverCall", () => {
  test("decodes addr(bytes32)", () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "addr",
          stateMutability: "view",
          inputs: [{ type: "bytes32", name: "node" }],
          outputs: [{ type: "address" }],
        },
      ],
      functionName: "addr",
      args: [NODE],
    });
    const decoded = decodeResolverCall(data);
    expect(decoded.kind).toBe("addr");
    if (decoded.kind === "addr") expect(decoded.node).toBe(NODE);
  });

  test("decodes addr(bytes32,uint256) with the supplied coinType", () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "addr",
          stateMutability: "view",
          inputs: [
            { type: "bytes32", name: "node" },
            { type: "uint256", name: "coinType" },
          ],
          outputs: [{ type: "bytes" }],
        },
      ],
      functionName: "addr",
      args: [NODE, 60n],
    });
    const decoded = decodeResolverCall(data);
    expect(decoded.kind).toBe("addrMulticoin");
    if (decoded.kind === "addrMulticoin") {
      expect(decoded.node).toBe(NODE);
      expect(decoded.coinType).toBe(60n);
    }
  });

  test("decodes text(bytes32,string)", () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "text",
          stateMutability: "view",
          inputs: [
            { type: "bytes32", name: "node" },
            { type: "string", name: "key" },
          ],
          outputs: [{ type: "string" }],
        },
      ],
      functionName: "text",
      args: [NODE, "acl.axl-peer-id"],
    });
    const decoded = decodeResolverCall(data);
    expect(decoded.kind).toBe("text");
    if (decoded.kind === "text") {
      expect(decoded.node).toBe(NODE);
      expect(decoded.key).toBe("acl.axl-peer-id");
    }
  });

  test("decodes contenthash(bytes32)", () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "contenthash",
          stateMutability: "view",
          inputs: [{ type: "bytes32", name: "node" }],
          outputs: [{ type: "bytes" }],
        },
      ],
      functionName: "contenthash",
      args: [NODE],
    });
    const decoded = decodeResolverCall(data);
    expect(decoded.kind).toBe("contenthash");
    if (decoded.kind === "contenthash") expect(decoded.node).toBe(NODE);
  });

  test("returns kind=unknown for other selectors", () => {
    // pubkey(bytes32) is a real ENSIP-1 selector we don't implement.
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "pubkey",
          stateMutability: "view",
          inputs: [{ type: "bytes32", name: "node" }],
          outputs: [{ type: "bytes32" }, { type: "bytes32" }],
        },
      ],
      functionName: "pubkey",
      args: [NODE],
    });
    const decoded = decodeResolverCall(data);
    expect(decoded.kind).toBe("unknown");
  });
});

describe("result encoders match the resolver ABI", () => {
  test("encodeAddrResult is `abi.encode(address)`", () => {
    const out = encodeAddrResult("0xa38d4fa8de96C0284a079B10d27A68c8C15C3dd6");
    const [decoded] = decodeAbiParameters([{ type: "address" }], out);
    expect((decoded as string).toLowerCase()).toBe("0xa38d4fa8de96c0284a079b10d27a68c8c15c3dd6");
  });

  test("encodeTextResult is `abi.encode(string)`", () => {
    const out = encodeTextResult("hello");
    const [decoded] = decodeAbiParameters([{ type: "string" }], out);
    expect(decoded).toBe("hello");
  });

  test("encodeBytesResult is `abi.encode(bytes)`", () => {
    const out = encodeBytesResult("0xdeadbeef");
    const [decoded] = decodeAbiParameters([{ type: "bytes" }], out);
    expect(decoded).toBe("0xdeadbeef");
  });
});
