// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// -----------------------------------------------------------------------------
// StrategyRegistry — identity and commitment registry for BAG strategies
// (docs/STRATEGY_REGISTRY_DESIGN.md).
//
// It answers one question: "what is strategy X, version N?" — by recording,
// immutably, the bag.json v1 definitionHash its creator committed to. It holds
// NO economic state: no NAV, TVL, holdings, shares, P&L, execution state or
// balances, and it never touches tokens or ETH.
//
// Identity. strategyId = keccak256(abi.encode(creator, offChainRef)), exactly
// BagFactory.deriveBagId(): the same Bag has the same id in both contracts,
// and because the creator is part of the id nobody else can claim it.
//
// Two lineages, never mixed:
//   - VERSION lineage, inside one strategy: versions are 1, 2, 3, … with no
//     gaps; the parent of version N is always version N-1 of the same
//     strategy. Only the strategy's creator can publish a version.
//   - FORK lineage, between strategies: a fork is a NEW strategyId (its own
//     creator, its own version 1) that records, once and at registration, the
//     exact (parentStrategyId, parentVersion) it was forked from. The parent
//     version must already be registered. Forking is permissionless.
//
// Nothing can be updated or deleted. There is no owner, no admin, no pause,
// no upgrade and no fee.
// -----------------------------------------------------------------------------

contract StrategyRegistry {
    struct Strategy {
        address creator;
        uint32 latestVersion;
        /// Fork origin; zero for a strategy that is not a fork.
        bytes32 forkOfStrategyId;
        uint32 forkOfVersion;
    }

    error ZeroOffChainRef();
    error ZeroDefinitionHash();
    error AlreadyRegistered(bytes32 strategyId);
    error UnknownStrategy(bytes32 strategyId);
    error UnknownVersion(bytes32 strategyId, uint32 version);
    error NotCreator(bytes32 strategyId, address caller);
    error UnexpectedVersion(uint32 expected, uint32 actual);
    error EmptyBatch();

    /// A new strategy (version 1). `forkOfStrategyId` is zero unless it is a fork.
    event StrategyRegistered(
        bytes32 indexed strategyId,
        address indexed creator,
        bytes32 offChainRef,
        bytes32 indexed forkOfStrategyId,
        uint32 forkOfVersion
    );

    /// One version's commitment. `uri` is an optional locator for the bag.json (not verified, not stored).
    event VersionPublished(bytes32 indexed strategyId, uint32 indexed version, bytes32 definitionHash, string uri);

    mapping(bytes32 => Strategy) private _strategies;
    mapping(bytes32 => mapping(uint32 => bytes32)) private _definitionHashes;

    // ----------------------------- views ---------------------------------------

    function deriveStrategyId(address creator, bytes32 offChainRef) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, offChainRef));
    }

    function strategyOf(bytes32 strategyId) external view returns (Strategy memory) {
        return _strategies[strategyId];
    }

    function isRegistered(bytes32 strategyId) public view returns (bool) {
        return _strategies[strategyId].creator != address(0);
    }

    /// The committed definitionHash of `version`; reverts if that version is not registered.
    function definitionHashOf(bytes32 strategyId, uint32 version) public view returns (bytes32) {
        bytes32 h = _definitionHashes[strategyId][version];
        if (h == bytes32(0)) revert UnknownVersion(strategyId, version);
        return h;
    }

    /// True iff `version` of `strategyId` is registered with exactly `definitionHash`.
    function matches(bytes32 strategyId, uint32 version, bytes32 definitionHash) external view returns (bool) {
        return definitionHash != bytes32(0) && _definitionHashes[strategyId][version] == definitionHash;
    }

    // ----------------------------- writes --------------------------------------

    /// Registers a new strategy under the caller with its version 1.
    function registerStrategy(bytes32 offChainRef, bytes32 definitionHash, string calldata uri) external returns (bytes32 strategyId) {
        strategyId = _register(offChainRef, bytes32(0), 0);
        _publish(strategyId, 1, definitionHash, uri);
    }

    /// Registers a new strategy under the caller, forked from an already registered (parentStrategyId, parentVersion).
    function registerFork(
        bytes32 offChainRef,
        bytes32 parentStrategyId,
        uint32 parentVersion,
        bytes32 definitionHash,
        string calldata uri
    ) external returns (bytes32 strategyId) {
        if (_definitionHashes[parentStrategyId][parentVersion] == bytes32(0)) revert UnknownVersion(parentStrategyId, parentVersion);
        strategyId = _register(offChainRef, parentStrategyId, parentVersion);
        _publish(strategyId, 1, definitionHash, uri);
    }

    /// Publishes the next version. `version` must be exactly latestVersion + 1 (no gaps, no races).
    function publishVersion(bytes32 strategyId, uint32 version, bytes32 definitionHash, string calldata uri) external {
        _requireCreator(strategyId);
        _publish(strategyId, version, definitionHash, uri);
    }

    /// Publishes several consecutive versions starting at `firstVersion` (for history recorded before the registry existed).
    function publishVersions(bytes32 strategyId, uint32 firstVersion, bytes32[] calldata definitionHashes) external {
        if (definitionHashes.length == 0) revert EmptyBatch();
        _requireCreator(strategyId);
        for (uint256 i = 0; i < definitionHashes.length; i++) {
            _publish(strategyId, firstVersion + uint32(i), definitionHashes[i], '');
        }
    }

    // ----------------------------- internal ------------------------------------

    function _register(bytes32 offChainRef, bytes32 forkOfStrategyId, uint32 forkOfVersion) private returns (bytes32 strategyId) {
        if (offChainRef == bytes32(0)) revert ZeroOffChainRef();
        strategyId = deriveStrategyId(msg.sender, offChainRef);
        if (isRegistered(strategyId)) revert AlreadyRegistered(strategyId);
        _strategies[strategyId] = Strategy({creator: msg.sender, latestVersion: 0, forkOfStrategyId: forkOfStrategyId, forkOfVersion: forkOfVersion});
        emit StrategyRegistered(strategyId, msg.sender, offChainRef, forkOfStrategyId, forkOfVersion);
    }

    function _requireCreator(bytes32 strategyId) private view {
        address creator = _strategies[strategyId].creator;
        if (creator == address(0)) revert UnknownStrategy(strategyId);
        if (creator != msg.sender) revert NotCreator(strategyId, msg.sender);
    }

    function _publish(bytes32 strategyId, uint32 version, bytes32 definitionHash, string memory uri) private {
        if (definitionHash == bytes32(0)) revert ZeroDefinitionHash();
        Strategy storage s = _strategies[strategyId];
        uint32 expected = s.latestVersion + 1;
        if (version != expected) revert UnexpectedVersion(expected, version);
        s.latestVersion = version;
        _definitionHashes[strategyId][version] = definitionHash;
        emit VersionPublished(strategyId, version, definitionHash, uri);
    }
}
