import type { AttestationBundle, Deliverable, NormalizedVerdict, TaskSpec } from "@acl/core";
import type { AclStorage } from "@acl/storage";
import type { Address, Hex } from "viem";

/**
 * Verdict envelope produced by {@link Evaluator.evaluate}. Carries
 * everything the SDK needs to fold into an {@link AttestationBundle}
 * downstream — `rawVerdict` is verbatim from the LLM, the rest is
 * derived inside the SDK so the bundle is reproducible.
 */
export type EvaluationResult = {
  /** Verbatim model output. The bundle stores this so an auditor can replay scoring. */
  rawVerdict: string;
  /** Strict-JSON parse of `rawVerdict` into the SDK's verdict shape. */
  normalizedVerdict: NormalizedVerdict;
  /** Human-readable reasoning. Present only when the model emitted one. */
  reasoning?: string;
  /** Model id reported by `broker.inference.getServiceMetadata`. */
  modelId: string;
  /** Address of the 0G Compute provider that served the request. */
  computeProvider: Address;
  /** keccak256 of the canonical request body. Binds the bundle to the input. */
  promptHash: Hex;
  /** Identifier used by `broker.inference.processResponse` (header `ZG-Res-Key` or `data.id`). */
  responseId: string;
  /**
   * Result of `inference.processResponse(provider, responseId)` — the
   * broker's in-process verification of the TEE signature header.
   * `true` when the broker confirmed the signature, `false` when it
   * rejected it. Distinct from the on-chain `ECDSA.recover` check that
   * `ACLEvaluator.settle()` performs from the same `(signedText,
   * teeSignature)` bytes recorded below.
   */
  responseVerification: boolean;
  /**
   * Raw bytes the 0G Compute TEE signed (UTF-8 of a colon-separated
   * `<requestHash>:<responseHash>:<providerType>:<providerIdentity>:<imageDigest>`).
   * Required input to `ACLEvaluator.settle()` so the contract can verify
   * the signature against the on-chain `teeSignerAddress`. The SDK
   * throws inside `evaluate(...)` if any TEE field is missing — the
   * ACL settlement path has no non-TEE branch.
   */
  signedText: string;
  /** EIP-191 personal_sign signature over `signedText`. */
  teeSignature: Hex;
  /**
   * On-chain TEE signer address registered for `computeProvider` on the
   * 0G Compute `InferenceServing` marketplace at the moment the evaluation
   * ran. Stored verbatim so off-chain consumers can re-verify the bundle
   * without an extra round-trip; the on-chain settle path re-reads it
   * authoritatively.
   */
  teeSignerAddress: Address;
};

/**
 * Inputs to {@link Evaluator.evaluate}. Pass the raw spec / deliverable
 * objects (not the storage roots) so the evaluator can build the prompt
 * locally; the roots are still required so the resulting attestation
 * bundle stays linkable to 0G Storage.
 */
export type EvaluateParams = {
  taskSpec: TaskSpec;
  deliverable: Deliverable;
  /** 0G Storage root of the {@link TaskSpec}, recorded in the bundle. */
  taskSpecRoot: Hex;
  /** 0G Storage root of the {@link Deliverable}, recorded in the bundle. */
  deliverableRoot: Hex;
};

/**
 * Optional inputs to {@link Evaluator.buildAttestationBundle}. Anything not
 * carried by the `EvaluationResult` itself.
 */
export type BuildBundleParams = {
  jobId: bigint | number | string;
  commerceContract: Address;
  chainId: number;
  taskSpecRoot: Hex;
  deliverableRoot: Hex;
  evaluation: EvaluationResult;
  /** Settlement tx hash, if the bundle is being finalised post-settle. */
  settlementTx?: Hex;
};

export type EnsureFundedOptions = {
  /**
   * Initial ledger deposit in OG (whole units), used when the wallet
   * has no ledger yet. 0G enforces a minimum of 3 OG to create a
   * ledger; smaller values cause `addLedger` to revert.
   *
   * @default 3
   */
  initialDeposit?: number;
  /**
   * Floor for an EXISTING ledger's `totalBalance`, expressed in
   * neuron (18-decimal wei equivalent). When the on-chain ledger sits
   * below this floor, `ensureFunded` tops it up via `depositFund` to
   * exactly the floor; otherwise the call is a no-op. Defaults to
   * `initialDeposit * 10^18`, so a fresh-vs-existing wallet ends up
   * funded to the same level.
   */
  minLedgerBalance?: bigint;
  /**
   * Per-provider sub-account top-up in neuron. 0G enforces a minimum
   * of 1 OG (`10n ** 18n`) for the provider proxy to accept requests;
   * passing less leaves the sub-account orphaned.
   *
   * NOTE: `transferFund` is NOT idempotent — every call moves funds
   * out of the master ledger. Pass `0n` after the first run if you
   * want subsequent `ensureFunded` calls to skip the transfer.
   *
   * @default 10n ** 18n  // = 1 OG
   */
  providerTransfer?: bigint;
};

/** Configuration block for {@link createEvaluator}. */
export type EvaluatorConfig = {
  /**
   * 0G Galileo RPC. Default: public 0G testnet RPC. The compute broker
   * uses this RPC for every on-chain settlement (the same chain as the
   * AgenticCommerce contract).
   */
  rpcUrl?: string;
  /**
   * Pre-built ethers signer (e.g. from a hosted wallet integration).
   * Mutually exclusive with `privateKey`.
   */
  signer?: import("ethers").JsonRpcSigner | import("ethers").Wallet;
  /**
   * Private key — the SDK builds an `ethers.Wallet` for you.
   * Mutually exclusive with `signer`.
   */
  privateKey?: Hex;
  /**
   * Optional override for the 0G Compute provider address. When unset
   * the SDK calls `listService()` once and picks the first provider
   * whose `model` matches `modelMatch`.
   */
  providerAddress?: Address;
  /**
   * Substring or RegExp filter applied to the model name when
   * auto-discovering a 0G Compute provider. Default:
   * {@link DEFAULT_MODEL_MATCH} (the verified
   * `qwen-2.5-7b-instruct` service on Galileo testnet).
   *
   * Pass any string from {@link KNOWN_MODELS} for a typed handle, or
   * a free-form substring / RegExp to match providers added to the
   * 0G Compute catalogue after SDK release. Inspect the catalogue
   * live with `inference.listService()`.
   */
  modelMatch?: string | RegExp;
  /**
   * Plug-in storage instance. When set, {@link Evaluator.uploadAttestationBundle}
   * works; otherwise consumers MUST upload bundles themselves and
   * supply the root hash to {@link Evaluator.buildAttestationBundle}.
   */
  storage?: AclStorage;
  /**
   * Override the system prompt (e.g. to swap in a domain-specific
   * rubric). The default prompt enforces strict-JSON output and an
   * injection-resistant delimiter convention; consumers SHOULD reuse
   * it unless they have a strong reason to deviate.
   */
  systemPrompt?: string;
  /**
   * Optional sampling override. Most evaluators want deterministic
   * scoring, so the default is `temperature: 0`.
   */
  temperature?: number;
};

export type Evaluator = {
  /**
   * Idempotent setup helper. Inspects the ledger + provider sub-account
   * balances and tops them up only when below threshold. Re-running is
   * safe and a no-op when funds are already in place.
   */
  ensureFunded(opts?: EnsureFundedOptions): Promise<{
    /** True iff a brand-new ledger was created (`addLedger`). */
    ledgerCreated: boolean;
    /** True iff an existing ledger was topped up (`depositFund`). */
    ledgerToppedUp: boolean;
    /** True iff a per-provider sub-account transfer was performed. */
    providerTransferred: boolean;
  }>;
  /**
   * Run inference + TEE verification and return the structured
   * evaluation result. Does NOT auto-fund — call
   * {@link ensureFunded} once during setup if the account is empty.
   */
  evaluate(params: EvaluateParams): Promise<EvaluationResult>;
  /**
   * Assemble an `AttestationBundle` for the on-chain `complete` /
   * `reject` reason argument. Pure transformation — no I/O.
   */
  buildAttestationBundle(params: BuildBundleParams): AttestationBundle;
  /**
   * Upload an `AttestationBundle` to 0G Storage and return the
   * `bytes32 reason` argument for ERC-8183 settlement. Requires
   * `storage` to be configured.
   */
  uploadAttestationBundle(bundle: AttestationBundle): Promise<{
    rootHash: Hex;
    /**
     * Storage Flow tx hash. Absent when the upstream 0G Storage SDK
     * short-circuited the upload (file already finalised on storage).
     * The `rootHash` is still authoritative.
     */
    txHash?: Hex;
    /** 0G Storage submission sequence number (canonical explorer key). */
    txSeq: number;
  }>;
  /** Resolved 0G Compute provider address used for inference. */
  readonly providerAddress: Address;
  /** Resolved model id (e.g. `qwen-2.5-7b-instruct`). */
  readonly modelId: string;
};
