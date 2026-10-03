// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title NativeRefundTarget
/// @notice TEST-ONLY leg target that keeps half of the native value it is
/// sent and refunds the rest to the caller — the shape of a real
/// aggregator returning unspent ETH. Used to prove `BagExecutionRouter`
/// passes such refunds back to the user instead of keeping them.
contract NativeRefundTarget {
    function spendHalf() external payable {
        (bool ok, ) = msg.sender.call{value: msg.value / 2}('');
        require(ok, 'NativeRefundTarget: refund failed');
    }
}
