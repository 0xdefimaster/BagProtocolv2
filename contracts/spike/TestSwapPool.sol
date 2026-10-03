// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TestSwapPool
/// @notice The smallest possible stand-in for "ONE known direct DEX swap"
/// (Phase 19.X, Step 1). Fixed exchange rate, single token pair, no
/// concentrated-liquidity/constant-product math — real AMM pricing is
/// explicitly out of scope for this feasibility spike, which is only
/// testing atomic composability, not pricing.
///
/// Two independent instances of this contract (different token pairs, or
/// the same pair deployed twice) are what Phase 19.X-A uses as Leg A and
/// Leg B, so the spike is testing "two BAG-controlled legs compose
/// atomically" without depending on any external DEX/aggregator.
///
/// Follows the transferFrom-pull pattern real routers use: the caller
/// (BagRouterSpike) must have approved this pool for `amountIn` before
/// calling `swap`. This mirrors the calldata shape Phase 19.X-B will need
/// for the real LI.FI leg, so the approval-handling proven here transfers.
contract TestSwapPool {
    using SafeERC20 for IERC20;

    IERC20 public immutable tokenIn;
    IERC20 public immutable tokenOut;

    // Fixed rate: amountOut = amountIn * rateNumerator / rateDenominator.
    // Deliberately not a constant-product curve — see contract-level note.
    uint256 public immutable rateNumerator;
    uint256 public immutable rateDenominator;

    event Swapped(address indexed caller, address indexed recipient, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 tokenIn_, IERC20 tokenOut_, uint256 rateNumerator_, uint256 rateDenominator_) {
        require(rateDenominator_ > 0, "TestSwapPool: bad rate");
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        rateNumerator = rateNumerator_;
        rateDenominator = rateDenominator_;
    }

    /// @notice Seed this pool's tokenOut reserves. Anyone can call this on
    /// testnet — call it from the deploy script right after deployment.
    function seed(uint256 amount) external {
        tokenOut.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Pulls `amountIn` of `tokenIn` from `msg.sender` (expects a
    /// prior approval — this is the exact call BagRouterSpike's Leg
    /// calldata targets), computes output at the fixed rate, and reverts
    /// if either the computed output is below `minAmountOut` or this
    /// pool's own reserves can't cover it. This is what STEP 4's
    /// deliberate-failure test drives: pass an unreachable `minAmountOut`
    /// to force this call to revert, and assert BagRouterSpike's whole
    /// transaction rolls back with it.
    function swap(uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256 amountOut) {
        require(amountIn > 0, "TestSwapPool: zero amountIn");
        amountOut = (amountIn * rateNumerator) / rateDenominator;
        require(amountOut >= minAmountOut, "TestSwapPool: slippage");
        require(tokenOut.balanceOf(address(this)) >= amountOut, "TestSwapPool: insufficient reserves");

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenOut.safeTransfer(recipient, amountOut);

        emit Swapped(msg.sender, recipient, amountIn, amountOut);
    }
}
