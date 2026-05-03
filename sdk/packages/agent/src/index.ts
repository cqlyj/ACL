/**
 * `@acl/agent` is the umbrella package for the ACL SDK.
 *
 * It re-exports the protocol primitives from the lower-level packages
 * so a typical consumer needs a single import line, and adds the one
 * piece that isn't a primitive: {@link createAgentRuntime}, the chain
 * wiring kernel that every ACL agent needs (viem clients on Galileo +
 * Sepolia, ethers signer for 0G SDKs, 0G Storage wrapper).
 *
 * The umbrella is intentionally surface-only: every name re-exported
 * here keeps living in its source package, so apps that prefer
 * fine-grained imports (`@acl/core`, `@acl/discovery`, `@acl/storage`,
 * …) keep working unchanged.
 */

export {
  type AgentEthersSigner,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentRuntimeOverrides,
  createAgentRuntime,
  pickRuntimeOverrides,
} from "./runtime.js";

// ----- Agent classes -----------------------------------------------
export {
  ClientAgent,
  DEFAULT_ALLOWED_DOMAINS,
  pickOpeningBudget,
  type RunJobInput,
} from "./agents/client.js";
export { ProviderAgent } from "./agents/provider.js";
export {
  EvaluatorAgent,
  createDefaultEvaluator,
  ensureEvaluatorOperator,
} from "./agents/evaluator.js";
export type {
  AgentBaseConfig,
  ClientAgentConfig,
  ClientJobResult,
  EvaluatorAgentConfig,
  ProviderAgentConfig,
} from "./agents/types.js";
export {
  DEFAULT_MAX_NEGOTIATION_ATTEMPTS,
  DEFAULT_NEGOTIATION_TIMEOUT_MS,
  DEFAULT_PROVIDER_AXL_POLL_INTERVAL_MS,
} from "./agents/types.js";

// ----- LLM backends ------------------------------------------------
export type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatRole,
  LLMBackend,
} from "./llm/backend.js";
export {
  createOpenAICompatibleBackend,
  type OpenAICompatibleConfig,
} from "./llm/openai-compat.js";
export {
  ZG_ROUTER_TESTNET_BASE_URL,
  createZGRouterBackend,
  type ZGRouterConfig,
} from "./llm/zg-router.js";
export {
  CLIENT_AUTHOR_TASKSPEC_PROMPT,
  CLIENT_NEGOTIATE_RESPONSE_PROMPT,
  CLIENT_PICK_DOMAIN_PROMPT,
  CLIENT_RANK_PROVIDERS_PROMPT,
  DEFAULT_CLIENT_PROMPTS,
  DEFAULT_PROVIDER_PROMPTS,
  PROVIDER_DECIDE_PROMPT,
  PROVIDER_DELIVERABLE_PROMPT,
  resolvePrompts,
} from "./llm/prompts.js";
export type { ClientPrompts, ProviderPrompts } from "./llm/prompts.js";

// ----- Events ------------------------------------------------------
export {
  AgentEventBus,
  createAgentEventBus,
  serializeAgentEvent,
} from "./events/bus.js";
export type {
  AgentEvent,
  AgentEventListener,
  AgentRole,
} from "./events/types.js";

// ----- Bootstrap helpers -------------------------------------------
export {
  bootstrapAxl,
  type AxlBootstrap,
  type AxlBootstrapInput,
} from "./bootstrap/axl.js";
export {
  registerAclAgent,
  type RegisterAclAgentInput,
  type RegisterAclAgentResult,
} from "./bootstrap/ens.js";
export {
  DEFAULT_AXL_API_HOST,
  DEFAULT_AXL_API_PORT,
  DEFAULT_AXL_CONFIG_PATH,
  DEFAULT_AXL_PEER_KEY,
  DEFAULT_AXL_TCP_PORT,
  writeAxlConfig,
  type AxlConfig,
} from "./bootstrap/axl-config.js";
export {
  DEFAULT_AXL_BIN,
  spawnAxlBridge,
  type SpawnAxlBridgeInput,
  type SpawnAxlBridgeResult,
} from "./bootstrap/spawn-axl.js";

// ----- @acl/core ----------------------------------------------------
//
// Curated re-export. We avoid `export *` because `@acl/core` also
// publishes the raw ABIs namespace, which would collide with the
// `abis` re-export below.
export {
  ACL_METADATA_KEYS,
  ACL_TESTNET,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_TRANSPORT_RETRY_COUNT,
  DEFAULT_TRANSPORT_RETRY_DELAY_MS,
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  GALILEO_PUBLIC_RPC_URL,
  INFT_DELIVERY_TYPE,
  INFT_POINTER_CONTENT_TYPE,
  JOB_PROPOSAL_TYPES,
  SEPOLIA_PUBLIC_RPC_URL,
  abis,
  buildAgentRegistrationKey,
  buildJobProposalDomain,
  canonicalJson,
  createEnsClient,
  createGalileoClients,
  defineGalileoChain,
  hashTaskSpec,
  toAccount,
  waitForReceiptResilient,
} from "@acl/core";
export type {
  AccountLike,
  AclDeployment,
  AclEip712Domain,
  AclMetadataKey,
  AgentProfile,
  AttestationBundle,
  CreateGalileoClientsOptions,
  Deliverable,
  GalileoClients,
  HookConfig,
  HttpTransportOptions,
  JobProposal,
  NormalizedVerdict,
  ReputationScore,
  TaskSpec,
  WaitForReceiptOptions,
} from "@acl/core";

// ----- @acl/discovery ----------------------------------------------
export {
  AgentResolver,
  createAgentResolver,
  fetchAgentProfile,
  fetchReputation,
  searchAgents,
  verifyEnsip25,
} from "@acl/discovery";
export type {
  AgentCandidate,
  AgentResolverConfig,
  CreateAgentResolverInput,
  DiscoveryPublicClient,
  Ensip25Status,
  ReputationFetchConfig,
  ResolveOptions,
  ResolvedAgent,
  SearchAgentInput,
} from "@acl/discovery";

// ----- @acl/negotiation --------------------------------------------
//
// We re-export everything except the names that already came in via
// `@acl/core` (TaskSpec, hashTaskSpec) — those are canonical there.
export {
  ACL_NEGOTIATION_PROTOCOL,
  AxlBridge,
  DEFAULT_AXL_BRIDGE_RECV_POLL_INTERVAL_MS,
  DEFAULT_AXL_RECV_TIMEOUT_MS,
  Negotiator,
  Transcript,
  assertTaskSpecMatchesProposal,
  createNegotiator,
  deserializeJobProposal,
  generateNonce,
  isNegotiationMessage,
  makeEnvelope,
  recoverJobProposalSigner,
  serializeJobProposal,
  signJobProposal,
  verifyJobProposalSignature,
} from "@acl/negotiation";
export type {
  AcceptMessage,
  AcceptPayload,
  AckMessage,
  AckPayload,
  AxlBridgeConfig,
  AxlTopology,
  CancelMessage,
  CancelPayload,
  CounterMessage,
  CounterPayload,
  Envelope,
  ErrorMessage,
  ErrorPayload,
  HelloMessage,
  HelloPayload,
  JobProposalDraft,
  NegotiationMessage,
  NegotiationMessageType,
  NegotiatorConfig,
  ProposeMessage,
  ProposePayload,
  ReceivedMessage,
  RejectMessage,
  RejectPayload,
  SerializedJobProposal,
  TranscriptDirection,
  TranscriptEntry,
} from "@acl/negotiation";

// ----- @acl/storage -------------------------------------------------
export {
  AclStorage,
  ZG_STORAGE_TURBO_INDEXER,
  createAclStorage,
} from "@acl/storage";
export type { AclStorageConfig, UploadResult } from "@acl/storage";

// ----- @acl/evaluation ---------------------------------------------
export {
  DEFAULT_EVALUATOR_SYSTEM_PROMPT,
  DEFAULT_MODEL_MATCH,
  KNOWN_MODELS,
  buildAttestationBundle,
  createEvaluator,
  extractResponseId,
  parseStrictVerdict,
} from "@acl/evaluation";
export type {
  BuildBundleParams,
  EnsureFundedOptions,
  EvaluateParams,
  EvaluationResult,
  Evaluator,
  EvaluatorConfig,
  KnownModel,
} from "@acl/evaluation";

// ----- @acl/settlement ---------------------------------------------
export {
  JOB_STATUS,
  JobOrchestrator,
  createJobOrchestrator,
  getLogsPaginated,
  reputationHook,
  watchJobLifecycle,
} from "@acl/settlement";
export type {
  CreateJobParams,
  DirectSettleParams,
  FundParams,
  JobLifecycleEvent,
  JobOrchestratorConfig,
  JobStatusName,
  JobStatusValue,
  ReputationHookInput,
  SetBudgetParams,
  SetProviderParams,
  SettleParams,
  SubmitParams,
  WatchJobLifecycleOptions,
} from "@acl/settlement";

// ----- @acl/inft ---------------------------------------------------
//
// Re-exported through `@acl/agent` so consumers don't have to add
// `@acl/inft` to their package.json just to call the iNFT helpers
// (`prepareInftAcquisition`, `inftDeliveryHook`, …) the iNFT-sale
// flow needs. `INFT_DELIVERY_TYPE` and `INFT_POINTER_CONTENT_TYPE`
// already came in via `@acl/core`, so we omit them here.
export {
  DEFAULT_INTELLIGENT_DATA_URI_PREFIX,
  INFT_SALE_CAPABILITY_KEYS,
  INFT_SALE_HOOK_REASONS,
  INFT_SALE_HOOK_REASON_SELECTORS,
  INftClient,
  KEEP_URI_SENTINEL,
  OracleType,
  TRANSFER_VALIDITY_PROOF_ARRAY_ABI,
  attestationRootForInftHook,
  buildTransferValidityProofForRecipient,
  buildTransferValidityProofs,
  createDemoLocalReencryptionOracle,
  createINftClient,
  decryptIntelligentData,
  decryptIntelligentDataWithKey,
  defaultOwnershipNonce,
  encryptIntelligentData,
  iNftEncryptAndUpdate,
  inftDeliverableCommitment,
  inftDeliveryHook,
  inftSaleDeliverableStrategy,
  isOldDataHashMismatchError,
  parseInftSaleCapability,
  prepareInftAcquisition,
  publicKeyFromPrivateKey,
  randomAccessNonce,
  repointInftAfterAcquisition,
  signAccessProof,
  signOwnershipProof,
  signTransferValidityProof,
} from "@acl/inft";
export type {
  AccessProof,
  AccessProofInput,
  BuildTransferValidityProofForRecipientInput,
  BuildTransferValidityProofsInput,
  DemoLocalReencryptionOracleConfig,
  EncryptedIntelligentData,
  INftClientConfig,
  INftEncryptAndUpdateInput,
  INftEncryptAndUpdateResult,
  InftDeliveryHookInput,
  InftSaleCapability,
  InftSaleCapabilityKey,
  InftSaleDeliverableInput,
  InftSaleDeliverableResult,
  InftSaleDeliverableStrategyConfig,
  InftSaleHookReasonName,
  IntelligentData,
  IntelligentDataEncryptedEvent,
  OwnershipProof,
  OwnershipProofInput,
  PrepareInftAcquisitionInput,
  PrepareInftAcquisitionResult,
  ReencryptionOracle,
  ReencryptionRequest,
  ReencryptionResult,
  RepointInftAfterAcquisitionInput,
  RepointInftAfterAcquisitionResult,
  SignTransferValidityProofInput,
  TransferValidityProof,
} from "@acl/inft";
