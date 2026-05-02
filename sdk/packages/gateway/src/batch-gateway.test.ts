import { describe, expect, test } from "bun:test";
import { decodeErrorResult, encodeFunctionData } from "viem";
import {
  BATCH_GATEWAY_HTTP_ERROR_ABI,
  BATCH_GATEWAY_QUERY_SELECTOR,
  decodeBatchGatewayQuery,
  encodeBatchGatewayResponse,
  encodeHttpError,
  encodeStringError,
  isBatchGatewayQuery,
} from "./batch-gateway.js";

const SAMPLE_REQUESTS = [
  {
    sender: "0x08EF26D91e662410eD70413c09d09F0e048d6E13" as const,
    urls: ["http://127.0.0.1:3000/{sender}/{data}.json"],
    data: "0xdeadbeef" as const,
  },
  {
    sender: "0xcafecafecafecafecafecafecafecafecafecafe" as const,
    urls: ["https://other.example/{sender}/{data}.json"],
    data: "0xfeedface" as const,
  },
] as const;

describe("BGOLP selector", () => {
  test("matches ENSIP-21 0xa780bab6", () => {
    expect(BATCH_GATEWAY_QUERY_SELECTOR).toBe("0xa780bab6");
  });
});

describe("isBatchGatewayQuery", () => {
  test("detects the canonical query selector", () => {
    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "query",
          inputs: [
            {
              name: "requests",
              type: "tuple[]",
              components: [
                { name: "sender", type: "address" },
                { name: "urls", type: "string[]" },
                { name: "data", type: "bytes" },
              ],
            },
          ],
          outputs: [
            { name: "failures", type: "bool[]" },
            { name: "responses", type: "bytes[]" },
          ],
        },
      ],
      functionName: "query",
      args: [SAMPLE_REQUESTS.map((r) => ({ ...r, urls: [...r.urls] }))],
    });
    expect(isBatchGatewayQuery(calldata)).toBe(true);
  });

  test("rejects unrelated calldata", () => {
    expect(isBatchGatewayQuery("0x12345678aabb")).toBe(false);
  });

  test("rejects truncated calldata", () => {
    expect(isBatchGatewayQuery("0x00")).toBe(false);
  });
});

describe("decodeBatchGatewayQuery", () => {
  test("round-trips encode→decode of multiple subrequests", () => {
    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "query",
          inputs: [
            {
              name: "requests",
              type: "tuple[]",
              components: [
                { name: "sender", type: "address" },
                { name: "urls", type: "string[]" },
                { name: "data", type: "bytes" },
              ],
            },
          ],
          outputs: [
            { name: "failures", type: "bool[]" },
            { name: "responses", type: "bytes[]" },
          ],
        },
      ],
      functionName: "query",
      args: [SAMPLE_REQUESTS.map((r) => ({ ...r, urls: [...r.urls] }))],
    });

    const decoded = decodeBatchGatewayQuery(calldata);
    expect(decoded.length).toBe(2);
    expect(decoded[0]?.sender.toLowerCase()).toBe(SAMPLE_REQUESTS[0]!.sender.toLowerCase());
    expect([...(decoded[1]?.urls ?? [])]).toEqual([...SAMPLE_REQUESTS[1]!.urls]);
    expect(decoded[0]?.data).toBe(SAMPLE_REQUESTS[0]!.data);
  });

  test("throws on a non-BGOLP selector", () => {
    expect(() => decodeBatchGatewayQuery("0x12345678")).toThrow();
  });
});

describe("encodeBatchGatewayResponse", () => {
  test("rejects mismatched failures/responses lengths", () => {
    expect(() => encodeBatchGatewayResponse([true], ["0x00", "0x01"])).toThrow();
  });

  test("produces non-empty output for a single subrequest", () => {
    const out = encodeBatchGatewayResponse([false], ["0xabcd"]);
    expect(out.startsWith("0x")).toBe(true);
    expect(out.length).toBeGreaterThan(2);
  });
});

describe("error encoding helpers", () => {
  test("encodeStringError produces a decodable Error(string)", () => {
    const blob = encodeStringError("boom");
    const decoded = decodeErrorResult({
      abi: [
        {
          type: "error",
          name: "Error",
          inputs: [{ name: "message", type: "string" }],
        },
      ],
      data: blob,
    });
    expect(decoded.errorName).toBe("Error");
    expect(decoded.args).toEqual(["boom"]);
  });

  test("encodeHttpError produces a decodable HttpError(uint16,string)", () => {
    const blob = encodeHttpError(504, "gateway timeout");
    const decoded = decodeErrorResult({
      abi: BATCH_GATEWAY_HTTP_ERROR_ABI,
      data: blob,
    });
    expect(decoded.errorName).toBe("HttpError");
    expect(decoded.args).toEqual([504, "gateway timeout"]);
  });
});
