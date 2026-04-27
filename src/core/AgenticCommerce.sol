// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IACPHook} from "../interfaces/IACPHook.sol";
import {ACLConstants} from "../libraries/ACLConstants.sol";

/// @title AgenticCommerce
/// @notice ERC-8183 Agent Commerce Protocol job escrow.
/// @dev Lifecycle: Open -> Funded -> Submitted -> Completed / Rejected / Expired.
///      Hookable functions invoke IACPHook.beforeAction / afterAction with a hard
///      gas cap (HOOK_GAS_LIMIT) so a misbehaving hook cannot brick the contract.
///      All hook payloads follow the normative ERC-8183 encoding for each selector.
contract AgenticCommerce is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    /// @notice Hard gas cap for every hook call (before/after).
    /// @dev ERC-8183 RECOMMENDS bounding hook execution. 2M gas is more than enough
    ///      for typical NFT escrow / reputation writes while leaving room for the
    ///      caller's own logic and refunds; out-of-gas in a hook reverts the call.
    uint256 public constant HOOK_GAS_LIMIT = 2_000_000;

    IERC20 public immutable paymentToken;
    uint256 public platformFeeBps;
    address public platformTreasury;
    uint256 public evaluatorFeeBps;

    uint256 public jobCounter;
    mapping(uint256 => Job) internal _jobs;
    mapping(uint256 => bool) public jobHasBudget;
    mapping(address => bool) public whitelistedHooks;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(
        uint256 indexed jobId,
        address indexed client,
        uint256 amount
    );
    event JobSubmitted(
        uint256 indexed jobId,
        address indexed provider,
        bytes32 deliverable
    );
    event JobCompleted(
        uint256 indexed jobId,
        address indexed evaluator,
        bytes32 reason
    );
    event JobRejected(
        uint256 indexed jobId,
        address indexed rejector,
        bytes32 reason
    );
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(
        uint256 indexed jobId,
        address indexed provider,
        uint256 amount
    );
    event EvaluatorFeePaid(
        uint256 indexed jobId,
        address indexed evaluator,
        uint256 amount
    );
    event Refunded(
        uint256 indexed jobId,
        address indexed client,
        uint256 amount
    );
    event HookWhitelistUpdated(address indexed hook, bool status);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error ExpiryTooShort();
    error ZeroBudget();
    error BudgetMismatch();
    error ProviderNotSet();
    error ProviderAlreadySet();
    error FeesTooHigh();
    error HookNotWhitelisted();
    error HookInterfaceUnsupported();
    error NotExpired();

    constructor(
        address paymentToken_,
        address treasury_,
        address owner_
    ) Ownable(owner_) {
        if (paymentToken_ == address(0) || treasury_ == address(0))
            revert ZeroAddress();
        paymentToken = IERC20(paymentToken_);
        platformTreasury = treasury_;
        whitelistedHooks[address(0)] = true;
    }

    // ---------- Admin ----------

    function setPlatformFee(
        uint256 feeBps_,
        address treasury_
    ) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ + evaluatorFeeBps > ACLConstants.MAX_FEE_BPS)
            revert FeesTooHigh();
        platformFeeBps = feeBps_;
        platformTreasury = treasury_;
    }

    function setEvaluatorFee(uint256 feeBps_) external onlyOwner {
        if (feeBps_ + platformFeeBps > ACLConstants.MAX_FEE_BPS)
            revert FeesTooHigh();
        evaluatorFeeBps = feeBps_;
    }

    function setHookWhitelist(address hook, bool status) external onlyOwner {
        if (hook == address(0)) revert ZeroAddress();
        whitelistedHooks[hook] = status;
        emit HookWhitelistUpdated(hook, status);
    }

    // ---------- Hook plumbing ----------

    /// @dev Hook calls forward at most HOOK_GAS_LIMIT gas. Any revert in the
    ///      hook propagates with its original reason so dApps can debug.
    function _beforeHook(
        address hook,
        uint256 jobId,
        bytes4 selector_,
        bytes memory data
    ) internal {
        if (hook == address(0)) return;
        IACPHook(hook).beforeAction{gas: HOOK_GAS_LIMIT}(
            jobId,
            selector_,
            data
        );
    }

    function _afterHook(
        address hook,
        uint256 jobId,
        bytes4 selector_,
        bytes memory data
    ) internal {
        if (hook == address(0)) return;
        IACPHook(hook).afterAction{gas: HOOK_GAS_LIMIT}(jobId, selector_, data);
    }

    // ---------- Core ----------

    /// @notice Create a job. provider MAY be address(0) and set later via setProvider.
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external nonReentrant returns (uint256) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp + ACLConstants.MIN_EXPIRY_BUFFER)
            revert ExpiryTooShort();
        if (!whitelistedHooks[hook]) revert HookNotWhitelisted();
        if (hook != address(0)) {
            if (
                !ERC165Checker.supportsInterface(
                    hook,
                    type(IACPHook).interfaceId
                )
            ) {
                revert HookInterfaceUnsupported();
            }
        }

        uint256 jobId = ++jobCounter;
        _jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: hook
        });

        emit JobCreated(
            jobId,
            msg.sender,
            provider,
            evaluator,
            expiredAt,
            hook
        );
        return jobId;
    }

    /// @notice Set provider on an Open job. Client-only.
    function setProvider(
        uint256 jobId,
        address provider_,
        bytes calldata optParams
    ) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert ProviderAlreadySet();
        if (provider_ == address(0)) revert ZeroAddress();

        bytes memory data = abi.encode(provider_, optParams);
        _beforeHook(job.hook, jobId, msg.sig, data);

        job.provider = provider_;
        emit ProviderSet(jobId, provider_);

        _afterHook(job.hook, jobId, msg.sig, data);
    }

    /// @notice Set budget on an Open job. Either client or provider may call.
    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata optParams
    ) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.provider && msg.sender != job.client)
            revert Unauthorized();

        bytes memory data = abi.encode(amount, optParams);
        _beforeHook(job.hook, jobId, msg.sig, data);

        job.budget = amount;
        jobHasBudget[jobId] = true;
        emit BudgetSet(jobId, amount);

        _afterHook(job.hook, jobId, msg.sig, data);
    }

    /// @notice Fund escrow. Client-only. expectedBudget guards against front-running re-budget.
    function fund(
        uint256 jobId,
        uint256 expectedBudget,
        bytes calldata optParams
    ) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();

        bytes memory data = optParams;
        _beforeHook(job.hook, jobId, msg.sig, data);

        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(job.client, address(this), job.budget);
        emit JobFunded(jobId, job.client, job.budget);

        _afterHook(job.hook, jobId, msg.sig, data);
    }

    /// @notice Provider submits work. deliverable is a bytes32 commitment (e.g. 0G Storage root).
    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();

        bytes memory data = abi.encode(deliverable, optParams);
        _beforeHook(job.hook, jobId, msg.sig, data);

        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, job.provider, deliverable);

        _afterHook(job.hook, jobId, msg.sig, data);
    }

    /// @notice Evaluator completes job. Releases escrow to provider minus fees.
    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();

        bytes memory data = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, msg.sig, data);

        job.status = JobStatus.Completed;

        uint256 amount = job.budget;
        uint256 platformFee = (amount * platformFeeBps) /
            ACLConstants.BPS_DENOMINATOR;
        uint256 evalFee = (amount * evaluatorFeeBps) /
            ACLConstants.BPS_DENOMINATOR;
        uint256 net = amount - platformFee - evalFee;

        if (platformFee > 0) {
            paymentToken.safeTransfer(platformTreasury, platformFee);
        }
        if (evalFee > 0) {
            paymentToken.safeTransfer(job.evaluator, evalFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evalFee);
        }
        if (net > 0) {
            paymentToken.safeTransfer(job.provider, net);
        }

        emit JobCompleted(jobId, job.evaluator, reason);
        emit PaymentReleased(jobId, job.provider, net);

        _afterHook(job.hook, jobId, msg.sig, data);
    }

    /// @notice Reject a job. Client-only when Open. Evaluator-only when Funded or Submitted.
    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();

        if (job.status == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (
            job.status == JobStatus.Funded || job.status == JobStatus.Submitted
        ) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        bytes memory data = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, msg.sig, data);

        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;

        if (
            (prev == JobStatus.Funded || prev == JobStatus.Submitted) &&
            job.budget > 0
        ) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        emit JobRejected(jobId, msg.sender, reason);

        _afterHook(job.hook, jobId, msg.sig, data);
    }

    /// @notice Refund client after expiry. Not hookable.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted)
            revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert NotExpired();

        job.status = JobStatus.Expired;

        if (job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        emit JobExpired(jobId);
    }

    // ---------- Views ----------

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }
}
