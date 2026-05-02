import { type Hex, keccak256, toBytes } from "viem";

/**
 * Canonical task description shared during AXL negotiation, uploaded to 0G
 * Storage as JSON, and committed-to by `JobProposal.taskSpecHash`.
 *
 * Hybrid shape: structured fields cover the common path; `extensions` lets
 * app-specific overrides come along without breaking canonical hashing on
 * the ACL side. Keep fields that affect `taskSpecHash` aligned across the
 * entire SDK — the hash binds the proposal to the exact bytes both sides
 * sign over.
 */
export type TaskSpec = {
  /** Short human-readable title. */
  title: string;
  /** Plain-text objective. */
  objective: string;
  /** Bullet-list of acceptance criteria the evaluator will check. */
  acceptanceCriteria: string[];
  /** Required output format (e.g. "markdown", "json"). */
  requiredFormat: string;
  /** Optional list of disallowed claim shapes (anti-hallucination guardrail). */
  forbiddenClaims?: string[];
  /** Optional rubric the evaluator runs against the deliverable. */
  evaluationRubric?: string;
  /** Delivery tag the agent advertised (must match `acl.delivery-types`). */
  deliveryType: string;
  /** Domain the task falls under (must match `acl.task-domains`). */
  taskDomain: string;
  /** ISO-8601 timestamp set when the spec was authored. */
  createdAt: string;
  /** Optional structured extensions. Hashed deterministically. */
  extensions?: Record<string, unknown>;
};

/**
 * Provider's deliverable as published to 0G Storage. The bytes32 root of
 * this object's serialised JSON becomes the on-chain `submit(jobId,
 * deliverable)` argument; the evaluator pulls the same JSON to score the
 * work.
 *
 * `content` is intentionally opaque: text/markdown jobs put the markdown
 * here; structured jobs put the JSON; binary jobs MUST upload the binary
 * separately and put the resulting root hash here as a hex string. Keeping
 * the JSON shape uniform means the evaluator never has to switch on the
 * content type at the storage boundary.
 */
export type Deliverable = {
  /** ERC-8183 jobId this deliverable settles. */
  jobId: string;
  /** Address of the providing agent (matches `JobProposal.provider`). */
  provider: `0x${string}`;
  /** 0G Storage root hash of the matching `TaskSpec` JSON (hex string). */
  taskSpecRoot: Hex;
  /** Free-form deliverable body. */
  content: string;
  /** MIME-ish content type (e.g. "text/markdown"). */
  contentType: string;
  /** ISO-8601 timestamp the provider sealed the deliverable. */
  createdAt: string;
};

/**
 * Evidence bundle the evaluator publishes alongside `complete()` /
 * `reject()`. The `bytes32` root of this object's canonical JSON is the
 * `reason` argument on the ERC-8183 transition — anyone who later inspects
 * the job can pull the same bundle from 0G Storage and replay the
 * verdict.
 *
 * Designed to satisfy the RDP section 6.5 attestation shape and the section 2.5 0G
 * Compute integrity requirement (TEE signature, never ZK).
 */
export type AttestationBundle = {
  /** Schema version. Bump when the bundle shape changes. */
  version: 1;
  /** ERC-8183 jobId being settled. */
  jobId: string;
  /** AgenticCommerce contract holding the job. */
  commerceContract: `0x${string}`;
  /** Chain id of `commerceContract`. */
  chainId: number;
  /** 0G Storage root of the agreed `TaskSpec`. */
  taskSpecRoot: Hex;
  /** 0G Storage root of the provider's `Deliverable`. */
  deliverableRoot: Hex;
  /** Model id used for evaluator inference (e.g. "qwen-2.5-7b-instruct"). */
  modelId: string;
  /** 0G Compute provider address that served the inference. */
  computeProvider: `0x${string}`;
  /** keccak256 of the prompt sent to 0G Compute (binds the bundle to the input). */
  promptHash: Hex;
  /** Provider-supplied response identifier (`ZG-Res-Key` or `data.id`). */
  responseId: string;
  /** Result of `broker.inference.processResponse(...)`. */
  responseVerification: boolean;
  /**
   * Raw bytes the 0G Compute TEE signed (UTF-8 of the colon-separated
   * `<requestHash>:<responseHash>:<providerType>:<providerIdentity>:<imageDigest>`
   * payload returned by `<svc.url>/v1/proxy/signature/:chatID`).
   * Off-chain consumers can re-verify the bundle via
   * `recover(toEthSignedMessageHash(signedText), teeSignature) == teeSignerAddress`.
   */
  signedText: string;
  /** EIP-191 personal_sign signature over `signedText`. */
  teeSignature: Hex;
  /**
   * Registered TEE signer address for `computeProvider` on 0G Compute's
   * InferenceServing marketplace at the time of evaluation. The on-chain
   * settle path re-reads this authoritatively; we only persist it for
   * off-chain audit convenience.
   */
  teeSignerAddress: `0x${string}`;
  /** Raw model output verbatim. */
  rawVerdict: string;
  /** Structured verdict the SDK derives from `rawVerdict`. */
  normalizedVerdict: NormalizedVerdict;
  /** Optional human-readable reasoning preserved for replay. */
  reasoning?: string;
  /** Settlement transaction hash, set after `complete()` / `reject()`. */
  settlementTx?: Hex;
  /** ISO-8601 timestamp set when the bundle was finalised. */
  createdAt: string;
};

export type NormalizedVerdict = {
  /** Whether the deliverable should be settled with `complete()`. */
  approved: boolean;
  /** Numeric score in 0..1, used as a sortable signal in dashboards. */
  score: number;
  /** Short human-readable summary suitable for ENS reputation feedback. */
  summary: string;
};

/**
 * Deterministic hash of a {@link TaskSpec}. We canonicalise by sorting object
 * keys recursively so client and provider sign the same bytes regardless of
 * `JSON.stringify` insertion order.
 *
 * Every structured field is part of the canonical payload, plus
 * `extensions`. Optional fields default to stable values (`undefined` for
 * `forbiddenClaims` / `evaluationRubric` becomes `null`, `extensions`
 * becomes `{}`) so the absence of an optional field does not silently
 * change the hash for downstream consumers.
 */
export function hashTaskSpec(spec: TaskSpec): Hex {
  const canonical = canonicalJson({
    title: spec.title,
    objective: spec.objective,
    acceptanceCriteria: spec.acceptanceCriteria,
    requiredFormat: spec.requiredFormat,
    forbiddenClaims: spec.forbiddenClaims ?? null,
    evaluationRubric: spec.evaluationRubric ?? null,
    deliveryType: spec.deliveryType,
    taskDomain: spec.taskDomain,
    createdAt: spec.createdAt,
    extensions: spec.extensions ?? {},
  });
  return keccak256(toBytes(canonical));
}

/**
 * Stable, sorted-key JSON representation. Recurses into objects but leaves
 * arrays in their declared order (consumers SHOULD pre-sort arrays whose
 * order is semantically meaningless).
 *
 * `undefined` leaves throw rather than getting silently coerced to the literal
 * string "undefined" by `${...}` interpolation — the latter would corrupt the
 * EIP-712 hash without anyone noticing.
 *
 * `bigint` leaves throw because `JSON.stringify` itself throws on bigints; if
 * you need numeric extensions wider than `Number.MAX_SAFE_INTEGER`, encode
 * them as decimal strings before placing them in `extensions`.
 *
 * NaN / Infinity throw for the same reason: `JSON.stringify` emits `null`
 * for these, which would silently swallow the value.
 *
 * Exposed publicly so other packages (storage, evaluation) can hash arbitrary
 * payloads with the same canonicalisation rules — the bytes32 root of every
 * 0G Storage upload is computed by the SDK through this function.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "undefined") {
    throw new Error(
      "canonicalJson: `undefined` is not representable in canonical JSON; pass `null` or omit the field",
    );
  }
  if (typeof value === "bigint") {
    throw new Error(
      "canonicalJson: bigint values are not representable; encode as a decimal string",
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: NaN and ±Infinity are not representable in canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}
