import type { LLMBackend } from "./backend.js";
import { type OpenAICompatibleConfig, createOpenAICompatibleBackend } from "./openai-compat.js";

/**
 * Default base URL for the 0G Compute Router. Matches the
 * "OpenAI-compatible router" documented at https://docs.0g.ai/.
 */
export const ZG_ROUTER_TESTNET_BASE_URL = "https://router.0g.ai/v1" as const;

export type ZGRouterConfig = {
  /** Router API key (`zg-...`). Generated in the 0G console. */
  apiKey: string;
  /** Model id (e.g. `qwen-2.5-7b-instruct`). */
  model: string;
  /** Override the router base URL. Defaults to {@link ZG_ROUTER_TESTNET_BASE_URL}. */
  baseUrl?: string;
  /**
   * Ask the router to verify the TEE attestation synchronously and
   * include the result in the response. Recommended for non-evaluator
   * uses where you still want a sanity check; the EvaluatorAgent does
   * its own per-response TEE verification via 0G Compute Direct.
   */
  verifyTee?: boolean;
  /** Per-call timeout in ms. Forwarded to the OpenAI-compatible backend. */
  timeoutMs?: number;
};

/**
 * Build an {@link LLMBackend} backed by the 0G Compute Router. This is
 * the recommended path for ClientAgent and ProviderAgent reasoning —
 * one API key, no on-chain ledger setup, OpenAI-compatible.
 *
 * Uses {@link createOpenAICompatibleBackend} under the hood; the only
 * router-specific touch is the optional `Verify-Tee` header that the
 * router uses to opt into synchronous TEE verification.
 */
export function createZGRouterBackend(cfg: ZGRouterConfig): LLMBackend {
  const headers: Record<string, string> = {};
  if (cfg.verifyTee) headers["Verify-Tee"] = "true";
  const inner: OpenAICompatibleConfig = {
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl ?? ZG_ROUTER_TESTNET_BASE_URL,
    extraHeaders: headers,
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
  };
  return createOpenAICompatibleBackend(inner);
}
