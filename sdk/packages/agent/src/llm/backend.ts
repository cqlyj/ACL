/**
 * Pluggable LLM backend used by ClientAgent and ProviderAgent for
 * reasoning, planning and content generation.
 *
 * The interface is intentionally tight — chat-completion only — so the
 * SDK can ship multiple drop-in implementations:
 *
 *   - 0G Compute Router  ({@link ./zg-router.ts})
 *   - any OpenAI-compatible HTTP endpoint ({@link ./openai-compat.ts})
 *
 * The EvaluatorAgent does NOT use this interface; it uses 0G Compute
 * Direct via {@link @acl/evaluation} so the TEE-attestation primitives
 * (signed text + signature) are available for the on-chain proof in
 * `ACLEvaluator.settle()`.
 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatOptions = {
  /** Sampling temperature. Defaults to whatever the backend deems sensible. */
  temperature?: number;
  /** Hard cap on output tokens. */
  maxTokens?: number;
  /** Per-call model override. Defaults to the model pinned at backend creation time. */
  model?: string;
  /**
   * Hint that the model should emit strict JSON. Backends MAY translate
   * this to provider-specific flags (e.g. OpenAI `response_format` or
   * vLLM grammar). Backends without native JSON-mode just append a
   * "respond with JSON only" reminder to the system prompt.
   */
  responseFormat?: "text" | "json";
};

export type ChatResponse = {
  /** Verbatim assistant content. */
  content: string;
  /** Backend-specific extra info; SDK does not interpret it. */
  raw?: Record<string, unknown>;
};

export interface LLMBackend {
  /** Pinned model id this backend defaults to when `options.model` is omitted. */
  readonly modelId: string;
  /** Send a multi-turn chat to the model and return the assistant's reply. */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}
