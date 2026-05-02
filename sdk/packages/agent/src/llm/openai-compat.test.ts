import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createOpenAICompatibleBackend } from "./openai-compat.js";

const ORIGINAL_FETCH = globalThis.fetch;

describe("createOpenAICompatibleBackend", () => {
  let calls: { url: string; init: RequestInit }[] = [];
  let responses: Array<() => Promise<Response>>;

  beforeEach(() => {
    calls = [];
    responses = [];
    const mock: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push({ url, init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("test set up no response for this call");
      return next();
    }) as typeof fetch;
    globalThis.fetch = mock;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("retries on 429 then succeeds", async () => {
    responses.push(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
    );
    responses.push(
      async () =>
        new Response(
          JSON.stringify({
            model: "test-model",
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const backend = createOpenAICompatibleBackend({
      baseUrl: "http://localhost/v1",
      apiKey: "k",
      model: "test-model",
      initialBackoffMs: 1,
    });
    const result = await backend.chat([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("ok");
    expect(calls.length).toBe(2);
  });

  it("gives up after maxRetries on persistent 503", async () => {
    for (let i = 0; i < 3; i++) {
      responses.push(async () => new Response("upstream busy", { status: 503 }));
    }
    const backend = createOpenAICompatibleBackend({
      baseUrl: "http://localhost/v1",
      apiKey: "k",
      model: "test-model",
      maxRetries: 2,
      initialBackoffMs: 1,
    });
    await expect(backend.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/503/);
    expect(calls.length).toBe(3);
  });

  it("does not retry on 400-class errors except 408/425/429", async () => {
    responses.push(async () => new Response("bad request", { status: 400 }));
    const backend = createOpenAICompatibleBackend({
      baseUrl: "http://localhost/v1",
      apiKey: "k",
      model: "test-model",
      initialBackoffMs: 1,
    });
    await expect(backend.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/400/);
    expect(calls.length).toBe(1);
  });
});
