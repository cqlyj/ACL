// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IACPHook} from "../interfaces/IACPHook.sol";
import {AgenticCommerce} from "../core/AgenticCommerce.sol";
import {ACLReputationRegistry} from "../registry/ACLReputationRegistry.sol";
import {ACLConstants} from "../libraries/ACLConstants.sol";
import {IERC7857} from "../interfaces/IERC7857.sol";
import {TransferValidityProof} from "../interfaces/IERC7857DataVerifier.sol";

/// @title INFTDeliveryHook
/// @notice Atomic ERC-7857 iNFT delivery via the ERC-8183 hook pattern.
/// @dev Spec-faithful flow (Example Flow — atomic iNFT delivery):
///        setBudget   optParams = abi.encode(nftContract, tokenId, providerAgentId)
///                    Hook records the iNFT commitment and provider agentId.
///        fund        optParams = abi.encode(TransferValidityProof[]) — proofs
///                    targeting the *buyer's* encrypted public key. Stored in
///                    the hook for use at completion time.
///        submit      Hook pulls the iNFT from the provider into escrow via
///                    plain ERC-721 transferFrom (the provider has approved
///                    this contract; ownership change is non-iTransfer because
///                    the sealedKey for "the hook" is meaningless).
///        complete    Hook calls iTransfer(buyer, tokenId, proofs) so the
///                    iNFT is re-encrypted for the buyer's pubkey by the
///                    bound IERC7857DataVerifier and ownership transfers to
///                    the buyer atomically with payout.
///        reject      Hook returns the iNFT to the provider via plain
///                    transferFrom (no proof needed because the dataHash
///                    never changed in escrow).
///        recoverNFT  Permissionless after expiry / rejection; provider
///                    pulls their iNFT out.
contract INFTDeliveryHook is IACPHook, ERC165, IERC721Receiver {
    struct EscrowInfo {
        address nftContract;
        uint256 tokenId;
        /// @dev Set at submit time (the provider that actually delivered the NFT).
        ///      Reading it lazily lets `setBudget` happen before `setProvider`.
        address provider;
        uint256 providerAgentId;
        bool deposited;
    }

    AgenticCommerce public immutable commerce;
    ACLReputationRegistry public immutable reputationRegistry;

    mapping(uint256 => EscrowInfo) internal _escrows;
    mapping(uint256 => bytes) internal _pendingProofs;

    event INFTCommitted(
        uint256 indexed jobId,
        address nftContract,
        uint256 tokenId,
        uint256 providerAgentId
    );
    event INFTEscrowed(uint256 indexed jobId, address indexed provider);
    event INFTReleased(uint256 indexed jobId, address indexed buyer);
    event INFTReturned(uint256 indexed jobId, address indexed provider);
    event TransferProofsRecorded(uint256 indexed jobId);

    error OnlyCommerce();
    error NoEscrowData();
    error NotDeposited();
    error AlreadyDeposited();
    error JobNotRecoverable();
    error NotProvider();
    error MissingTransferProofs();

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
        if (selector_ == AgenticCommerce.setBudget.selector) {
            _onBeforeSetBudget(jobId, data);
        } else if (selector_ == AgenticCommerce.fund.selector) {
            _onBeforeFund(jobId, data);
        } else if (selector_ == AgenticCommerce.submit.selector) {
            _onBeforeSubmit(jobId);
        }
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector_,
        bytes calldata
    ) external onlyACP {
        if (selector_ == AgenticCommerce.complete.selector) {
            _onAfterComplete(jobId);
        } else if (selector_ == AgenticCommerce.reject.selector) {
            _onAfterReject(jobId);
        }
    }

    function _onBeforeSetBudget(uint256 jobId, bytes calldata data) internal {
        (, bytes memory optParams) = abi.decode(data, (uint256, bytes));
        (address nftContract, uint256 tokenId, uint256 providerAgentId) = abi
            .decode(optParams, (address, uint256, uint256));

        _escrows[jobId] = EscrowInfo({
            nftContract: nftContract,
            tokenId: tokenId,
            provider: address(0),
            providerAgentId: providerAgentId,
            deposited: false
        });

        emit INFTCommitted(jobId, nftContract, tokenId, providerAgentId);
    }

    function _onBeforeFund(uint256 jobId, bytes calldata data) internal {
        if (data.length == 0) revert MissingTransferProofs();
        _pendingProofs[jobId] = data;
        emit TransferProofsRecorded(jobId);
    }

    function _onBeforeSubmit(uint256 jobId) internal {
        EscrowInfo storage info = _escrows[jobId];
        if (info.nftContract == address(0)) revert NoEscrowData();
        if (info.deposited) revert AlreadyDeposited();
        if (_pendingProofs[jobId].length == 0) revert MissingTransferProofs();

        AgenticCommerce.Job memory job = commerce.getJob(jobId);
        info.provider = job.provider;

        IERC721(info.nftContract).transferFrom(
            job.provider,
            address(this),
            info.tokenId
        );
        info.deposited = true;
        emit INFTEscrowed(jobId, job.provider);
    }

    function _onAfterComplete(uint256 jobId) internal {
        EscrowInfo storage info = _escrows[jobId];
        if (!info.deposited) revert NotDeposited();

        AgenticCommerce.Job memory job = commerce.getJob(jobId);

        TransferValidityProof[] memory proofs = abi.decode(
            _pendingProofs[jobId],
            (TransferValidityProof[])
        );
        IERC7857(info.nftContract).iTransfer(job.client, info.tokenId, proofs);

        info.deposited = false;
        delete _pendingProofs[jobId];

        emit INFTReleased(jobId, job.client);

        if (info.providerAgentId != 0) {
            reputationRegistry.giveFeedback(
                info.providerAgentId,
                ACLConstants.SCORE_POSITIVE,
                ACLConstants.DEFAULT_VALUE_DECIMALS,
                "inft-sale-complete",
                "",
                "acl/erc-7857",
                "",
                bytes32(jobId)
            );
        }
    }

    function _onAfterReject(uint256 jobId) internal {
        EscrowInfo storage info = _escrows[jobId];
        if (!info.deposited) {
            delete _pendingProofs[jobId];
            return;
        }

        IERC721(info.nftContract).transferFrom(
            address(this),
            info.provider,
            info.tokenId
        );
        info.deposited = false;
        delete _pendingProofs[jobId];

        emit INFTReturned(jobId, info.provider);

        if (info.providerAgentId != 0) {
            reputationRegistry.giveFeedback(
                info.providerAgentId,
                ACLConstants.SCORE_NEGATIVE,
                ACLConstants.DEFAULT_VALUE_DECIMALS,
                "inft-sale-reject",
                "",
                "acl/erc-7857",
                "",
                bytes32(jobId)
            );
        }
    }

    /// @notice Provider reclaims an iNFT after the job has expired or been rejected.
    /// @dev Hook auto-returns on reject in afterAction. recoverNFT is the safety
    ///      net for the Expired path (claimRefund is not hookable).
    function recoverNFT(uint256 jobId) external {
        EscrowInfo storage info = _escrows[jobId];
        if (!info.deposited) revert NotDeposited();
        if (msg.sender != info.provider) revert NotProvider();

        AgenticCommerce.Job memory job = commerce.getJob(jobId);
        if (
            job.status != AgenticCommerce.JobStatus.Expired &&
            job.status != AgenticCommerce.JobStatus.Rejected
        ) {
            revert JobNotRecoverable();
        }

        IERC721(info.nftContract).transferFrom(
            address(this),
            info.provider,
            info.tokenId
        );
        info.deposited = false;
        delete _pendingProofs[jobId];

        emit INFTReturned(jobId, info.provider);
    }

    // ---------- Views ----------

    function escrowOf(uint256 jobId) external view returns (EscrowInfo memory) {
        return _escrows[jobId];
    }

    function pendingProofs(uint256 jobId) external view returns (bytes memory) {
        return _pendingProofs[jobId];
    }

    // ---------- ERC-721 + ERC-165 ----------

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC165, IERC165) returns (bool) {
        return
            interfaceId == type(IACPHook).interfaceId ||
            interfaceId == type(IERC721Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
