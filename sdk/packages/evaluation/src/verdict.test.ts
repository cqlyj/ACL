import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import type { EvaluationResult } from "./types.js";
import { buildAttestationBundle, extractResponseId, parseStrictVerdict } from "./verdict.js";

describe("parseStrictVerdict", () => {
  test("parses a clean strict-JSON verdict", () => {
    const out = parseStrictVerdict(
      '{"approved":true,"score":0.92,"summary":"meets all criteria","reasoning":"3 arXiv ids cited"}',
    );
    expect(out.normalizedVerdict.approved).toBe(true);
    expect(out.normalizedVerdict.score).toBeCloseTo(0.92);
    expect(out.normalizedVerdict.summary).toBe("meets all criteria");
    expect(out.reasoning).toBe("3 arXiv ids cited");
  });

  test("tolerates one round of markdown code fencing", () => {
    const fenced = '```json\n{"approved":false,"score":0.1,"summary":"missing format"}\n```';
    const out = parseStrictVerdict(fenced);
    expect(out.normalizedVerdict.approved).toBe(false);
    expect(out.normalizedVerdict.score).toBeCloseTo(0.1);
  });

  test("clamps out-of-band scores to [0, 1]", () => {
    expect(
      parseStrictVerdict('{"approved":true,"score":1.4,"summary":"ok"}').normalizedVerdict.score,
    ).toBe(1);
    expect(
      parseStrictVerdict('{"approved":false,"score":-0.2,"summary":"ok"}').normalizedVerdict.score,
    ).toBe(0);
  });

  test("throws on malformed JSON", () => {
    expect(() => parseStrictVerdict("not json")).toThrow(/strict JSON/);
  });

  test("throws when required keys are missing", () => {
    expect(() => parseStrictVerdict('{"approved":true,"score":0.5}')).toThrow(
      /missing required keys/,
    );
    expect(() => parseStrictVerdict('{"approved":"yes","score":0.5,"summary":"ok"}')).toThrow(
      /missing required keys/,
    );
  });

  test("reasoning is optional and only set when string", () => {
    const out = parseStrictVerdict('{"approved":true,"score":1,"summary":"ok"}');
    expect(out.reasoning).toBeUndefined();
  });
});

describe("buildAttestationBundle", () => {
  const evaluation: EvaluationResult = {
    rawVerdict: '{"approved":true,"score":1,"summary":"ok"}',
    normalizedVerdict: { approved: true, score: 1, summary: "ok" },
    reasoning: "ok",
    modelId: "qwen-2.5-7b-instruct",
    computeProvider: "0xa48f01287233509FD694a22Bf840225062E67836",
    promptHash: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex,
    responseId: "test-id",
    responseVerification: true,
    signedText: null,
    teeSignature: null,
    teeSignerAddress: null,
  };
  const baseParams = {
    jobId: 7n,
    commerceContract: "0x38A5c19134C1a922E52eBd3c3F96eBb47f5582B4" as `0x${string}`,
    chainId: 16602,
    taskSpecRoot: "0xaaaa" as Hex,
    deliverableRoot: "0xbbbb" as Hex,
    evaluation,
  };

  test("produces a v1 bundle that round-trips through JSON", () => {
    const bundle = buildAttestationBundle(baseParams);
    expect(bundle.version).toBe(1);
    expect(bundle.jobId).toBe("7"); // bigint stringified
    expect(bundle.modelId).toBe(evaluation.modelId);
    expect(bundle.normalizedVerdict.score).toBe(1);
    const round = JSON.parse(JSON.stringify(bundle));
    expect(round).toEqual(bundle);
  });

  test("omits optional `reasoning` when not provided by the evaluation", () => {
    const { reasoning: _drop, ...evalNoReasoning } = evaluation;
    const bundle = buildAttestationBundle({
      ...baseParams,
      evaluation: evalNoReasoning,
    });
    expect(bundle.reasoning).toBeUndefined();
    expect("reasoning" in bundle).toBe(false);
  });

  test("omits optional `settlementTx` until populated post-settle", () => {
    const bundle = buildAttestationBundle(baseParams);
    expect("settlementTx" in bundle).toBe(false);
    const filled = buildAttestationBundle({
      ...baseParams,
      settlementTx: "0xdeadbeef",
    });
    expect(filled.settlementTx).toBe("0xdeadbeef");
  });
});

describe("extractResponseId", () => {
  test("prefers the ZG-Res-Key header", () => {
    const headers = new Headers({ "ZG-Res-Key": "abc" });
    expect(extractResponseId(headers, { id: "fallback" })).toBe("abc");
  });

  test("falls back to the lowercase variant", () => {
    const headers = new Headers({ "zg-res-key": "lower" });
    expect(extractResponseId(headers, { id: "fallback" })).toBe("lower");
  });

  test("falls back to data.id if no header is present", () => {
    expect(extractResponseId(new Headers(), { id: "body-id" })).toBe("body-id");
  });

  test("returns null when nothing is available", () => {
    expect(extractResponseId(new Headers(), {})).toBeNull();
  });
});
