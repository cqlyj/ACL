// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library ACLConstants {
    uint256 constant MAX_FEE_BPS = 1000; // 10%
    uint256 constant BPS_DENOMINATOR = 10_000;
    uint256 constant MIN_EXPIRY_BUFFER = 5 minutes;

    // ERC-8004 v2.0 scoring defaults
    uint8 constant DEFAULT_VALUE_DECIMALS = 2;
    int128 constant SCORE_POSITIVE = 100; // +1.00
    int128 constant SCORE_NEGATIVE = -100; // -1.00
}
