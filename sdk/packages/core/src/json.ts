import { type Hex, hexToString } from "viem";

/**
 * Lenient JSON parser shared between the SDK's LLM-driven helpers
 * (ClientAgent's TaskSpec authoring, the Flow-2 BuyerFlow ACQUIRE
 * decision, etc.). The 7B / 8B class models the demo runs on are
 * happy to wrap "valid JSON" in markdown code fences when their
 * server hint flips to "responseFormat: json"; rather than scatter
 * fence-stripping logic at every call-site we centralise it here.
 *
 * Returns `null` on any parse failure so the caller can fall back
 * to a deterministic default. Never throws.
 */
export function parseJsonLenient(content: string): unknown {
  const stripped = content
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Best-effort UTF-8 decode of a `bytes` metadata value (e.g. an
 * ENSIP-26 text record fetched as raw hex by `searchAgents`). Returns
 * the empty string for `undefined`, the empty hex `0x`, or any
 * payload that doesn't decode cleanly — letting callers feed the
 * result straight into `parseAgentContext` / `parseJsonLenient`
 * without splatting an exception mid-event-emit.
 *
 * Centralised in `@acl/core` so agent / discovery / gateway packages
 * don't fork the same `try { hexToString } catch { return "" }`
 * wrapper.
 */
export function safeHexToText(hex: Hex | undefined): string {
  if (!hex || hex === "0x") return "";
  try {
    return hexToString(hex);
  } catch {
    return "";
  }
}

/**
 * Best-effort `JSON.parse` of a UTF-8 agent-context payload, returning
 * `null` when the value is empty or doesn't parse to a JSON object
 * (arrays and primitives are explicitly rejected). Used by the
 * discovery event emitter so a candidate with a malformed
 * `acl.agent-context` record never blows up the whole event roll-up.
 */
export function safeJsonObject(
  text: string | undefined | null,
): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}
