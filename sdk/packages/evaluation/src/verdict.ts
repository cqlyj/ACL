import type { AttestationBundle, NormalizedVerdict } from "@acl/core";
import type { BuildBundleParams } from "./types.js";

const ATTESTATION_BUNDLE_VERSION = 1 as const;

/**
 * Pure transformation: assemble a fully-typed {@link AttestationBundle}
 * from an {@link EvaluationResult} and the on-chain coordinates of the
 * job. Lives outside the {@link Evaluator} class because the bundle
 * shape is the same regardless of how the evaluation was produced —
 * makes it easy to unit-test and to use from non-broker call sites.
 */
export function buildAttestationBundle(params: BuildBundleParams): AttestationBundle {
  const ev = params.evaluation;
  return {
    version: ATTESTATION_BUNDLE_VERSION,
    jobId: String(params.jobId),
    commerceContract: params.commerceContract,
    chainId: params.chainId,
    taskSpecRoot: params.taskSpecRoot,
    deliverableRoot: params.deliverableRoot,
    modelId: ev.modelId,
    computeProvider: ev.computeProvider,
    promptHash: ev.promptHash,
    responseId: ev.responseId,
    responseVerification: ev.responseVerification,
    signedText: ev.signedText,
    teeSignature: ev.teeSignature,
    teeSignerAddress: ev.teeSignerAddress,
    rawVerdict: ev.rawVerdict,
    normalizedVerdict: ev.normalizedVerdict,
    ...(ev.reasoning ? { reasoning: ev.reasoning } : {}),
    ...(params.settlementTx ? { settlementTx: params.settlementTx } : {}),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Parse the raw LLM output into the structured ACL verdict shape.
 *
 * The model is instructed (by {@link DEFAULT_EVALUATOR_SYSTEM_PROMPT})
 * to emit one JSON object on a single line. Some models still wrap
 * that JSON in markdown code fences despite the instruction; we
 * tolerate exactly one round of fencing, then fall through to strict
 * `JSON.parse`. Anything else throws — silent recovery here would let
 * a malformed verdict slip into the on-chain attestation bundle.
 */
export function parseStrictVerdict(raw: string): {
  normalizedVerdict: NormalizedVerdict;
  reasoning?: string;
} {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`@acl/evaluation: model did not return strict JSON. Raw output:\n${raw}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { approved?: unknown }).approved !== "boolean" ||
    typeof (parsed as { score?: unknown }).score !== "number" ||
    typeof (parsed as { summary?: unknown }).summary !== "string"
  ) {
    throw new Error(
      `@acl/evaluation: model JSON missing required keys {approved, score, summary}. Raw:\n${raw}`,
    );
  }
  const obj = parsed as {
    approved: boolean;
    score: number;
    summary: string;
    reasoning?: unknown;
  };
  // Clamp to 0..1 — robust against models occasionally returning
  // slightly-out-of-band values; see RDP section 6.5 NormalizedVerdict shape.
  const score = Math.max(0, Math.min(1, obj.score));
  return {
    normalizedVerdict: { approved: obj.approved, score, summary: obj.summary },
    ...(typeof obj.reasoning === "string" ? { reasoning: obj.reasoning } : {}),
  };
}

/**
 * Resolve the `chatID` used for `broker.inference.processResponse(...)`.
 *
 * Per the 0G Compute docs:
 *   - Prefer the `ZG-Res-Key` response header (chatbot, image, audio).
 *   - Fall back to lowercase `zg-res-key` (some providers ship that
 *     casing only).
 *   - For chatbot specifically, fall back further to the response
 *     body's `id` field.
 *
 * Returns `null` when no source is present — the caller should treat
 * that as "verification skipped" rather than failing.
 */
export function extractResponseId(headers: Headers, data: { id?: string }): string | null {
  return headers.get("ZG-Res-Key") ?? headers.get("zg-res-key") ?? data.id ?? null;
}
