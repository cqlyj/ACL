import { describe, expect, test } from "bun:test";

import { DEFAULT_CLIENT_PROMPTS, DEFAULT_PROVIDER_PROMPTS, resolvePrompts } from "./prompts.js";

describe("resolvePrompts", () => {
  test("returns the defaults verbatim when overrides is undefined", () => {
    const out = resolvePrompts(DEFAULT_CLIENT_PROMPTS, undefined);
    expect(out).toBe(DEFAULT_CLIENT_PROMPTS);
  });

  test("returns the defaults verbatim when overrides is empty", () => {
    const out = resolvePrompts(DEFAULT_CLIENT_PROMPTS, {});
    expect(out.pickDomain).toBe(DEFAULT_CLIENT_PROMPTS.pickDomain);
    expect(out.rankProviders).toBe(DEFAULT_CLIENT_PROMPTS.rankProviders);
    expect(out.authorTaskSpec).toBe(DEFAULT_CLIENT_PROMPTS.authorTaskSpec);
    expect(out.negotiateResponse).toBe(DEFAULT_CLIENT_PROMPTS.negotiateResponse);
  });

  test("merges in a single named override", () => {
    const out = resolvePrompts(DEFAULT_CLIENT_PROMPTS, {
      pickDomain: "use only research",
    });
    expect(out.pickDomain).toBe("use only research");
    expect(out.rankProviders).toBe(DEFAULT_CLIENT_PROMPTS.rankProviders);
  });

  test("ignores empty-string and undefined override values", () => {
    const out = resolvePrompts(DEFAULT_CLIENT_PROMPTS, {
      pickDomain: "",
      rankProviders: undefined as unknown as string,
    });
    expect(out.pickDomain).toBe(DEFAULT_CLIENT_PROMPTS.pickDomain);
    expect(out.rankProviders).toBe(DEFAULT_CLIENT_PROMPTS.rankProviders);
  });

  test("works with provider prompts type", () => {
    const out = resolvePrompts(DEFAULT_PROVIDER_PROMPTS, {
      decide: "always REJECT",
    });
    expect(out.decide).toBe("always REJECT");
    expect(out.deliverable).toBe(DEFAULT_PROVIDER_PROMPTS.deliverable);
  });

  test("default prompts contain no Kelp-specific examples", () => {
    const allText =
      DEFAULT_CLIENT_PROMPTS.pickDomain +
      DEFAULT_CLIENT_PROMPTS.rankProviders +
      DEFAULT_CLIENT_PROMPTS.authorTaskSpec +
      DEFAULT_CLIENT_PROMPTS.negotiateResponse +
      DEFAULT_PROVIDER_PROMPTS.decide +
      DEFAULT_PROVIDER_PROMPTS.deliverable;
    expect(allText.toLowerCase()).not.toContain("kelp");
    expect(allText.toLowerCase()).not.toContain("post-mortem");
  });
});
