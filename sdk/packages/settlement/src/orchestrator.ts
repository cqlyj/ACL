import {
  ACL_TESTNET,
  type AclDeployment,
  type GasFeeOverrides,
  abis,
  feeFields,
  requireWalletAccount,
  waitForReceiptResilient,
} from "@acl/core";
import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
} from "viem";
import { JOB_CREATED_EVENT } from "./events.js";
import type {
  CreateJobParams,
  DirectSettleParams,
  FundParams,
  JobOrchestratorConfig,
  SetBudgetParams,
  SetProviderParams,
  SettleParams,
  SubmitParams,
} from "./types.js";

const ZERO_HEX: Hex = "0x";

/**
 * Tiny wrapper around `AgenticCommerce` and `ACLEvaluator`. Pure
 * pass-through that:
 *
 *   - resolves contract addresses once (no per-call config),
 *   - issues `paymentToken.approve(...)` automatically before `fund()`
 *     so consumers don't have to remember the two-tx idiom,
 *   - returns `bigint` jobIds parsed from `JobCreated` log,
 *   - exposes `getJob(jobId)` for the view surface.
 *
 * The orchestrator deliberately keeps the API 1:1 with the on-chain
 * ABI: each method maps to one transaction. Callers compose the full
 * lifecycle themselves rather than the SDK trying to be opinionated
 * about state-machine sequencing — different flows (Flow 1 vs Flow 2)
 * legitimately need different orderings.
 */
export class JobOrchestrator {
  private readonly _publicClient: PublicClient;
  private readonly _walletClient: WalletClient;
  private readonly _gasFeeOverrides: GasFeeOverrides | undefined;
  readonly agenticCommerce: Address;
  readonly aclEvaluator: Address;
  readonly paymentToken: Address;

  constructor(opts: {
    publicClient: PublicClient;
    walletClient: WalletClient;
    agenticCommerce: Address;
    aclEvaluator: Address;
    paymentToken: Address;
    gasFeeOverrides?: GasFeeOverrides;
  }) {
    this._publicClient = opts.publicClient;
    this._walletClient = opts.walletClient;
    this.agenticCommerce = opts.agenticCommerce;
    this.aclEvaluator = opts.aclEvaluator;
    this.paymentToken = opts.paymentToken;
    this._gasFeeOverrides = opts.gasFeeOverrides;
  }

  /**
   * EIP-1559 / legacy fee fields to spread into every `writeContract`
   * call. Returns an empty object when no overrides were configured —
   * viem then estimates fees from the chain. Centralising the spread
   * here keeps the seven write paths boring.
   */
  private _feeFields() {
    return feeFields(this._gasFeeOverrides);
  }

  // ---------- write ----------

  /**
   * Create a new ERC-8183 job. Returns the parsed `jobId` from the
   * `JobCreated` log so consumers can chain `setProvider` / `setBudget`
   * / `fund` without re-querying the contract.
   */
  async createJob(
    params: CreateJobParams,
  ): Promise<{ jobId: bigint; txHash: Hex }> {
    const account = this._requireAccount();
    const txHash = await this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "createJob",
      args: [
        params.provider,
        params.evaluator,
        params.expiredAt,
        params.description,
        params.hook,
      ],
      ...this._feeFields(),
    });
    const receipt = await waitForReceiptResilient(this._publicClient, txHash);
    const jobId = _parseJobIdFromLogs(receipt.logs, this.agenticCommerce);
    return { jobId, txHash };
  }

  async setProvider(params: SetProviderParams): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "setProvider",
      args: [params.jobId, params.provider, params.optParams ?? ZERO_HEX],
      ...this._feeFields(),
    });
  }

  async setBudget(params: SetBudgetParams): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "setBudget",
      args: [params.jobId, params.amount, params.optParams ?? ZERO_HEX],
      ...this._feeFields(),
    });
  }

  /**
   * Fund the escrow. By default also issues `paymentToken.approve(...)`
   * if the current allowance is below `expectedBudget`. Set
   * `autoApprove: false` to manage approvals yourself (e.g. via
   * permit). Pass `paymentToken` to approve a token other than the
   * orchestrator's bound default (needed when the on-chain
   * `JobProposal` advertises a per-job token).
   */
  async fund(params: FundParams): Promise<Hex> {
    const token = params.paymentToken ?? this.paymentToken;
    const autoApprove = params.autoApprove ?? true;
    if (autoApprove) {
      await this._ensureAllowance(params.expectedBudget, token);
    }
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "fund",
      args: [params.jobId, params.expectedBudget, params.optParams ?? ZERO_HEX],
      ...this._feeFields(),
    });
  }

  async submit(params: SubmitParams): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "submit",
      args: [params.jobId, params.deliverable, params.optParams ?? ZERO_HEX],
      ...this._feeFields(),
    });
  }

  /**
   * Settle the job through `ACLEvaluator.settle`. Requires `msg.sender`
   * to be a previously authorised operator on the evaluator contract.
   *
   * The contract verifies `recover(toEthSignedMessageHash(signedText),
   * teeSignature) == InferenceServing.getService(computeProvider).teeSignerAddress`
   * before forwarding to `complete` / `reject`, so the (computeProvider,
   * signedText, teeSignature) triple MUST come from a real 0G Compute
   * TEE response — typically straight off `EvaluationResult` returned
   * by `@acl/evaluation`'s `evaluate()`.
   */
  async settleViaEvaluator(params: SettleParams): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.aclEvaluator,
      abi: abis.aclEvaluatorAbi,
      functionName: "settle",
      args: [
        this.agenticCommerce,
        params.jobId,
        params.approved,
        params.attestationRoot,
        params.computeProvider,
        params.signedText,
        params.teeSignature,
        params.optParams ?? ZERO_HEX,
      ],
      ...this._feeFields(),
    });
  }

  /**
   * Direct-settle path: call `AgenticCommerce.complete(jobId,
   * attestationRoot, optParams)` from `walletClient.account` (the
   * "buyer-as-evaluator" flow, Section 2.10 of the SDK plan).
   *
   * The on-chain guard `msg.sender == job.evaluator` is what enforces
   * the design — this orchestrator does NOT pre-check, so the same
   * wrapper works for both delegated-operator and self-evaluator
   * topologies. Reverts on chain with `Unauthorized` when the bound
   * wallet is not the job's evaluator.
   *
   * Use this when the deliverable is something other than a model
   * inference (e.g. an iNFT pointer commitment) and there is no TEE
   * proof for `ACLEvaluator.settle()` to verify. For the Flow-1
   * TEE-attested path keep using {@link settleViaEvaluator}; the two
   * settlement paths coexist.
   */
  async complete(params: DirectSettleParams): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "complete",
      args: [
        params.jobId,
        params.attestationRoot,
        params.optParams ?? ZERO_HEX,
      ],
      ...this._feeFields(),
    });
  }

  /**
   * Direct-reject path — symmetric to {@link complete}. Same on-chain
   * `msg.sender == job.evaluator` guard.
   */
  async reject(params: DirectSettleParams): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "reject",
      args: [
        params.jobId,
        params.attestationRoot,
        params.optParams ?? ZERO_HEX,
      ],
      ...this._feeFields(),
    });
  }

  /**
   * Authorise an operator on the bound `ACLEvaluator`. Only callable
   * by the evaluator owner. Surfaced because Flow 1 demos always need
   * an operator authorised before they can call `settle()` — keeping
   * it inside the orchestrator avoids the consumer having to wire in
   * the evaluator ABI separately.
   */
  async setEvaluatorOperator(
    operator: Address,
    authorized: boolean,
  ): Promise<Hex> {
    const account = this._requireAccount();
    return this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: this.aclEvaluator,
      abi: abis.aclEvaluatorAbi,
      functionName: "setOperator",
      args: [operator, authorized],
      ...this._feeFields(),
    });
  }

  // ---------- read ----------

  async getJob(jobId: bigint) {
    return this._publicClient.readContract({
      address: this.agenticCommerce,
      abi: abis.agenticCommerceAbi,
      functionName: "getJob",
      args: [jobId],
    });
  }

  async authorizedOperator(operator: Address): Promise<boolean> {
    return this._publicClient.readContract({
      address: this.aclEvaluator,
      abi: abis.aclEvaluatorAbi,
      functionName: "authorizedOperators",
      args: [operator],
    });
  }

  /**
   * `balanceOf(addr)` on `token` (defaults to the orchestrator's bound
   * `paymentToken`). Pass `token` to query a different ERC-20 — useful
   * when a job's `JobProposal` advertised a non-default payment token.
   */
  async paymentBalanceOf(addr: Address, token?: Address): Promise<bigint> {
    return this._publicClient.readContract({
      address: token ?? this.paymentToken,
      abi: abis.ierc20Abi,
      functionName: "balanceOf",
      args: [addr],
    });
  }

  // ---------- internals ----------

  /**
   * Idempotently approve at least `amount` of `token` for the
   * orchestrator's commerce contract. Skips the tx when the current
   * allowance already covers `amount` — keeps repeated `fund()` calls
   * cheap.
   */
  private async _ensureAllowance(
    amount: bigint,
    token: Address,
  ): Promise<void> {
    const account = this._requireAccount();
    const current: bigint = await this._publicClient.readContract({
      address: token,
      abi: abis.ierc20Abi,
      functionName: "allowance",
      args: [account.address, this.agenticCommerce],
    });
    if (current >= amount) return;

    const approveHash = await this._walletClient.writeContract({
      account,
      chain: this._walletClient.chain,
      address: token,
      abi: abis.ierc20Abi,
      functionName: "approve",
      args: [this.agenticCommerce, amount],
      ...this._feeFields(),
    });
    await waitForReceiptResilient(this._publicClient, approveHash);
  }

  private _requireAccount(): NonNullable<WalletClient["account"]> {
    return requireWalletAccount(this._walletClient, "JobOrchestrator");
  }
}

/**
 * Build a {@link JobOrchestrator} bound to the supplied clients. Smallest valid
 * usage is one call:
 *
 * ```ts
 * const orchestrator = createJobOrchestrator({ publicClient, walletClient });
 * const { jobId } = await orchestrator.createJob({ ... });
 * ```
 */
export function createJobOrchestrator(
  config: JobOrchestratorConfig,
): JobOrchestrator {
  const deployment: AclDeployment = config.deployment ?? ACL_TESTNET;
  return new JobOrchestrator({
    publicClient: config.publicClient,
    walletClient: config.walletClient,
    agenticCommerce:
      config.agenticCommerce ?? deployment.galileo.agenticCommerce,
    aclEvaluator: config.aclEvaluator ?? deployment.galileo.aclEvaluator,
    paymentToken: config.paymentToken ?? deployment.galileo.testUSDC,
    ...(config.gasFeeOverrides !== undefined
      ? { gasFeeOverrides: config.gasFeeOverrides }
      : {}),
  });
}

/**
 * Pull `jobId` out of the `JobCreated` event in a transaction receipt.
 *
 * Filters logs by topic0 against the `JobCreated` event signature so
 * we don't accidentally pick up a hook-emitted log that happens to
 * have a 32-byte indexed first arg. Only logs originating from the
 * `AgenticCommerce` contract are considered, since hooks frequently
 * re-emit job-shaped events.
 */
function _parseJobIdFromLogs(
  logs: readonly Log[],
  agenticCommerce: Address,
): bigint {
  const lcAgenticCommerce = agenticCommerce.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== lcAgenticCommerce) continue;
    try {
      const decoded = decodeEventLog({
        abi: [JOB_CREATED_EVENT],
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName === "JobCreated") {
        return decoded.args.jobId;
      }
    } catch {
      // Topic mismatch or argument shape mismatch — keep scanning.
    }
  }
  throw new Error(
    "JobOrchestrator.createJob: no JobCreated log found in receipt",
  );
}
