import type { AclDeployment, GasFeeOverrides } from "@acl/core";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

/**
 * Configuration for {@link createJobOrchestrator}. Supplies the chain
 * + clients + addresses the orchestrator binds to. Designed so the
 * happy-path call site is one line and every default is overridable.
 *
 * The `walletClient.account` MUST be set; the orchestrator uses it for
 * every write. We don't enforce it at the type level so that any viem
 * `WalletClient` shape can be passed (e.g. one created with
 * `account: undefined` and later switched), but `_requireAccount`
 * checks at the call boundary.
 */
export type JobOrchestratorConfig = {
  /**
   * Read client for views (`getJob`, `paymentToken`, allowance polls,
   * etc.). MUST point at the same chain as `walletClient`.
   */
  publicClient: PublicClient;
  /**
   * Write client. The orchestrator uses `walletClient.account` for
   * `from` on every tx, so consumers are in full control of how the
   * account is wired (e.g. browser wallet, `privateKeyToAccount`,
   * smart-account).
   */
  walletClient: WalletClient;
  /**
   * Pin the deployed ACL addresses. Defaults to `ACL_TESTNET` if
   * omitted; pass a private deployment to point at staging contracts.
   */
  deployment?: AclDeployment;
  /**
   * Override `AgenticCommerce` (defaults to `deployment.galileo.agenticCommerce`).
   */
  agenticCommerce?: Address;
  /**
   * Override `ACLEvaluator` (defaults to `deployment.galileo.aclEvaluator`).
   */
  aclEvaluator?: Address;
  /**
   * Override the ERC-20 used to fund the escrow. Defaults to the test
   * USDC the SDK ships with on testnet; production deployments will
   * point this at real USDC.
   */
  paymentToken?: Address;
  /**
   * Optional gas/fee overrides applied to every `writeContract` the
   * orchestrator issues. Default: undefined (viem estimates EIP-1559
   * fees from the chain). Pass `{ type: 'legacy', gasPrice }` for
   * chains that disabled type-2 transactions.
   */
  gasFeeOverrides?: GasFeeOverrides;
};

/** Inputs for {@link JobOrchestrator.createJob}. */
export type CreateJobParams = {
  /**
   * `provider` written into the new job. Pass `0x0...` to leave the
   * job open and assign provider later via `setProvider`.
   */
  provider: Address;
  evaluator: Address;
  /** Unix seconds expiry — must be at least `MIN_EXPIRY_BUFFER` (60s) ahead. */
  expiredAt: bigint;
  description: string;
  /** Whitelisted hook (e.g. ReputationHook). `0x0...` for the no-hook path. */
  hook: Address;
};

export type SetProviderParams = {
  jobId: bigint;
  provider: Address;
  /** Hook-specific opt-params; e.g. `abi.encode(uint256)` for ReputationHook. */
  optParams?: Hex;
};

export type SetBudgetParams = {
  jobId: bigint;
  amount: bigint;
  optParams?: Hex;
};

export type FundParams = {
  jobId: bigint;
  /**
   * Front-running guard: passing the budget the caller observed is
   * required by `AgenticCommerce.fund(jobId, expectedBudget, optParams)`.
   */
  expectedBudget: bigint;
  /**
   * When `true`, the orchestrator issues `paymentToken.approve(commerce, amount)`
   * if the current allowance is below `expectedBudget`. Default: true,
   * because "fund without approve first" is the most common foot-gun
   * for this flow.
   */
  autoApprove?: boolean;
  /**
   * Override the ERC-20 the orchestrator approves before forwarding to
   * `AgenticCommerce.fund(...)`. Defaults to the orchestrator's
   * configured `paymentToken` (i.e. `deployment.galileo.testUSDC`).
   *
   * Required when the on-chain `JobProposal` advertises a non-default
   * payment token (e.g. when callers of `ClientAgent.runJob` pass
   * `RunJobInput.paymentToken`); without it the orchestrator would
   * approve the default token while the contract pulls funds in the
   * negotiated one.
   */
  paymentToken?: Address;
  optParams?: Hex;
};

export type SubmitParams = {
  jobId: bigint;
  /** 0G Storage root hash of the deliverable. */
  deliverable: Hex;
  optParams?: Hex;
};

export type SettleParams = {
  jobId: bigint;
  /**
   * `true` → calls `complete(jobId, root, optParams)`.
   * `false` → calls `reject(jobId, root, optParams)`.
   */
  approved: boolean;
  /** 0G Storage root of the attestation bundle. */
  attestationRoot: Hex;
  /**
   * 0G Compute provider that ran the inference behind this verdict. The
   * `ACLEvaluator` contract reads `InferenceServing.getService(provider)`
   * to recover the registered TEE signer address.
   */
  computeProvider: Address;
  /**
   * Exact bytes the TEE signed (as returned by 0G Compute's
   * `<svc.url>/v1/proxy/signature/:chatID` endpoint and surfaced on
   * `EvaluationResult.signedText`). The contract does
   * `recover(toEthSignedMessageHash(signedText), teeSignature)`.
   */
  signedText: Hex;
  /** EIP-191 personal_sign signature over `signedText`. */
  teeSignature: Hex;
  optParams?: Hex;
};

/**
 * Direct-settle inputs for {@link JobOrchestrator.complete} /
 * {@link JobOrchestrator.reject} — the buyer-as-evaluator (Section 2.10)
 * path that bypasses `ACLEvaluator.settle()` because no TEE proof exists
 * (e.g. for an iNFT acquisition where the deliverable IS the iNFT
 * pointer, not a model inference).
 *
 * The on-chain ABI calls this field `bytes32 reason`; the SDK names it
 * `attestationRoot` for clarity. Same 32 bytes, passed straight through
 * to the contract.
 */
export type DirectSettleParams = {
  jobId: bigint;
  /**
   * `bytes32 reason` arg of `JobCompleted` / `JobRejected`. For Flow 2
   * the canonical default is
   * `keccak256(abi.encode(nftContract, tokenId, providerAgentId))` — the
   * iNFT pointer commitment exposed by `inftDeliverableCommitment` in
   * `@acl/inft`. Other flows can use any 32-byte commitment.
   */
  attestationRoot: Hex;
  /** Hook-specific opt-params; defaults to `0x` (empty). */
  optParams?: Hex;
};
