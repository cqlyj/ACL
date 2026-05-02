/**
 * Curated list of 0G Compute models the SDK has been tested against.
 *
 * `modelMatch` on {@link EvaluatorConfig} is a free-form substring or
 * RegExp — these constants are just convenience handles so consumers
 * don't have to keep model ids in a `const` of their own. They are
 * NOT exhaustive: the live network catalogue is queried at runtime
 * via `broker.inference.listService()` and may include models that
 * pre-date or post-date this list.
 *
 * To pick a model not listed here:
 *   1. Call `inference.listService()` against your target network and
 *      inspect `service.model`.
 *   2. Pass that string to `createEvaluator({ modelMatch: '...' })`.
 *
 * Mainnet has its own catalogue distinct from testnet. As of this
 * writing only Galileo testnet exposes the chatbot service used by
 * Flow 1; mainnet entries below are placeholders that will be
 * populated when the public mainnet catalogue stabilises.
 */

/** A single entry in {@link KNOWN_MODELS}. */
export type KnownModel = {
  /** Exact id surfaced by `broker.inference.getServiceMetadata().model`. */
  id: string;
  /** Network this id has been observed on. */
  network: "galileo-testnet" | "mainnet";
  /** Whether the SDK has run the Flow 1 evaluator pipeline against it. */
  verifiedByAcl: boolean;
  /** Free-form note (provider, capability) — handy when surfacing the
   *  list in a UI. */
  notes?: string;
};

/**
 * 0G Compute models the SDK has been exercised against.
 *
 * Keep entries terse: the source of truth for live availability is
 * `broker.inference.listService()`. This map is for reference and for
 * apps that want a typed picker.
 */
export const KNOWN_MODELS = {
  QWEN_2_5_7B_INSTRUCT_TESTNET: {
    id: "qwen-2.5-7b-instruct",
    network: "galileo-testnet",
    verifiedByAcl: true,
    notes:
      "Default on testnet. Small instruct model — keep evaluator acceptance criteria as literal substring checks.",
  },
} as const satisfies Record<string, KnownModel>;

/** Default the SDK uses when `modelMatch` is omitted. */
export const DEFAULT_MODEL_MATCH: string = KNOWN_MODELS.QWEN_2_5_7B_INSTRUCT_TESTNET.id;
