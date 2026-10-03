// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BagRouterSpike
/// @notice PHASE 19.X-A ONLY. This is a feasibility spike, not a production
/// router. It exists to answer exactly one question: can BAG compose two
/// independently-controlled execution legs (Leg A, Leg B) into ONE atomic
/// Robinhood Chain transaction, with full revert if either leg fails, no
/// stuck funds, and no partial output?
///
/// It is deliberately NOT the production BagRouter:
/// - no fee logic, no multi-hop pathing, no allowlist/governance
/// - no support for arbitrary token sets, only the input/output pair given
///   at call time
/// - both legs are plain external calls to contracts the caller specifies;
///   this spike does not vet or restrict what those targets can be beyond
///   the minimum-output and revert-propagation guarantees below
///
/// Both legs in this spike are BAG/own-controlled (e.g. two independently
/// deployed AMM pools seeded by us on testnet) — this contract makes no
/// claim about aggregator (e.g. LI.FI) composability. That is Phase 19.X-B,
/// tested separately, and only after this contract's behavior is proven.
contract BagRouterSpike is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Emitted once both legs have executed and output has been
    /// verified against the minimum-output floor.
    event SpikeExecuted(
        address indexed caller,
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        uint256 outputAmount
    );

    /// @notice A single execution leg: an external call plus how much of
    /// which token it is expected to consume/produce.
    ///
    /// Models the standard aggregator/router calldata pattern (Uniswap V3
    /// SwapRouter, 0x, LI.FI's target contracts): the CALLER grants an
    /// allowance to `target`, then `target` pulls funds itself via
    /// `transferFrom(router, target, amount)` inside its own logic — this
    /// contract does not pre-transfer tokens to `target` before calling it.
    /// This is deliberately the same shape Phase 19.X-B will need for the
    /// real LI.FI calldata leg, so the approval-model findings from this
    /// spike carry over.
    struct Leg {
        // Contract to call for this leg (e.g. a DEX pool/router address).
        address target;
        // Calldata to submit to `target`. Built off-chain by the caller
        // (e.g. from the AMM's own quote function) — this spike does not
        // construct calldata itself, matching Phase 19.X's Step 2/6 intent
        // to capture real, externally-sourced calldata rather than
        // fabricate it.
        bytes callData;
        // Native ETH value to forward with the call. Zero for pure ERC-20
        // legs.
        uint256 value;
        // Token this leg needs to pull FROM this router (address(0) if the
        // leg needs no token, e.g. a pure native-ETH call).
        address approveToken;
        // Amount to approve `target` to pull. Set to exactly the amount
        // the leg is expected to consume — never `type(uint256).max` — so
        // an unused/leftover approval cannot be pulled again later.
        uint256 approveAmount;
    }

    /// @notice Executes Leg A then Leg B atomically, pulling `inputAmount`
    /// of `inputToken` from the caller up front, and verifying that at
    /// least `minOutput` of `outputToken` is held by this contract
    /// immediately after Leg B completes, before forwarding it back to the
    /// caller.
    ///
    /// Reverts entirely (nothing persisted, nothing sent) if:
    /// - Leg A's external call reverts
    /// - Leg B's external call reverts
    /// - the resulting output balance is below `minOutput`
    ///
    /// This is the STEP 3/4 atomicity+failure test surface: call this with
    /// a deliberately-broken Leg B calldata (or Leg A) from the test suite
    /// and assert the whole transaction reverts with no state change.
    function executeComposed(
        address inputToken,
        uint256 inputAmount,
        Leg calldata legA,
        Leg calldata legB,
        address outputToken,
        uint256 minOutput
    ) external payable nonReentrant returns (uint256 outputAmount) {
        require(inputAmount > 0, "BagRouterSpike: zero input");
        require(legA.target != address(0), "BagRouterSpike: legA target");
        require(legB.target != address(0), "BagRouterSpike: legB target");

        // Pull input funds from the caller into this contract. Requires a
        // prior approve() from the caller — see the one-signature analysis
        // in the phase report; this spike does not implement Permit2 itself,
        // it only documents whether it would be needed.
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        // --- Leg A ---------------------------------------------------
        _approveLeg(legA);
        (bool okA, bytes memory retA) = legA.target.call{value: legA.value}(legA.callData);
        if (!okA) {
            _bubbleRevert(retA, "BagRouterSpike: legA reverted");
        }
        _clearApprovalIfLeftover(legA);

        // --- Leg B ---------------------------------------------------
        _approveLeg(legB);
        (bool okB, bytes memory retB) = legB.target.call{value: legB.value}(legB.callData);
        if (!okB) {
            _bubbleRevert(retB, "BagRouterSpike: legB reverted");
        }
        _clearApprovalIfLeftover(legB);

        // --- Output verification --------------------------------------
        outputAmount = IERC20(outputToken).balanceOf(address(this));
        require(outputAmount >= minOutput, "BagRouterSpike: min output not met");

        // Any leftover input tokens (e.g. legA/legB didn't consume 100%)
        // and the verified output are both returned to the caller. Nothing
        // is left custodied by this contract between calls.
        uint256 leftoverInput = IERC20(inputToken).balanceOf(address(this));
        if (leftoverInput > 0) {
            IERC20(inputToken).safeTransfer(msg.sender, leftoverInput);
        }
        IERC20(outputToken).safeTransfer(msg.sender, outputAmount);

        emit SpikeExecuted(msg.sender, inputToken, inputAmount, outputToken, outputAmount);
    }

    /// @dev Grants `leg.target` an exact allowance over `leg.approveToken`
    /// for `leg.approveAmount`, if the leg declares one. Uses forceApprove
    /// so a nonzero->nonzero change (some tokens reject this) never
    /// silently no-ops.
    function _approveLeg(Leg calldata leg) private {
        if (leg.approveToken != address(0) && leg.approveAmount > 0) {
            IERC20(leg.approveToken).forceApprove(leg.target, leg.approveAmount);
        }
    }

    /// @dev Revokes any unused allowance left after the leg's call returns,
    /// so a leg that only partially consumed its approval can never be
    /// drained again later in the same or a future transaction. This is
    /// one of the STEP 7 fund-safety checks: "leftover approval" is a real
    /// attack surface for composed calls and must not survive the leg.
    function _clearApprovalIfLeftover(Leg calldata leg) private {
        if (leg.approveToken != address(0) && leg.approveAmount > 0) {
            uint256 remaining = IERC20(leg.approveToken).allowance(address(this), leg.target);
            if (remaining > 0) {
                IERC20(leg.approveToken).forceApprove(leg.target, 0);
            }
        }
    }

    /// @dev Re-throws the original revert reason from a failed external
    /// call when available, falling back to `fallbackReason` for calls
    /// that reverted with no data (e.g. a bare `revert()` or an
    /// out-of-gas). This is what makes the failure tests assertable by
    /// reason string instead of only by "did it revert".
    function _bubbleRevert(bytes memory returnData, string memory fallbackReason) private pure {
        if (returnData.length > 0) {
            assembly {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }
        revert(fallbackReason);
    }

    /// @notice Lets this contract receive ETH refunds from legs that
    /// forward native value (e.g. an AMM returning unused ETH). Not part
    /// of the success path for the ERC-20-only spike, included only so a
    /// leg that unexpectedly sends dust ETH doesn't itself cause a revert.
    receive() external payable {}
}
