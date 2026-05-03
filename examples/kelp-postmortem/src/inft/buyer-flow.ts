/**
 * Buyer flow — the autonomous Phase-2 trigger.
 *
 * Triggered by a `job.settled.client-side` event with
 * `finalState === 'completed'` AND `selfComplete === false` (we ignore
 * Phase-2's own selfComplete settlements to avoid recursion).
 *
 * Real-corpus transfer pipeline:
 *
 *  1. Read the seller-side iNFT pointer + capability metadata from
 *     `event.providerProfile.agentContext.extra` (ENSIP-26).
 *  2. Ask the LLM ACQUIRE / SKIP given (score, capabilities,
 *     min-price, originalBrief).
 *  3. ACQUIRE path:
 *     a. Read on-chain `intelligentDataOf(tokenId)` → oldDataHashes.
 *     b. Read on-chain `encryptedStorageURIs(tokenId)` → 0G Storage root.
 *     c. Download the seller-side ciphertext from 0G Storage.
 *     d. Fetch the AES dataKey from the coordinator's in-process key
 *        registry (the demo "oracle" custody surface — see
 *        `server.ts: /api/inft-keys/<tokenId>`).
 *     e. Decrypt the ciphertext → recover the real provider bundle
 *        plaintext.
 *     f. Re-encrypt the plaintext under a fresh AES-GCM key sealed
 *        to the buyer's secp256k1 pubkey.
 *     g. Upload the new ciphertext to 0G Storage.
 *     h. Sign `TransferValidityProof[]` with `oldDataHash` =
 *        on-chain, `newDataHash` = keccak256(new ciphertext),
 *        `sealedKey` = buyer-sealed AES key.
 *     i. Drive `client.runJob({ ..., selfComplete: true,
 *        hook: inftDeliveryHook({ ..., proofs }) })`.
 *  4. After settlement: surface the decrypted bundle on the
 *     `phase2.completed` event so the UI / callers see the real
 *     corpus they just acquired.
 *
 * Live-corpus race rule: if the provider's Op A runs between our
 * step (a) read and the on-chain `iTransfer` (driven by
 * `INFTDeliveryHook` inside `complete`), the contract reverts with
 * `OldDataHashMismatch`. We retry exactly once.
 */

import {
  type AgentEvent,
  type AgentEventBus,
  type ClientAgent,
  INFT_DELIVERY_TYPE,
  type LLMBackend,
  type RunJobInput,
} from "@acl/agent";
import { type AgentProfile, parseJsonLenient } from "@acl/core";
import {
  type INftClient,
  type ReencryptionOracle,
  createINftClient,
  inftDeliveryHook,
  isOldDataHashMismatchError,
  parseInftSaleCapability,
  prepareInftAcquisition,
  repointInftAfterAcquisition,
} from "@acl/inft";
import type { Address, Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

export type BuyerFlowDeps = {
  client: ClientAgent;
  llm: LLMBackend;
  /**
   * Buyer's hex-encoded private key. Drives ECIES decryption (via
   * `decryptIntelligentData`) AND the access-proof signature; the
   * matching `LocalAccount` is derived in-class so the call-site
   * doesn't have to keep both in sync.
   */
  buyerPrivateKey: Hex;
  /**
   * Re-encryption oracle the buyer trusts to convert seller-bound
   * ciphertext into recipient-bound ciphertext + signed
   * `OwnershipProof`. The example wires
   * {@link createDemoLocalReencryptionOracle}; production deployments
   * swap in a TEE/ML-backed implementation.
   */
  oracle: ReencryptionOracle;
};

export type BuyerFlowResult =
  | { decision: "SKIP"; reason: string }
  | {
      decision: "ACQUIRE";
      reason: string;
      jobId: string;
      tokenId: string;
      /** ERC-7857 contract that minted the iNFT being transferred. */
      nftContract: Address;
      bundle: unknown;
      /** Short text preview of the recovered bundle (≤180 chars). */
      bundlePreview: string;
      newDataHash: Hex;
      newEncryptedStorageURI: string;
      /** 0G Storage root of the buyer's freshly uploaded ciphertext. */
      cipherRoot: Hex;
      /** Provider ENS name (when known). */
      sellerEns?: string;
      sellerAgentId?: string;
      /** Phase-1 normalized score that triggered the acquisition. */
      score: number | null;
      /** `complete` tx hash returned by the iNFT-delivery hook (if exposed). */
      transferTxHash?: Hex;
      /** Tx hash of the post-transfer `update(...)` repointing the storage URI. */
      updateTxHash?: Hex;
      /**
       * `ownerOf(tokenId)` read **before** the buyer-as-evaluator job
       * settles. Should equal the provider's wallet — proves the iNFT
       * really started in seller hands.
       */
      previousOwner: Address;
      /**
       * `ownerOf(tokenId)` read **after** the on-chain `update(...)`
       * confirms. Should equal the buyer's wallet — proves
       * `iTransfer` (driven by `INFTDeliveryHook` inside `complete`)
       * actually moved the token, rather than just minting events.
       */
      newOwner: Address;
    };

/**
 * App-scoped event names BuyerFlow stamps on `app.event.name`. Kept
 * as a const so UI code (and any future external consumers) can match
 * against the same string set without copy-pasting magic literals.
 */
export const BUYER_FLOW_EVENTS = {
  completed: "phase2.completed",
  skipped: "phase2.skipped",
  failed: "phase2.failed",
} as const;

const ACQUIRE_RETRY_LIMIT = 2;

export class BuyerFlow {
  private readonly _buyerAccount: LocalAccount;

  constructor(private readonly _deps: BuyerFlowDeps) {
    this._buyerAccount = privateKeyToAccount(_deps.buyerPrivateKey);
  }

  /**
   * Subscribe to the buyer's `job.settled.client-side` events; for
   * each non-self-complete `completed` settlement, kick off Phase-2
   * against the provider that just delivered. Returns an unsubscribe
   * handle.
   *
   * Phase-2 outcomes ride the SDK's existing event bus as
   * `app.event` payloads (`name: "phase2.completed" | "phase2.failed"`),
   * so any consumer already wired to the agent bus — coordinator SSE
   * forwarder, telemetry tap, the demo UI — picks them up without a
   * separate channel.
   */
  attach(): () => void {
    return this._deps.client.events.on(async (ev: AgentEvent) => {
      if (ev.type !== "job.settled.client-side") return;
      // Only act on a real Flow-1 `completed` settlement.
      if (ev.finalState !== "completed") return;
      // CRITICAL: skip Phase-2's own selfComplete settlements.
      // Without this gate the buyer-flow recurses into itself.
      if (ev.selfComplete) return;
      try {
        const score = await ev.getScoreNormalized();
        const result = await this.run({
          provider: ev.providerProfile,
          brief: ev.brief,
          score,
        });
        this._emit(BUYER_FLOW_EVENTS.completed, { result });
      } catch (err) {
        this._emit(BUYER_FLOW_EVENTS.failed, {
          error: (err as Error).message ?? String(err),
        });
      }
    });
  }

  private _emit(name: string, payload: Record<string, unknown>): void {
    this._deps.client.events.emit({
      type: "app.event",
      agentRole: "client",
      name,
      payload,
      at: new Date().toISOString(),
    });
  }

  /** Direct entry point — useful for tests and out-of-band drives. */
  async run(trigger: {
    provider: AgentProfile;
    brief: string;
    score: number | null;
  }): Promise<BuyerFlowResult> {
    const ctx = trigger.provider.agentContext ?? {
      capabilities: [],
      registries: [],
      protocols: [],
      extra: {},
    };
    // `parseInftSaleCapability` returns null when any of the three
    // required keys (contract / token-id / min-price) is missing or
    // malformed, AND lenient-coerces JSON-number forms — replaces a
    // page of dotted-key string casting with one type-safe call.
    const cap = parseInftSaleCapability(ctx.extra);
    if (!cap) {
      return {
        decision: "SKIP",
        reason: "provider has no `inft-sale` capability",
      };
    }
    const { contract: inftContract, tokenId, minPrice } = cap;

    const nft = createINftClient({
      publicClient: this._deps.client.runtime.publicClient,
      walletClient: this._deps.client.runtime.walletClient,
      deployment: this._deps.client.runtime.deployment,
      contractAddress: inftContract,
    });

    // Replay safety: if the buyer already owns the iNFT (e.g. a
    // prior Phase-2 run already acquired it), short-circuit to SKIP.
    // The hook would otherwise revert with `NotProvider()` because
    // `transferFrom(provider, escrow)` can't move a token the
    // provider no longer holds.
    const previousOwner = await nft.ownerOf(tokenId);
    if (previousOwner.toLowerCase() === this._buyerAccount.address.toLowerCase()) {
      return {
        decision: "SKIP",
        reason: `tokenId ${tokenId} already owned by buyer (replay)`,
      };
    }

    const decision = await this._decideAcquire({
      score: trigger.score,
      capabilities: ctx.capabilities,
      minPrice,
      providerEns: trigger.provider.ensName,
      brief: trigger.brief,
    });
    if (decision.decision === "SKIP") {
      return { decision: "SKIP", reason: decision.reason };
    }

    return this._acquireWithRetry({
      tokenId,
      provider: trigger.provider,
      nft,
      minPrice,
      reason: decision.reason,
      score: trigger.score,
      previousOwner,
    });
  }

  /**
   * Up to two attempts: provider Op A may land between our
   * `oldDataHash` read and our `iTransfer`. Retry once on
   * `OldDataHashMismatch`, abort on second failure.
   */
  private async _acquireWithRetry(args: {
    tokenId: bigint;
    provider: AgentProfile;
    nft: INftClient;
    minPrice: bigint;
    reason: string;
    score: number | null;
    previousOwner: Address;
  }): Promise<BuyerFlowResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < ACQUIRE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this._acquireOnce(args);
      } catch (err) {
        lastErr = err;
        if (attempt < ACQUIRE_RETRY_LIMIT - 1 && isOldDataHashMismatchError(err)) {
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("acquire-with-retry exhausted attempts");
  }

  private async _acquireOnce(args: {
    tokenId: bigint;
    provider: AgentProfile;
    nft: INftClient;
    minPrice: bigint;
    reason: string;
    score: number | null;
    previousOwner: Address;
  }): Promise<BuyerFlowResult> {
    const r = this._deps.client.runtime;

    // Steps (a)-(f): SDK-side mechanical pipeline (download seller
    // ciphertext, oracle re-encrypt, sign access proof, upload buyer
    // ciphertext, recover plaintext locally).
    const prep = await prepareInftAcquisition({
      nft: args.nft,
      storage: r.storage,
      oracle: this._deps.oracle,
      tokenId: args.tokenId,
      buyer: this._buyerAccount,
      buyerPrivateKey: this._deps.buyerPrivateKey,
    });
    const bundleText = new TextDecoder().decode(prep.plaintext ?? new Uint8Array());
    const bundle = parseJsonLenient(bundleText) ?? bundleText;

    const inftHook = inftDeliveryHook({
      deployment: r.deployment,
      nftContract: args.nft.contract,
      tokenId: args.tokenId,
      providerAgentId: args.provider.agentId ?? 0n,
      proofs: [prep.proof],
    });

    // Constrain discovery to the seller's advertised taskDomains so
    // the LLM's pickDomain step lands on a domain at least one
    // provider actually serves. Without this, a Phase-2 runJob
    // inherits the SDK's default broad-neutral domain set and may
    // pick e.g. "analysis" — which the seller doesn't advertise,
    // so gateway search returns 0 candidates and the flow aborts.
    const sellerDomains = args.provider.taskDomains
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const runInput: RunJobInput = {
      brief: `Acquire iNFT tokenId=${args.tokenId} from ${args.provider.ensName ?? args.provider.agentId}`,
      maxBudget: args.minPrice,
      paymentToken: config.paymentToken,
      allowedDeliveryTypes: [INFT_DELIVERY_TYPE],
      ...(sellerDomains.length > 0 ? { allowedDomains: sellerDomains } : {}),
      evaluator: this._deps.client.address,
      selfComplete: true,
      hook: inftHook,
    };
    const jobResult = await this._deps.client.runJob(runInput);

    // Post-transfer fixup (SDK-side): repoint on-chain
    // encryptedStorageURI to the buyer's freshly uploaded ciphertext
    // and wait for the receipt before returning so downstream reads
    // don't race the chain.
    const repoint = await repointInftAfterAcquisition({
      nft: args.nft,
      publicClient: r.publicClient,
      tokenId: args.tokenId,
      newDataHash: prep.reencryption.newDataHash,
      newEncryptedStorageURI: prep.newEncryptedStorageURI,
      dataDescription: `${args.provider.ensName ?? "agent"} bundle (acquired)`,
    });

    const previewSrc =
      typeof bundle === "string"
        ? bundle
        : (() => {
            try {
              return JSON.stringify(bundle);
            } catch {
              return bundleText;
            }
          })();
    const bundlePreview = previewSrc.length > 180 ? `${previewSrc.slice(0, 180)}…` : previewSrc;

    return {
      decision: "ACQUIRE",
      reason: args.reason,
      jobId: jobResult.jobId.toString(),
      tokenId: args.tokenId.toString(),
      nftContract: args.nft.contract,
      bundle,
      bundlePreview,
      newDataHash: prep.reencryption.newDataHash,
      newEncryptedStorageURI: prep.newEncryptedStorageURI,
      cipherRoot: prep.cipherRoot,
      ...(args.provider.ensName ? { sellerEns: args.provider.ensName } : {}),
      ...(args.provider.agentId !== undefined
        ? { sellerAgentId: args.provider.agentId.toString() }
        : {}),
      score: args.score,
      ...(jobResult.txHashes.settle ? { transferTxHash: jobResult.txHashes.settle } : {}),
      updateTxHash: repoint.updateTxHash,
      previousOwner: args.previousOwner,
      newOwner: repoint.newOwner,
    };
  }

  /**
   * LLM-driven ACQUIRE/SKIP. Falls back to a deterministic SKIP on
   * parse failure rather than minting a job we can't justify.
   *
   * Mirrors the inputs and decision back onto the client agent's
   * event bus as `llm.thinking` / `llm.decided` (purpose
   * `phase2-decide`) so the same UI panels that narrate Flow-1
   * negotiation can also narrate Phase-2 acquisition.
   */
  private async _decideAcquire(args: {
    score: number | null;
    capabilities: ReadonlyArray<string>;
    minPrice: bigint;
    providerEns?: string;
    brief: string;
  }): Promise<{ decision: "SKIP" | "ACQUIRE"; reason: string }> {
    const bus = this._deps.client.events;
    bus.emit({
      type: "llm.thinking",
      agentRole: "client",
      purpose: "phase2-decide",
      modelId: this._deps.llm.modelId,
      at: new Date().toISOString(),
    });
    const userPrompt = JSON.stringify({
      score: args.score,
      capabilities: args.capabilities,
      minPrice: args.minPrice.toString(),
      providerEns: args.providerEns ?? null,
      originalBrief: args.brief,
    });
    const resp = await this._deps.llm.chat(
      [
        { role: "system", content: BUYER_DECISION_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0, responseFormat: "json" },
    );
    const parsed = parseJsonLenient(resp.content) as {
      decision?: string;
      reason?: string;
    } | null;
    const decision = parsed?.decision === "ACQUIRE" ? "ACQUIRE" : "SKIP";
    const reason = parsed?.reason ?? "no reason";
    bus.emit({
      type: "llm.decided",
      agentRole: "client",
      purpose: "phase2-decide",
      modelId: this._deps.llm.modelId,
      output: {
        decision,
        reason,
        score: args.score,
        capabilities: args.capabilities,
        minPrice: args.minPrice.toString(),
        providerEns: args.providerEns ?? null,
      },
      at: new Date().toISOString(),
    });
    return {
      decision,
      reason,
    };
  }
}

const BUYER_DECISION_PROMPT = [
  "You are an autonomous buyer agent for ACL Phase-2 (iNFT acquisition).",
  "Given the provider's post-job score, capabilities, minimum sale price,",
  "and the original Phase-1 brief, decide whether to ACQUIRE the iNFT or",
  'SKIP. Reply with strict JSON: {"decision":"ACQUIRE"|"SKIP","reason":string}.',
  "Only ACQUIRE if the score (when present) is >= 0.5 OR the capabilities",
  "genuinely extend the buyer beyond the original brief.",
  "When the score is null and capabilities include 'inft-sale', use the",
  "originalBrief as the deciding signal: a high-quality completed",
  "Phase-1 implies the bundle is worth acquiring.",
].join("\n");

export type { AgentEventBus };
