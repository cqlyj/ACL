import type { ChatMessage, ChatOptions, ChatResponse, LLMBackend } from "./backend.js";

/**
 * Configuration for {@link createOpenAICompatibleBackend}.
 *
 * Works against any OpenAI-shaped `POST /chat/completions` endpoint —
 * tested against vanilla OpenAI, Together, OpenRouter, vLLM, and
 * 0G Router (`https://router.0g.ai/v1`).
 */
export type OpenAICompatibleConfig = {
  /** Base URL ending in `/v1`. */
  baseUrl: string;
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Default model id to use when `options.model` is omitted. */
  model: string;
  /**
   * Per-call timeout in ms. Default 120s — small testnet models can
   * legitimately take a while when the queue is hot.
   */
  timeoutMs?: number;
  /**
   * Extra headers (e.g. `X-Title` for OpenRouter). Merged into every
   * request after the standard `Authorization` + `Content-Type`.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Maximum retry attempts on 429 / 503 / network errors before giving
   * up. Defaults to 4 retries (5 attempts total). Public testnet
   * endpoints — especially the 0G Compute Router — rate-limit when a
   * single agent process fires multiple completions in quick
   * succession (e.g. client picking domain → ranking → authoring spec
   * back-to-back), so the default is generous on purpose.
   */
  maxRetries?: number;
  /**
   * Initial backoff for retried calls in ms. Doubled on each attempt
   * up to a 30s ceiling. Honored only when the server doesn't supply
   * a `Retry-After` header. Default 1s.
   */
  initialBackoffMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Statuses where retrying is meaningful (the request itself was fine). */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Build a {@link LLMBackend} backed by any OpenAI-compatible HTTP
 * endpoint. The backend implements the minimum surface ACL agents
 * need (chat completion + JSON response shaping) and forwards
 * everything else as-is.
 */
export function createOpenAICompatibleBackend(cfg: OpenAICompatibleConfig): LLMBackend {
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialBackoffMs = cfg.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  return {
    modelId: cfg.model,
    async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
      const model = options.model ?? cfg.model;
      const body: Record<string, unknown> = {
        model,
        messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      };
      let attempt = 0;
      let lastError: unknown = null;
      while (attempt <= maxRetries) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.apiKey}`,
              ...(cfg.extraHeaders ?? {}),
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
              const wait = _retryDelayMs({
                response: res,
                attempt,
                initialBackoffMs,
              });
              attempt += 1;
              await _sleep(wait);
              continue;
            }
            throw new Error(
              `@acl/agent: OpenAI-compatible chat completion returned ${res.status}: ${detail.slice(0, 400)}`,
            );
          }
          const data = (await res.json()) as {
            model?: string;
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content;
          if (typeof content !== "string") {
            throw new Error("@acl/agent: chat completion returned no message content");
          }
          return {
            content,
            raw: data as Record<string, unknown>,
          };
        } catch (err) {
          lastError = err;
          // Network-layer or abort errors get one retry shot before
          // we give up; HTTP status retries are handled above.
          if (
            attempt < maxRetries &&
            err instanceof Error &&
            !err.message.startsWith("@acl/agent:")
          ) {
            const wait = Math.min(initialBackoffMs * 2 ** attempt, MAX_BACKOFF_MS);
            attempt += 1;
            await _sleep(wait);
            continue;
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
      throw (
        lastError ??
        new Error("@acl/agent: chat completion exhausted retries without an explicit failure")
      );
    },
  };
}

function _retryDelayMs(input: {
  response: Response;
  attempt: number;
  initialBackoffMs: number;
}): number {
  // Honour `Retry-After` first — the server knows best. Spec allows
  // either a delay-seconds integer or an HTTP-date; we accept both.
  const header = input.response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_BACKOFF_MS);
    }
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), MAX_BACKOFF_MS);
    }
  }
  return Math.min(input.initialBackoffMs * 2 ** input.attempt, MAX_BACKOFF_MS);
}

function _sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}
