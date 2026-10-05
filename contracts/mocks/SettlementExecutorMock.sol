// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {RedeemSettlement} from '../RedeemSettlement.sol';

/// @title SettlementExecutorMock
/// @notice TEST ONLY. Stands in for an executor (e.g. a user's Composer proxy):
/// pushes tokens to the settlement contract, then calls `settle`, in one
/// transaction — the shape proven live in P1 (SP/SP2).
contract SettlementExecutorMock {
    function pushAndSettle(
        IERC20 token,
        RedeemSettlement settlement,
        uint256 amount,
        RedeemSettlement.Settlement calldata s,
        bytes calldata signature
    ) external returns (uint256) {
        if (amount > 0) token.transfer(address(settlement), amount);
        return settlement.settle(s, signature);
    }

    /// The Composer shape: push, then the flat-argument entry (executor = this contract as msg.sender).
    function pushAndSettleFlat(IERC20 token, RedeemSettlement settlement, uint256 amount, bytes calldata flatCall) external returns (bytes memory) {
        if (amount > 0) token.transfer(address(settlement), amount);
        (bool ok, bytes memory ret) = address(settlement).call(flatCall);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
