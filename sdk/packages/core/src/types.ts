import type { Address, Hex } from "viem";

/**
 * Canonical agent profile surfaced by ACL discovery.
 */
export type AgentProfile = {
  /** Fully-qualified ENS name, e.g. "researcher.acl.eth". */
  ensName: string;
  /** Sub-label under the parent ACL ENS name (e.g. "researcher"). */
  ensLabel: string;
  /** ERC-8004 numeric agent id. */
  agentId: bigint;
  /** Chain id where the IdentityRegistry lives. */
  chainId: number;
  /** Address of the IdentityRegistry. */
  identityRegistry: Address;
  /** Address the agent transacts as (and also the addr() the resolver returns). */
  agentAddress: Address;
  /** Trusted-party evaluator the agent prefers for ERC-8183 attestations. */
  evaluatorAddress: Address;
  /** AXL peer id (hex string, no 0x prefix) used for negotiation. */
  axlPeerId: string;
  /** Comma-separated task domains the agent advertises. */
  taskDomains: string;
  /** Comma-separated supported delivery types. */
  deliveryTypes: string;
  /**
   * ERC-20 tokens the agent will accept payment in. Stored on-chain as
   * `abi.encode(address[])`; flattened to comma-separated checksum addresses
   * over ENS text records and rehydrated by the discovery package.
   */
  paymentTokens: Address[];
  /** Minimum acceptable budget in the primary `paymentToken` smallest-unit. */
  minBudget: bigint;
  /** Reputation summary returned by ACLReputationRegistry.getSummary, if known. */
  score?: ReputationScore;
  /**
   * Parsed ENSIP-26 `agent-context` payload. `capabilities` is the
   * lowercased exact-token list the gateway / SDK filter against.
   * `extra` is the rest of the record (free-form JSON fields like
   * `acl.cap.inft-sale.*`). Always present as an object — falls back
   * to `{ capabilities: [], registries: [], protocols: [], extra: {} }`
   * when the agent has no record OR the record fails JSON parse.
   */
  agentContext?: AgentContext;
  /**
   * Raw UTF-8 string the agent published in the `agent-context` text
   * record, before parsing. Useful for debug UIs and forward-compat
   * (records whose JSON shape we don't recognise yet are still
   * inspectable here).
   */
  agentContextRaw?: string;
};

/**
 * Parsed shape of the ENSIP-26 `agent-context` text record. Lenient by
 * design: every field is optional in the wire JSON; the parser fills
 * in empty arrays so consumers can iterate without null-checks.
 */
export type AgentContext = {
  /**
   * Capability tokens the agent advertises. Lowercased + deduped at
   * parse time so exact-token matching is case-insensitive on the
   * caller side.
   */
  capabilities: string[];
  /** ERC-8004 registry references (chain id + address). */
  registries: string[];
  /** Protocols the agent speaks (e.g. `acl-erc-8183`, `axl-1`). */
  protocols: string[];
  /** Catch-all for forwards-compat fields (e.g. `acl.cap.inft-sale.min-price`). */
  extra: Record<string, unknown>;
};

export type ReputationScore = {
  /** Number of feedback entries that contributed to the summary. */
  count: bigint;
  /**
   * Mean value × 10^summaryValueDecimals. Sourced from the on-chain
   * `int128` field, so it is a SIGNED `bigint` — negative values are
   * legal and indicate net-negative feedback. Callers that rank by
   * "best score" must compare with full bigint semantics (the sign
   * matters), not with `> 0n`-style truthiness.
   */
  summaryValue: bigint;
  /** Decimals applied to summaryValue (defaults to 2 in ERC-8004 v2). */
  summaryValueDecimals: number;
};

/**
 * ACL metadata key constants. Mirror the Solidity-side strings exactly so the
 * SDK and the registry never drift. Keep the wire format aligned with
 * `script/lib/AgentMetadataBuilder.sol`.
 */
export const ACL_METADATA_KEYS = {
  agentAddress: "acl.agent-address",
  evaluatorAddress: "acl.evaluator-address",
  axlPeerId: "acl.axl-peer-id",
  taskDomains: "acl.task-domains",
  deliveryTypes: "acl.delivery-types",
  paymentTokens: "acl.payment-tokens",
  minBudget: "acl.min-budget",
  chainId: "acl.chain-id",
  ensLabel: "acl.ens-label",
  /**
   * Synthetic text record served by the gateway: returns the agent's numeric
   * id as a decimal string. Not stored on-chain (the gateway computes it from
   * its label index), but exposed at the ENS layer so SDK consumers can
   * recover an agentId from a sub-name in a single round-trip.
   */
  agentId: "acl.agent-id",
  /**
   * ENSIP-26 community standard text-record key advertising agent
   * capabilities and protocol context. Stored as opaque UTF-8 bytes
   * by the registry; the SDK and gateway parse it as JSON, falling
   * back to an empty `capabilities: []` shape on parse failure.
   */
  agentContext: "agent-context",
} as const;

export type AclMetadataKey =
  (typeof ACL_METADATA_KEYS)[keyof typeof ACL_METADATA_KEYS];

/**
 * Canonical `taskSpec.deliveryType` value the SDK uses to distinguish
 * the iNFT-acquisition lane (Flow-2) from regular text/markdown
 * deliverables (Flow-1).
 *
 * Defined here so both `@acl/agent` and `@acl/inft` can branch on the
 * same protocol-level identifier without circular imports.
 */
export const INFT_DELIVERY_TYPE = "iNFT" as const;

/**
 * MIME-style content-type the provider stamps on a `Deliverable` (and
 * the on-chain `JobSubmitted.contentType` event field) when the
 * artefact is an iNFT pointer commitment instead of a 0G-Storage
 * upload. Lets buyer / coordinator UIs filter Op-A (iNFT corpus
 * refresh) events without re-decoding the deliverable body.
 */
export const INFT_POINTER_CONTENT_TYPE =
  "application/vnd.acl.inft-pointer" as const;

/**
 * JS-input convenience shape for "the hook contract + the per-call optParams
 * bytes I want forwarded with each ERC-8183 lifecycle call".
 *
 * Strict scope: this type is JS-input-only. The on-the-wire
 * (`JobProposal.hook`) and on-chain (`Job.hook`, `IACPHook` arg) shapes
 * stay `Address`-only. Negotiation and contract calls flatten
 * `hook?.address ?? zeroAddress` at the SDK boundary; only the SDK's typed
 * inputs gain the structured form.
 *
 * Why no methods / generics / "what the bytes mean": agent classes accept
 * `hook?: HookConfig` and forward bytes verbatim. They never inspect what
 * the bytes mean. Hook-specific factories (e.g. `reputationHook(...)` in
 * `@acl/settlement`, `inftDeliveryHook(...)` in `@acl/inft`) produce these
 * objects; custom 3rd-party hooks are assembled by the caller with viem.
 */
export type HookConfig = {
  address: Address;
  optParams?: {
    setProvider?: Hex;
    setBudget?: Hex;
    fund?: Hex;
    submit?: Hex;
    complete?: Hex;
    reject?: Hex;
  };
};
