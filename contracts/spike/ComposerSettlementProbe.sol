// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ComposerSettlementProbe
/// @notice SPIKE ONLY (P1 in docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md).
/// Not a settlement contract, takes no fee, has no owner and holds nothing
/// between calls. It answers one question: when a LI.FI Composer flow calls a
/// contract with `core.call`, who is `msg.sender`, how do the tokens arrive
/// (pushed before the call, or pulled through an allowance), and how much
/// actually arrives?
///
/// Every token it holds at the end of `probe` is forwarded to `recipient`, in
/// the same call. Accepts both delivery models so the probe itself does not
/// presuppose one:
///   - push: tokens already sitting on this contract when `probe` runs;
///   - pull: `amount` pulled from `msg.sender` when its allowance covers it.
/// `minReceived` lets a probe flow force a revert, to observe that a failing
/// call reverts the whole Composer transaction.
///
/// Must never hold value: anyone can call `probe`, and any stray balance goes
/// to the next caller's `recipient`.
contract ComposerSettlementProbe {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    error ZeroAddress();
    error BelowMinimum(uint256 received, uint256 minReceived);

    /// @param msgSender      the immediate caller (expected: the Composer execution proxy — this is what P1 checks)
    /// @param txOrigin       the EOA that signed the transaction
    /// @param recipient      where everything was forwarded
    /// @param amountArg      the amount passed in calldata (Composer's runtime value)
    /// @param pushedBeforeCall balance this contract already held when called
    /// @param allowanceBefore  msgSender's allowance to this contract when called
    /// @param pulled         amount actually received through transferFrom (balance delta)
    /// @param received       total forwarded: pushedBeforeCall + pulled
    /// @param allowanceAfter msgSender's allowance left after the pull
    event Probed(
        address indexed msgSender,
        address indexed txOrigin,
        address indexed recipient,
        uint256 amountArg,
        uint256 pushedBeforeCall,
        uint256 allowanceBefore,
        uint256 pulled,
        uint256 received,
        uint256 allowanceAfter
    );

    constructor(address _token) {
        if (_token == address(0)) revert ZeroAddress();
        token = IERC20(_token);
    }

    function probe(address recipient, uint256 amount, uint256 minReceived) external returns (uint256 received) {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 pushedBeforeCall = token.balanceOf(address(this));
        uint256 allowanceBefore = token.allowance(msg.sender, address(this));

        uint256 pulled;
        if (amount > 0 && allowanceBefore >= amount) {
            token.safeTransferFrom(msg.sender, address(this), amount);
            pulled = token.balanceOf(address(this)) - pushedBeforeCall;
        }

        received = pushedBeforeCall + pulled;
        if (received < minReceived || received == 0) revert BelowMinimum(received, minReceived);
        uint256 allowanceAfter = token.allowance(msg.sender, address(this));

        token.safeTransfer(recipient, received);

        emit Probed(msg.sender, tx.origin, recipient, amount, pushedBeforeCall, allowanceBefore, pulled, received, allowanceAfter);
    }
}
