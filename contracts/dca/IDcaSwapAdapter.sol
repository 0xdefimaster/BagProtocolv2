// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDcaSwapAdapter
/// @notice The only swap shape BagDcaExecutor can use: one exact-input swap of
/// `amountIn` of `tokenIn` into `tokenOut`, delivered straight to `recipient`.
/// No arbitrary target, calldata or delegatecall crosses this interface: the
/// adapter's venue (router, factory) is fixed at deployment and `routeData`
/// is a typed, adapter-defined value (for UniswapV3ExactInAdapter: one
/// `uint24` fee tier, abi-encoded).
interface IDcaSwapAdapter {
    /// @notice Pulls exactly `amountIn` of `tokenIn` from `msg.sender` and swaps it on the
    /// adapter's fixed venue; the output goes to `recipient` only.
    /// @return measuredOut `tokenOut` balance increase of `recipient`, measured by the adapter.
    /// Reverts unless it is at least `minOut` and the whole `amountIn` was spent.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata routeData
    ) external returns (uint256 measuredOut);

    /// @notice The venue contract the adapter calls (pinned, immutable).
    function swapRouter() external view returns (address);

    /// @notice The pool factory the adapter checks pools against (pinned, immutable).
    function poolFactory() external view returns (address);
}
