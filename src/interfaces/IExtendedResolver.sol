// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IExtendedResolver — ENSIP-10 wildcard resolution interface
/// @dev See https://docs.ens.domains/ensip/10
interface IExtendedResolver {
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (bytes memory);
}
