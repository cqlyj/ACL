import type { AgentProfile, TaskSpec } from "@acl/core";
import type { Address, Hex } from "viem";

import type { RunJobInput } from "../agents/client.js";

/**
 * Structured events agents emit while doing their work. The example
 * apps use this stream to drive their UI; production callers can hook
 * it for telemetry / auditing.
 *
 * Every event carries enough context (chain id, tx hash, storage roots,
 * ENS names, …) to build clickable explorer links — that's the whole
 * point of the bus.
 */
export type AgentEvent =
  | {
      type: "agent.boot";
      agentRole: AgentRole;
      ensName?: string;
      address: Hex;
      at: string;
    }
  | { type: "agent.shutdown"; agentRole: AgentRole; address: Hex; at: string }
  | {
      type: "log";
      agentRole: AgentRole;
      level: "info" | "warn" | "error";
      message: string;
      at: string;
    }
  | {
      type: "discovery.search";
      agentRole: AgentRole;
      query: { taskDomain?: string };
      at: string;
    }
  | {
      type: "discovery.match";
      agentRole: AgentRole;
      ensName: string;
      minBudget?: string;
      /**
       * Comma-separated `acl.task-domains` value the gateway returned
       * for this candidate. Useful for UI surfaces that want to show
       * the candidate's advertised lanes alongside the per-match
       * stream (the more detailed `discovery.candidates` roll-up
       * emits the parsed list separately).
       */
      taskDomains?: string;
      at: string;
    }
  /**
   * Emitted once per discovery cycle, after every `discovery.match`
   * has fired, with the full candidate list so the UI can render the
   * pool the LLM is about to rank.
   */
  | {
      type: "discovery.candidates";
      agentRole: AgentRole;
      query: { taskDomain?: string };
      candidates: ReadonlyArray<{
        ensName: string;
        agentId: string;
        minBudget?: string;
        capabilities: ReadonlyArray<string>;
        taskDomains: ReadonlyArray<string>;
        /**
         * The parsed `acl.agent-context` JSON for the candidate, exactly
         * as the gateway returned it. Surfaced verbatim so apps that
         * care about capability-specific parameters (e.g.
         * `acl.cap.inft-sale.token-id`) can read them without re-doing
         * the resolver round-trip. Absent when the candidate published
         * no agent-context record OR the record failed JSON parse on
         * the gateway side.
         */
        agentContext?: Readonly<Record<string, unknown>>;
      }>;
      at: string;
    }
  | {
      type: "llm.thinking";
      agentRole: AgentRole;
      purpose: string;
      modelId: string;
      at: string;
    }
  | {
      type: "llm.decided";
      agentRole: AgentRole;
      purpose: string;
      modelId: string;
      output: unknown;
      at: string;
    }
  | {
      type: "storage.upload";
      agentRole: AgentRole;
      kind: "taskSpec" | "deliverable" | "source" | "attestation";
      rootHash: Hex;
      /**
       * Storage Flow tx hash. Absent when the upstream 0G Storage SDK
       * short-circuited the upload (file already finalised on the
       * storage network). The `rootHash` is still authoritative — same
       * Merkle root, same content, just no new tx.
       */
      txHash?: Hex;
      /**
       * 0G Storage submission sequence number. Always present (even
       * for short-circuited uploads — the SDK looks up the existing
       * sequence) and is the canonical handle the storagescan
       * explorer keys files by (`/submission/<txSeq>`).
       */
      txSeq: number;
      at: string;
    }
  | {
      type: "storage.download";
      agentRole: AgentRole;
      kind: "taskSpec" | "deliverable" | "source" | "attestation";
      rootHash: Hex;
      at: string;
    }
  | {
      type: "tx.sent";
      agentRole: AgentRole;
      label: string;
      chainId: number;
      txHash: Hex;
      at: string;
    }
  | {
      type: "tx.confirmed";
      agentRole: AgentRole;
      label: string;
      chainId: number;
      txHash: Hex;
      at: string;
    }
  | {
      /**
       * Fired at the start of every negotiation attempt the client makes
       * with a candidate provider. The `attempt` index is 0-based and
       * caps at `runJobInput.maxNegotiationAttempts - 1`. UIs use this
       * to render the fallback story when the LLM walks down the
       * ranked candidate list.
       */
      type: "negotiation.attempt";
      agentRole: "client";
      attempt: number;
      maxAttempts: number;
      counterpartEnsName: string;
      counterpart: Hex;
      at: string;
    }
  | {
      /**
       * Fired when negotiation with the current candidate provider has
       * failed (REJECT, REJECTED counter, AXL timeout, or a verifier
       * exception). When `willRetry` is `true` the client will attempt
       * the next-ranked candidate; when `false` this was the final
       * attempt and `runJob` is about to throw.
       */
      type: "negotiation.failed";
      agentRole: "client";
      attempt: number;
      maxAttempts: number;
      counterpartEnsName: string;
      counterpart: Hex;
      reason: string;
      willRetry: boolean;
      at: string;
    }
  | {
      type: "negotiation.send";
      agentRole: AgentRole;
      verb: "PROPOSE" | "COUNTER" | "ACCEPT" | "REJECT";
      counterpart: Hex;
      /**
       * Budget the sender is committing to. Stringified `bigint` in the
       * job's `paymentToken` smallest unit. Absent only on REJECTs that
       * fire before the proposal is parsed.
       */
      amount?: string;
      paymentToken?: Address;
      /**
       * Free-form rationale, populated for COUNTER (the LLM's reason
       * for the counter) and REJECT (why the proposal was turned down).
       * Never echoed for PROPOSE/ACCEPT.
       */
      reason?: string;
      at: string;
    }
  | {
      type: "negotiation.receive";
      agentRole: AgentRole;
      verb: "PROPOSE" | "COUNTER" | "ACCEPT" | "REJECT";
      counterpart: Hex;
      amount?: string;
      paymentToken?: Address;
      reason?: string;
      at: string;
    }
  | {
      type: "job.created";
      agentRole: AgentRole;
      jobId: string;
      chainId: number;
      txHash: Hex;
      at: string;
    }
  | {
      type: "job.funded";
      agentRole: AgentRole;
      jobId: string;
      chainId: number;
      txHash: Hex;
      budget: string;
      at: string;
    }
  | {
      type: "job.submitted";
      agentRole: AgentRole;
      jobId: string;
      chainId: number;
      txHash: Hex;
      deliverableRoot: Hex;
      /**
       * MIME type the provider attached to the deliverable. Lets UIs
       * branch on the deliverable shape — `application/vnd.acl.inft-
       * pointer` is a 32-byte commitment NOT stored in 0G Storage, so
       * downstream consumers should skip the storage download for that
       * content type.
       */
      contentType: string;
      at: string;
    }
  | {
      type: "job.settled";
      agentRole: AgentRole;
      jobId: string;
      chainId: number;
      txHash: Hex;
      approved: boolean;
      at: string;
    }
  | {
      type: "evaluator.evaluated";
      agentRole: AgentRole;
      jobId: string;
      modelId: string;
      approved: boolean;
      score: number;
      teeVerified: boolean | null;
      at: string;
    }
  // ---------- Semantic lifecycle events (Section 2.7) ----------
  // These fire on the same bus as the lower-level chain/storage events
  // and carry enough context for downstream policies (e.g. an
  // autonomous Phase-2 trigger) to act without re-querying the chain.
  | {
      type: "job.settled.client-side";
      agentRole: "client";
      jobId: string;
      chainId: number;
      txHash: Hex;
      /** Terminal state of the on-chain job. */
      finalState: "completed" | "rejected";
      /**
       * Back-compat mirror of `finalState === 'completed'`. Newer
       * consumers should branch on `finalState`; we keep `approved`
       * for callers that already wired it.
       */
      approved: boolean;
      attestationRoot: Hex;
      /** Optional deliverable storage root, when known. */
      deliverableRoot?: Hex;
      /**
       * Provider whose ACCEPT the client signed in this job. Captured
       * at negotiation time so downstream policies (e.g. Phase-2
       * acquisition) don't have to re-query ENS/CCIP-Read.
       */
      providerProfile: AgentProfile;
      /**
       * Capabilities the provider advertises via ENSIP-26
       * `agent-context.capabilities`. Already lowercased + deduped at
       * profile-parse time.
       */
      capabilities: ReadonlyArray<string>;
      /** Free-form brief the caller passed to `runJob`. */
      brief: string;
      /** Verbatim caller input — useful for replay / autonomous follow-ups. */
      runJobInput: RunJobInput;
      /**
       * `true` when this settlement was driven by the client itself
       * via `selfComplete` (Phase-2 / iNFT acquisition path). Phase-2
       * triggers MUST gate on `!ev.selfComplete` to avoid recursing
       * into themselves.
       */
      selfComplete: boolean;
      /** Verbatim TaskSpec the provider executed against. */
      taskSpec: TaskSpec;
      /**
       * Lazy fetch + parse of the attestation bundle stored at the
       * `JobCompleted.reason` 0G Storage root. Returns `null` for
       * Flow 2's iNFT pointer commitment — the reason is the
       * `keccak256(abi.encode(nftContract, tokenId, providerAgentId))`
       * tuple, not a storage root.
       */
      getAttestation: () => Promise<unknown>;
      /** Lazy convenience accessor for `attestation.evaluation.normalizedVerdict.score`. */
      getScoreNormalized: () => Promise<number | null>;
      at: string;
    }
  | {
      type: "job.delivered.provider-side";
      agentRole: "provider";
      jobId: string;
      chainId: number;
      txHash: Hex;
      deliverableRoot: Hex;
      contentType: string;
      taskSpecHash: Hex;
      at: string;
    }
  | {
      type: "job.evaluated.evaluator-side";
      agentRole: "evaluator";
      jobId: string;
      chainId: number;
      txHash: Hex;
      approved: boolean;
      score: number;
      attestationRoot: Hex;
      at: string;
    }
  | { type: "agent.error"; agentRole: AgentRole; message: string; at: string }
  /**
   * Generic carrier for app-defined events that need to ride the same
   * agent event bus (and therefore reach UIs, SSE forwarders, and
   * audit logs over the same code path) without polluting the SDK
   * with example-specific event names.
   *
   * The SDK never emits this type itself — it exists purely as a
   * forwards-compatible escape hatch. App code stamps a fully
   * scoped `name` (e.g. `"phase2.completed"`) and an opaque `payload`;
   * downstream consumers are responsible for understanding the schema
   * matched to their own `name` namespace.
   */
  | {
      type: "app.event";
      agentRole: AgentRole;
      /** Dotted, app-scoped event name (e.g. `"phase2.acquired"`). */
      name: string;
      payload: Record<string, unknown>;
      at: string;
    };

export type AgentRole = "client" | "provider" | "evaluator";

export type AgentEventListener = (event: AgentEvent) => void;
