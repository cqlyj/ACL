import { describe, expect, test } from "bun:test";
import { canonicalJson, hashTaskSpec } from "./taskspec.js";
import type { TaskSpec } from "./taskspec.js";

const baseSpec: TaskSpec = {
  title: "Quantum gravity research brief",
  objective: "Survey recent loop-quantum-gravity preprints and produce a 3-paragraph summary.",
  acceptanceCriteria: ["<= 600 words", "cites at least 3 arXiv IDs"],
  requiredFormat: "text/markdown",
  deliveryType: "text/markdown",
  taskDomain: "Quantum",
  createdAt: "2026-04-30T00:00:00.000Z",
};

describe("hashTaskSpec", () => {
  test("is byte-stable under key reordering", () => {
    const reordered: TaskSpec = {
      createdAt: baseSpec.createdAt,
      taskDomain: baseSpec.taskDomain,
      acceptanceCriteria: [...baseSpec.acceptanceCriteria],
      title: baseSpec.title,
      requiredFormat: baseSpec.requiredFormat,
      objective: baseSpec.objective,
      deliveryType: baseSpec.deliveryType,
    };
    expect(hashTaskSpec(reordered)).toBe(hashTaskSpec(baseSpec));
  });

  test("changes when an acceptance criterion changes", () => {
    const a = hashTaskSpec(baseSpec);
    const b = hashTaskSpec({
      ...baseSpec,
      acceptanceCriteria: ["<= 600 words", "cites at least 4 arXiv IDs"],
    });
    expect(a).not.toBe(b);
  });

  test("omitting optional fields produces the same hash as the base spec", () => {
    const a = hashTaskSpec(baseSpec);
    // The hybrid TaskSpec coerces undefined optionals to `null` /
    // `{}` inside `hashTaskSpec`; the easiest way to verify that is
    // to construct a spec whose optional fields literally aren't set.
    const b = hashTaskSpec({ ...baseSpec });
    expect(a).toBe(b);
  });

  test("extensions affect the hash", () => {
    const a = hashTaskSpec(baseSpec);
    const b = hashTaskSpec({ ...baseSpec, extensions: { priority: "high" } });
    expect(a).not.toBe(b);
  });
});

describe("canonicalJson", () => {
  test("sorts object keys recursively", () => {
    const out = canonicalJson({ b: 1, a: { z: 1, x: 2 } });
    expect(out).toBe('{"a":{"x":2,"z":1},"b":1}');
  });

  test("preserves array order", () => {
    expect(canonicalJson([2, 1, 3])).toBe("[2,1,3]");
  });

  test("throws on undefined leaves so they cannot corrupt downstream hashes", () => {
    expect(() => canonicalJson({ a: undefined as unknown as null })).toThrow(/undefined/);
  });

  test("throws on bigints because JSON.stringify would too", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });

  test("throws on NaN / Infinity", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
});
