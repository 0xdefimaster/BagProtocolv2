// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// -----------------------------------------------------------------------------
// StrategyCompositions — what a registered strategy version holds, readable by
// any contract or app (docs/STRATEGY_COMPOSITIONS_DESIGN.md).
//
// StrategyRegistry commits each version's bag.json definitionHash: it proves a
// file is unchanged, but a contract cannot read assets or weights from a hash.
// This companion stores, per (strategyId, version), the allocation list itself:
// (chainId, token, weightBps), so a router, an indexer or another app can read
// the strategy without BAG's server.
//
// Rules:
//   - Only the strategy's creator in StrategyRegistry can publish, and only for
//     a version already registered there. StrategyRegistry is not changed.
//   - Once per version: a published composition can never be changed or deleted.
//   - Canonical: entries strictly ascending by (chainId, token), so one
//     composition has exactly one encoding and no duplicates; every weight > 0,
//     weights sum to exactly 10000 bps; no zero chainId or token.
//   - compositionHash = keccak256(abi.encode(allocations)).
//
// What it does NOT prove: that the allocations equal the bag.json behind the
// definitionHash (the contract cannot parse JSON). Off-chain verifiers compare
// the two (lib/domain/basket-protocol/strategy-compositions.ts); a mismatch is
// the creator's own inconsistency and is shown as such.
//
// It holds no economic state and never touches tokens or ETH. No owner, no
// admin, no pause, no upgrade, no fee.
// -----------------------------------------------------------------------------

interface IStrategyRegistryView {
    struct Strategy {
        address creator;
        uint32 latestVersion;
        bytes32 forkOfStrategyId;
        uint32 forkOfVersion;
    }

    function strategyOf(bytes32 strategyId) external view returns (Strategy memory);
}

contract StrategyCompositions {
    struct Allocation {
        uint64 chainId;
        address token;
        uint16 weightBps;
    }

    uint256 public constant TOTAL_BPS = 10000;
    uint256 public constant MAX_ALLOCATIONS = 64;

    IStrategyRegistryView public immutable registry;

    error ZeroAddress();
    error UnknownStrategy(bytes32 strategyId);
    error NotCreator(bytes32 strategyId, address caller);
    error UnknownVersion(bytes32 strategyId, uint32 version);
    error AlreadyPublished(bytes32 strategyId, uint32 version);
    error NotPublished(bytes32 strategyId, uint32 version);
    error BadLength(uint256 length);
    error InvalidAllocation(uint256 index);
    error NotCanonical(uint256 index);
    error WeightsNotTotal(uint256 total);

    event CompositionPublished(bytes32 indexed strategyId, uint32 indexed version, bytes32 compositionHash, Allocation[] allocations);

    mapping(bytes32 => mapping(uint32 => Allocation[])) private _allocations;
    mapping(bytes32 => mapping(uint32 => bytes32)) private _hashes;

    constructor(address strategyRegistry) {
        if (strategyRegistry == address(0)) revert ZeroAddress();
        registry = IStrategyRegistryView(strategyRegistry);
    }

    // ----------------------------- views ---------------------------------------

    function isPublished(bytes32 strategyId, uint32 version) public view returns (bool) {
        return _hashes[strategyId][version] != bytes32(0);
    }

    /// The published allocations of `version`; reverts if none were published.
    function compositionOf(bytes32 strategyId, uint32 version) external view returns (Allocation[] memory) {
        if (!isPublished(strategyId, version)) revert NotPublished(strategyId, version);
        return _allocations[strategyId][version];
    }

    /// The published compositionHash of `version`; reverts if none was published.
    function compositionHashOf(bytes32 strategyId, uint32 version) external view returns (bytes32) {
        bytes32 h = _hashes[strategyId][version];
        if (h == bytes32(0)) revert NotPublished(strategyId, version);
        return h;
    }

    function computeCompositionHash(Allocation[] calldata allocations) public pure returns (bytes32) {
        return keccak256(abi.encode(allocations));
    }

    // ----------------------------- write ---------------------------------------

    /// Publishes the allocations of a registered version. Caller must be the strategy's creator in StrategyRegistry.
    function publishComposition(bytes32 strategyId, uint32 version, Allocation[] calldata allocations) external returns (bytes32 compositionHash) {
        IStrategyRegistryView.Strategy memory s = registry.strategyOf(strategyId);
        if (s.creator == address(0)) revert UnknownStrategy(strategyId);
        if (s.creator != msg.sender) revert NotCreator(strategyId, msg.sender);
        if (version == 0 || version > s.latestVersion) revert UnknownVersion(strategyId, version);
        if (isPublished(strategyId, version)) revert AlreadyPublished(strategyId, version);
        _validate(allocations);

        Allocation[] storage stored = _allocations[strategyId][version];
        for (uint256 i = 0; i < allocations.length; i++) stored.push(allocations[i]);
        compositionHash = computeCompositionHash(allocations);
        _hashes[strategyId][version] = compositionHash;
        emit CompositionPublished(strategyId, version, compositionHash, allocations);
    }

    // ----------------------------- internal ------------------------------------

    function _validate(Allocation[] calldata a) private pure {
        if (a.length == 0 || a.length > MAX_ALLOCATIONS) revert BadLength(a.length);
        uint256 total;
        for (uint256 i = 0; i < a.length; i++) {
            if (a[i].chainId == 0 || a[i].token == address(0) || a[i].weightBps == 0) revert InvalidAllocation(i);
            if (i > 0) {
                bool ascending = a[i].chainId > a[i - 1].chainId ||
                    (a[i].chainId == a[i - 1].chainId && uint160(a[i].token) > uint160(a[i - 1].token));
                if (!ascending) revert NotCanonical(i);
            }
            total += a[i].weightBps;
        }
        if (total != TOTAL_BPS) revert WeightsNotTotal(total);
    }
}
