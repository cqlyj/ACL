// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ACLTestUSDC
/// @notice Test-only USDC stand-in (6 decimals, permissionless mint).
/// @dev DO NOT DEPLOY THIS TO MAINNET. The mint() function is intentionally open
///      so demo agents and the workflow script can fund themselves on 0G Galileo
///      testnet without requiring a privileged minter. Production deployments
///      should use a real stablecoin (USDC, etc.) and remove this token.
contract ACLTestUSDC is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Permissionless mint — testnet only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
