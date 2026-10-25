// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BagExecutionRouter} from '../BagExecutionRouter.sol';

/// @title IRecurringPurchaseExecution
/// @notice A user-signed, bounded recurring purchase of one BAG (DCA). The
/// owner of the funds signs ONE EIP-712 `Authorization`; afterwards anyone
/// (a keeper) may submit purchases, and every limit the owner signed is
/// enforced here, on chain: strategy (bag id/version/composition/definition),
/// source account, recipient, per-run amount, total budget, number of runs,
/// calendar window, expiry, per-asset price limit, route and revocation.
///
/// The BAG backend's `planSigner` (BagExecutionRouter) only PROPOSES the swap
/// calldata. Nothing it signs can widen a limit: the executor checks the
/// router plan against the signed authorization before the call and checks
/// the measured result after it.
///
/// Field names follow docs/dca (inventory 4.2). Differences from that draft:
/// the price policy is not a separate `priceProof` but per-asset limits inside
/// the signed authorization (`AssetLimit.maxPriceRaw`), so a wallet shows them;
/// fees are not part of this version (an authorization cannot pay a fee).
interface IRecurringPurchaseExecution {
    /// @dev ALLOWANCE: the owner is an EOA (or 1271 account) that approved / permitted
    /// THIS contract; funds stay in the owner's address until each purchase.
    /// DELEGATION: the owner is a smart account that delegated a token transfer to
    /// this contract through `fundingContract` (a DelegationManager).
    enum FundingKind {
        ALLOWANCE,
        DELEGATION
    }

    /// @notice Which BAG, exactly. `bagId`/`bagVersion`/`compositionHash` are checked
    /// against BagFactory and the Bag contract on every purchase; a new version
    /// recorded by the creator stops the authorization. `strategyId != 0` adds a
    /// StrategyRegistry check of `definitionHash` (bag.json v1) at `strategyVersion`.
    struct BagRef {
        bytes32 bagId;
        uint256 bagVersion;
        bytes32 compositionHash;
        bytes32 definitionHash;
        bytes32 strategyId;
        uint32 strategyVersion;
    }

    /// @notice One asset of the BAG: its weight (from the definition) and the most the
    /// owner accepts to pay for one whole token, in input-token raw units.
    /// Minimum output of a leg = ceil(legInput * 10**decimals / maxPriceRaw).
    struct AssetLimit {
        address asset;
        uint16 weightBps;
        uint8 decimals;
        uint256 maxPriceRaw;
    }

    /// @notice The calendar: windows of `periodSeconds` starting at `startsAt`, at most one
    /// purchase per window and at least `periodSeconds` between purchases; missed
    /// windows do not accumulate. `totalBudget == grossAmountPerRun * maxExecutions`.
    struct Schedule {
        uint256 grossAmountPerRun;
        uint256 totalBudget;
        uint32 maxExecutions;
        uint64 startsAt;
        uint64 periodSeconds;
        uint64 expiresAt;
    }

    /// @notice The only call shape accepted: BagExecutionRouter `router` running Uniswap v3
    /// SwapRouter02 `exactInputSingle` legs on `swapTarget`, at one of `allowedFees`.
    struct Route {
        address router;
        address swapTarget;
        uint24[] allowedFees;
    }

    struct Authorization {
        address owner;
        address sourceAccount;
        address recipient;
        uint8 fundingKind;
        address fundingContract;
        address inputToken;
        BagRef bag;
        AssetLimit[] assets;
        Schedule schedule;
        Route route;
        uint256 nonce;
    }

    /// @notice One purchase. `window` is the window the keeper built the quote for:
    /// a transaction that lands in another window reverts instead of buying late.
    struct PurchaseExecution {
        bytes32 authorizationId;
        uint64 window;
        uint64 quoteDeadline;
        BagExecutionRouter.ExecutionPlan plan;
        bytes planSignature;
    }

    /// @notice Counters kept per (owner, authorizationId). Purely on chain: a keeper
    /// restart or a new database cannot reset them.
    struct ExecutionState {
        uint32 executions;
        uint256 grossUsed;
        uint64 lastWindow;
        uint64 lastExecutionAt;
        bool revoked;
    }

    event PurchaseExecuted(
        address indexed owner,
        bytes32 indexed authorizationId,
        bytes32 indexed executionHash,
        uint256 window,
        uint256 executionIndex,
        uint256 grossAmount,
        uint256 sourceDebit
    );

    event AuthorizationRevoked(address indexed owner, bytes32 indexed authorizationId);

    function execute(
        Authorization calldata authorization,
        PurchaseExecution calldata execution,
        bytes calldata ownerSignature,
        bytes calldata fundingProof
    ) external returns (uint256 executionIndex);

    function revoke(bytes32 authorizationId) external;

    function revokeBySig(address owner, bytes32 authorizationId, bytes calldata signature) external;

    function getState(address owner, bytes32 authorizationId) external view returns (ExecutionState memory);

    function authorizationIdOf(Authorization calldata authorization) external view returns (bytes32);
}
