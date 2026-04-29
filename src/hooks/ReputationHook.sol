// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IACPHook} from "../interfaces/IACPHook.sol";
import {AgenticCommerce} from "../core/AgenticCommerce.sol";
import {ACLReputationRegistry} from "../registry/ACLReputationRegistry.sol";
import {ACLConstants} from "../libraries/ACLConstants.sol";

/// @title ReputationHook
/// @notice ERC-8183 hook that emits ERC-8004 v2 feedback after settlement.
/// @dev Per ERC-8004 v2 the `clientAddress` of feedback MUST NOT be the agent
///      owner or operator. This hook is whitelisted on the commerce contract
///      but is not registered as an operator on the IdentityRegistry, so the
///      registry's submitter check passes.
///
///      Mapping: each job carries a providerAgentId (uint256). The first time
///      a hookable selector (`setProvider`, `setBudget`, `fund`, or `submit`)
///      arrives with `optParams = abi.encode(uint256 agentId)` we record the
///      mapping. If still unset at complete/reject we revert so misconfigured
///      jobs surface immediately rather than silently skipping reputation.
contract ReputationHook is IACPHook, ERC165 {
    AgenticCommerce public immutable commerce;
    ACLReputationRegistry public immutable reputationRegistry;

    mapping(uint256 => uint256) public providerAgentIdOf;

    error OnlyCommerce();
    error MissingAgentId();

    modifier onlyACP() {
        if (msg.sender != address(commerce)) revert OnlyCommerce();
        _;
    }

    constructor(address commerce_, address reputationRegistry_) {
        commerce = AgenticCommerce(commerce_);
        reputationRegistry = ACLReputationRegistry(reputationRegistry_);
    }

    function beforeAction(
        uint256 jobId,
        bytes4 selector_,
        bytes calldata data
    ) external onlyACP {
        if (providerAgentIdOf[jobId] != 0) return;
        bytes memory optParams = _extractOptParams(selector_, data);
        if (optParams.length == 32) {
            providerAgentIdOf[jobId] = abi.decode(optParams, (uint256));
        }
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector_,
        bytes calldata
    ) external onlyACP {
        if (selector_ == AgenticCommerce.complete.selector) {
            _writeFeedback(jobId, ACLConstants.SCORE_POSITIVE, "job-complete");
        } else if (selector_ == AgenticCommerce.reject.selector) {
            _writeFeedback(jobId, ACLConstants.SCORE_NEGATIVE, "job-reject");
        }
    }

    function _extractOptParams(
        bytes4 selector_,
        bytes calldata data
    ) internal pure returns (bytes memory optParams) {
        if (selector_ == AgenticCommerce.setProvider.selector) {
            (, optParams) = abi.decode(data, (address, bytes));
        } else if (selector_ == AgenticCommerce.setBudget.selector) {
            (, optParams) = abi.decode(data, (uint256, bytes));
        } else if (selector_ == AgenticCommerce.fund.selector) {
            optParams = data;
        } else if (selector_ == AgenticCommerce.submit.selector) {
            (, optParams) = abi.decode(data, (bytes32, bytes));
        }
    }

    function _writeFeedback(
        uint256 jobId,
        int128 value,
        string memory tag1
    ) internal {
        uint256 agentId = providerAgentIdOf[jobId];
        if (agentId == 0) revert MissingAgentId();
        reputationRegistry.giveFeedback(
            agentId,
            value,
            ACLConstants.DEFAULT_VALUE_DECIMALS,
            tag1,
            "",
            "acl/erc-8183",
            "",
            bytes32(jobId)
        );
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC165, IERC165) returns (bool) {
        return
            interfaceId == type(IACPHook).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
