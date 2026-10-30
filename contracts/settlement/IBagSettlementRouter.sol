// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BasketIntent, ExecutionPlan} from "./BasketTypes.sol";

// -----------------------------------------------------------------------------
// External surface and receipt schema of BagSettlementRouter
// (docs/BAG_SETTLEMENT_ARCHITECTURE.md). The router itself is G2; this file
// fixes what the SDK and indexers build against.
// -----------------------------------------------------------------------------

/// How `execute` pulls `plan.inputAmount` from the payer. Each mode is enabled per deployment only after the
/// chain and token are verified to support it.
enum FundingMode {
    Allowance,
    Permit2612,
    Permit2
}

interface IBagSettlementRouter {
    /// One per execution. Amounts are measured balance deltas, in composition order of `tokensOut`.
    event BasketSettled(
        bytes32 indexed intentHash,
        bytes32 indexed strategyId,
        address indexed recipient,
        uint32 strategyVersion,
        bytes32 definitionHash,
        bytes32 compositionHash,
        bytes32 planHash,
        address payer,
        address inputToken,
        uint256 grossInput,
        uint256 integratorFee,
        address integratorFeeRecipient,
        uint256 protocolFee,
        address[] tokensOut,
        uint256[] amountsOut
    );

    event NoncesInvalidated(address indexed payer, uint256 indexed wordPos, uint256 mask);

    /// Steps and invariants R1-R8: docs/BAG_SETTLEMENT_ARCHITECTURE.md. `signature` may be empty when
    /// msg.sender is the payer. `funding` carries the permit data for the selected mode.
    function execute(
        BasketIntent calldata intent,
        bytes calldata signature,
        ExecutionPlan calldata plan,
        FundingMode fundingMode,
        bytes calldata funding
    ) external returns (uint256[] memory amountsOut);

    /// Permit2-style unordered nonces: bit `nonce & 255` of word `nonce >> 8`.
    function invalidateNonces(uint256 wordPos, uint256 mask) external;

    function nonceBitmap(address payer, uint256 wordPos) external view returns (uint256);

    function domainSeparator() external view returns (bytes32);

    function hashIntent(BasketIntent calldata intent) external view returns (bytes32 digest);
}
