// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Bag
/// @notice On-chain identity for a single Bag (basket). Deliberately holds
/// ONLY identity/versioning state — no token, no NAV, no mint/redeem, no
/// oracle, no rebalance. Those are Phase 5+ (see the Phase 4 report,
/// section "smart contract minimum scope"). Deployed exclusively by
/// `BagFactory.createBag()` — never constructed directly, so `factory` is
/// always a real, trusted `BagFactory` address, never an EOA.
///
/// `offChainRef` mirrors the off-chain `bags.id` (Supabase,
/// `supabase/schema.sql`) verbatim, encoded as bytes32 (a UUID, NOT hashed).
/// `bagId` is the creator-bound on-chain identity,
/// `keccak256(abi.encode(creator, offChainRef))`, derived by `BagFactory`.
/// The persisted `bag_deployments.on_chain_bag_id` is what execution uses.
contract Bag {
    /// @notice The creator-bound on-chain id:
    /// `keccak256(abi.encode(creator, offChainRef))`, computed by the factory.
    bytes32 public immutable bagId;

    /// @notice The off-chain Supabase `bags.id` (UUID) this Bag is the
    /// on-chain identity for, encoded as bytes32.
    bytes32 public immutable offChainRef;

    /// @notice The wallet that called `BagFactory.createBag()` (`msg.sender`)
    /// — the Bag's creator/arranger, never a backend relayer. NOT re-derived
    /// on-chain from `bags.creator_id`, which is a Supabase users.id.
    address public immutable creator;

    /// @notice The BagFactory that deployed this contract.
    address public immutable factory;

    /// @notice Whether this Bag's composition may ever change after creation.
    /// Mirrors the off-chain `bags.mutability` (fixed at creation, verified by
    /// the server at deploy-confirm time). An IMMUTABLE Bag rejects
    /// `recordVersion` forever — immutability holds ON-CHAIN, not just in the app.
    bool public immutable isMutable;

    /// @notice Current composition version. Starts at 1 (matches
    /// `bags.current_version` off-chain at creation — see
    /// `lib/server/bag-repo.ts`'s `create_bag_with_initial_version`).
    uint256 public version;

    /// @notice `computeCompositionHash()` output (Phase 1,
    /// `lib/domain/basket-protocol/version.ts`) for the CURRENT version —
    /// NOT the JS hash's exact bytes (that's a 64-hex-char non-cryptographic
    /// fingerprint meant for fast off-chain equality checks), but a
    /// keccak256 of the same canonical `chain:address:symbol:decimals:
    /// weightBps` string the JS side builds, so the two are independently
    /// re-derivable from the same recipe and comparable off-chain even
    /// though the JS hash function itself doesn't run in the EVM. See
    /// `BagFactory.createBag()` NatSpec for the exact preimage format.
    bytes32 public compositionHash;

    /// @notice Off-chain metadata pointer (e.g. an HTTPS or ipfs:// URI
    /// resolving to a JSON document with name/description/composition —
    /// mirrors `bags` + the current `bag_versions.recipe` off-chain).
    /// Intentionally NOT authoritative for composition — `compositionHash`
    /// is what a verifier checks against; `metadataURI` is display-only,
    /// same trust level as an ERC-721 `tokenURI`.
    string public metadataURI;

    error NotFactory();
    error ImmutableBag();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    event CompositionUpdated(uint256 indexed version, bytes32 compositionHash, string metadataURI);

    constructor(
        bytes32 _bagId,
        bytes32 _offChainRef,
        address _creator,
        bytes32 _compositionHash,
        string memory _metadataURI,
        bool _isMutable
    ) {
        bagId = _bagId;
        offChainRef = _offChainRef;
        creator = _creator;
        factory = msg.sender;
        isMutable = _isMutable;
        version = 1;
        compositionHash = _compositionHash;
        metadataURI = _metadataURI;
    }

    /// @notice Records a new composition version. Only callable by the
    /// factory (`BagFactory.recordBagVersion`), which only acts for the
    /// creator — the factory derives this Bag's id from `msg.sender`, so no
    /// other wallet can even address it. Reverts for an IMMUTABLE Bag.
    /// @return The new version number.
    function recordVersion(bytes32 _compositionHash, string calldata _metadataURI) external onlyFactory returns (uint256) {
        if (!isMutable) revert ImmutableBag();
        version += 1;
        compositionHash = _compositionHash;
        metadataURI = _metadataURI;
        emit CompositionUpdated(version, _compositionHash, _metadataURI);
        return version;
    }
}
