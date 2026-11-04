// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IDcaSwapAdapter} from './IDcaSwapAdapter.sol';

/// @dev Uniswap SwapRouter02 (v3 part). `exactInputSingle` has no deadline field in SwapRouter02.
interface ISwapRouter02ExactInputSingle {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /// @dev PeripheryImmutableState: the v3 factory the router trusts for pool addresses.
    function factory() external view returns (address);
}

interface IUniswapV3FactoryPools {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @title UniswapV3ExactInAdapter
/// @notice Single-hop Uniswap v3 exact-input swap for BagDcaExecutor.
///
/// Fixed at deployment: the SwapRouter02 and the v3 factory (the constructor
/// requires `router.factory() == factory`). No owner, no admin, no upgrade, no
/// arbitrary call. Per swap the only free parameter is the fee tier, one of
/// 100 / 500 / 3000 / 10000, and the pool for it must exist in the pinned
/// factory. The caller's own tokens are the only tokens used: tokens sent to
/// this contract by anyone else are never spent (balance before == after).
///
/// Fail-closed token behaviour: an input token that delivers less than
/// `amountIn` to the adapter (fee-on-transfer) reverts; an output token whose
/// recipient balance moves by something other than the amount the pool sent
/// (fee-on-transfer, rebasing during the transfer) reverts.
contract UniswapV3ExactInAdapter is IDcaSwapAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable override swapRouter;
    address public immutable override poolFactory;

    error ZeroAddress();
    error RouterFactoryMismatch(address routerFactory, address expected);
    error InvalidSwap(uint256 code);
    error UnsupportedFee(uint24 fee);
    error PoolNotFound(address tokenIn, address tokenOut, uint24 fee);
    error InputTransferMismatch(uint256 received, uint256 expected);
    error InputNotFullySpent(uint256 left);
    error OutputMismatch(uint256 measured, uint256 reported);
    error OutputBelowMinimum(uint256 measured, uint256 minimum);
    error ApprovalNotReset(uint256 left);

    constructor(address swapRouter_, address poolFactory_) {
        if (swapRouter_ == address(0) || poolFactory_ == address(0)) revert ZeroAddress();
        address routerFactory = ISwapRouter02ExactInputSingle(swapRouter_).factory();
        if (routerFactory != poolFactory_) revert RouterFactoryMismatch(routerFactory, poolFactory_);
        swapRouter = swapRouter_;
        poolFactory = poolFactory_;
    }

    /// @notice `routeData` = abi.encode(uint24 fee). See IDcaSwapAdapter.
    /// Codes of InvalidSwap: 1 amount, 2 minimum, 3 recipient, 4 same token, 5 routeData.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata routeData
    ) external override nonReentrant returns (uint256 measuredOut) {
        if (amountIn == 0) revert InvalidSwap(1);
        if (minOut == 0) revert InvalidSwap(2);
        if (recipient == address(0) || recipient == address(this) || recipient == swapRouter) revert InvalidSwap(3);
        if (tokenIn == tokenOut || tokenIn == address(0) || tokenOut == address(0)) revert InvalidSwap(4);
        if (routeData.length != 32) revert InvalidSwap(5);
        uint256 rawFee = abi.decode(routeData, (uint256));
        if (rawFee != 100 && rawFee != 500 && rawFee != 3000 && rawFee != 10000) revert UnsupportedFee(uint24(rawFee));
        uint24 fee = uint24(rawFee);
        if (IUniswapV3FactoryPools(poolFactory).getPool(tokenIn, tokenOut, fee) == address(0)) revert PoolNotFound(tokenIn, tokenOut, fee);

        uint256 inBefore = _pull(tokenIn, amountIn);
        uint256 outBefore = IERC20(tokenOut).balanceOf(recipient);
        uint256 reported = _callRouter(tokenIn, tokenOut, fee, recipient, amountIn, minOut);

        uint256 inAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inAfter != inBefore) revert InputNotFullySpent(inAfter > inBefore ? inAfter - inBefore : 0);

        measuredOut = IERC20(tokenOut).balanceOf(recipient) - outBefore;
        if (measuredOut != reported) revert OutputMismatch(measuredOut, reported);
        if (measuredOut < minOut) revert OutputBelowMinimum(measuredOut, minOut);
    }

    /// @dev Pulls exactly `amountIn` from the caller; returns this contract's balance BEFORE the pull.
    function _pull(address tokenIn, uint256 amountIn) private returns (uint256 inBefore) {
        IERC20 tIn = IERC20(tokenIn);
        inBefore = tIn.balanceOf(address(this));
        tIn.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = tIn.balanceOf(address(this)) - inBefore;
        if (received != amountIn) revert InputTransferMismatch(received, amountIn);
    }

    /// @dev Exact approval, one exactInputSingle (no price limit: the minimum is the bound), approval reset to 0.
    function _callRouter(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 minOut) private returns (uint256 reported) {
        IERC20 tIn = IERC20(tokenIn);
        tIn.forceApprove(swapRouter, amountIn);
        reported = ISwapRouter02ExactInputSingle(swapRouter).exactInputSingle(
            ISwapRouter02ExactInputSingle.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        tIn.forceApprove(swapRouter, 0);
        uint256 left = tIn.allowance(address(this), swapRouter);
        if (left != 0) revert ApprovalNotReset(left);
    }
}
