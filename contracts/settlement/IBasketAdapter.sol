// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// -----------------------------------------------------------------------------
// The contract between BagSettlementRouter and one swap venue
// (docs/ADAPTER_INTERFACE.md, invariants A1-A10). An adapter never decides who
// receives what or how much is spent; the router measures every result itself.
// -----------------------------------------------------------------------------

interface IBasketAdapter {
    /// keccak256("BAG_ADAPTER_<VENUE>_<KIND>_V<n>"), e.g. "BAG_ADAPTER_UNIV3_EXACT_IN_V1".
    function adapterId() external pure returns (bytes32);

    /// Validation only: no state change, no token movement. Returns (false, reason) instead of reverting.
    function check(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        view
        returns (bool ok, bytes32 reason);

    /// Router only, after it transferred exactly `amountIn` of `tokenIn` to this adapter. Swaps all of it to
    /// `tokenOut`, sends the output to `to` (the router) and reverts below `minOut`. The return value is
    /// informational; the router measures its own balance delta.
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, bytes calldata data)
        external
        returns (uint256 amountOut);
}
