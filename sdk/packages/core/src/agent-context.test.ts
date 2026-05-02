import { describe, expect, test } from "bun:test";

import {
  EMPTY_AGENT_CONTEXT,
  buildAgentContext,
  hasCapability,
  parseAgentContext,
} from "./agent-context.js";

describe("buildAgentContext", () => {
  test("drops empty arrays + empty extras", () => {
    expect(buildAgentContext({})).toBeNull();
    expect(buildAgentContext({ capabilities: [], registries: [], protocols: [] })).toBeNull();
    expect(buildAgentContext({ extra: {} })).toBeNull();
  });

  test("lowercases + dedupes capability tokens", () => {
    const json = buildAgentContext({
      capabilities: ["INFT-Sale", "inft-sale", "acl-evaluator"],
    });
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string);
    expect(parsed.capabilities).toEqual(["inft-sale", "acl-evaluator"]);
  });

  test("spreads extra alongside structured fields", () => {
    const json = buildAgentContext({
      capabilities: ["inft-sale"],
      extra: { "acl.cap.inft-sale.min-price": "100" },
    });
    const parsed = JSON.parse(json as string);
    expect(parsed.capabilities).toEqual(["inft-sale"]);
    expect(parsed["acl.cap.inft-sale.min-price"]).toBe("100");
  });
});

describe("parseAgentContext", () => {
  test("returns empty shape for missing / empty / non-JSON input", () => {
    expect(parseAgentContext(null)).toEqual(EMPTY_AGENT_CONTEXT);
    expect(parseAgentContext(undefined)).toEqual(EMPTY_AGENT_CONTEXT);
    expect(parseAgentContext("")).toEqual(EMPTY_AGENT_CONTEXT);
    expect(parseAgentContext("hello world")).toEqual(EMPTY_AGENT_CONTEXT);
    expect(parseAgentContext("[1,2,3]")).toEqual(EMPTY_AGENT_CONTEXT);
  });

  test("extracts known fields and lowercases capabilities", () => {
    const ctx = parseAgentContext(
      JSON.stringify({
        capabilities: ["INFT-Sale", "Research"],
        registries: ["eip155:1/0xabc"],
        protocols: ["acl-erc-8183"],
        "acl.cap.inft-sale.min-price": "1000",
      }),
    );
    expect(ctx.capabilities).toEqual(["inft-sale", "research"]);
    expect(ctx.registries).toEqual(["eip155:1/0xabc"]);
    expect(ctx.protocols).toEqual(["acl-erc-8183"]);
    expect(ctx.extra["acl.cap.inft-sale.min-price"]).toBe("1000");
  });

  test("forward-compat: unknown shapes still parse and never throw", () => {
    const ctx = parseAgentContext(JSON.stringify({ foo: "bar", capabilities: "not-an-array" }));
    expect(ctx.capabilities).toEqual([]);
    expect(ctx.extra.foo).toBe("bar");
  });
});

describe("hasCapability", () => {
  test("exact-token, case-insensitive match", () => {
    const ctx = parseAgentContext(JSON.stringify({ capabilities: ["inft-sale", "acl-evaluator"] }));
    expect(hasCapability(ctx, "inft-sale")).toBe(true);
    expect(hasCapability(ctx, "INFT-Sale")).toBe(true);
    expect(hasCapability(ctx, "inft-sale-blacklist")).toBe(false);
    expect(hasCapability(ctx, "acl-evaluator")).toBe(true);
  });

  test("false on null / empty needle", () => {
    expect(hasCapability(null, "inft-sale")).toBe(false);
    expect(hasCapability(EMPTY_AGENT_CONTEXT, "inft-sale")).toBe(false);
    expect(hasCapability(EMPTY_AGENT_CONTEXT, "")).toBe(false);
  });
});
