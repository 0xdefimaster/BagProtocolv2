// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @notice TEST-ONLY attacker contract for finding F-01 (regression test). Any call to it, whatever the calldata,
/// pays 1 raw unit of each configured token to the caller and ignores the calldata. It never executes the Composer
/// call whose bytes the calldata may carry.
contract ForgedBatchTarget {
    address[] private tokens;

    constructor(address[] memory _tokens) {
        tokens = _tokens;
    }

    fallback() external payable {
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).transfer(msg.sender, 1);
        }
    }
}
