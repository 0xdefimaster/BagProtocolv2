// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Bag} from './Bag.sol';

/// @title BagFactory
/// @notice Deploys and registers `Bag` instances. USER-SIGNED: `createBag` is
/// permissionless and binds the new Bag to `msg.sender` — the creator's own
/// wallet signs and sends the transaction. The backend holds no key that can
/// call it, and the owner role (fee and treasury only, see OWNER) cannot either.
///
/// This contract is deliberately as thin as possible — orchestration, not
/// business logic. It does NOT hold funds, compute NAV, touch a DEX, read an
/// oracle, or rebalance anything. The one transfer it makes is the protocol
/// CREATION FEE, paid in the chain's native currency (ETH): `createBag` is
/// payable, requires `msg.value == creationFee` exactly, and forwards it
/// straight to `treasury` in the same call (never held here). One
/// transaction, no token approval. Because the amount must match exactly, an
/// owner fee change can never charge a transaction already in flight more
/// (or less) than the creator's wallet showed — it reverts instead — and
/// `creationFee` can never exceed the immutable `creationFeeCap`.
///
/// OWNER. The owner can change only the fee (up to the cap) and the treasury
/// address, and hand ownership over (two-step). It cannot create, edit or
/// touch any Bag, and cannot move anyone's funds.
///
/// IDENTITY. The on-chain identity of a Bag is
///
///     bagId = keccak256(abi.encode(creator, offChainRef))
///
/// where `offChainRef` is the off-chain Supabase `bags.id` (UUID) encoded as
/// bytes32 by the caller (lib/domain/basket-protocol/onchain.ts's
/// `computeOnChainBagId()`), and `creator` is `msg.sender`. Binding the id to
/// the sender is what makes a permissionless `createBag` safe: nobody can
/// pre-register (squat) someone else's Bag, because a different sender
/// derives a DIFFERENT `bagId` from the same `offChainRef`. The off-chain
/// server additionally only ever accepts a deployment whose `creator` equals
/// the authenticated session wallet (lib/blockchain/evm/adapter.ts's
/// `verifyBagCreation()`).
contract BagFactory {
    /// @notice Hard upper bound on `creationFee` (wei), fixed forever at deployment.
    uint256 public immutable creationFeeCap;

    /// @notice Current creation fee in wei of the native currency. May be 0.
    uint256 public creationFee;

    /// @notice Where creation fees are sent.
    address public treasury;

    address public owner;
    address public pendingOwner;

    /// @notice bagId (creator-bound, see contract NatSpec) -> deployed Bag address.
    mapping(bytes32 => address) public bagOf;

    /// @notice creator address -> bagIds they've deployed, in deployment order.
    mapping(address => bytes32[]) public bagsByCreator;

    error AlreadyDeployed(bytes32 bagId, address existing);
    error ZeroOffChainRef();
    error UnknownBag(bytes32 bagId);
    error StaleVersion(uint256 expected, uint256 actual);
    error ZeroCompositionHash();
    error NotOwner();
    error ZeroAddress();
    error FeeAboveCap(uint256 fee, uint256 cap);
    error WrongCreationFee(uint256 sent, uint256 fee);
    error FeeTransferFailed();

    event CreationFeePaid(bytes32 indexed bagId, address indexed payer, uint256 amount, address treasury);
    event CreationFeeUpdated(uint256 previousFee, uint256 newFee);
    event TreasuryUpdated(address previousTreasury, address newTreasury);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, address _treasury, uint256 _creationFee, uint256 _creationFeeCap) {
        if (_owner == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_creationFee > _creationFeeCap) revert FeeAboveCap(_creationFee, _creationFeeCap);
        owner = _owner;
        treasury = _treasury;
        creationFee = _creationFee;
        creationFeeCap = _creationFeeCap;
        emit OwnershipTransferred(address(0), _owner);
    }

    /// @notice Emitted once per successful deployment. `bagId`, `creator` and
    /// `offChainRef` are indexed so a verifier can filter by any of them.
    event BagCreated(
        bytes32 indexed bagId,
        address indexed creator,
        bytes32 indexed offChainRef,
        address bag,
        bytes32 compositionHash,
        uint256 version
    );

    /// @notice Emitted once per recorded version (in addition to the Bag's own
    /// `CompositionUpdated`). `bagId`, `creator` and `bag` are indexed.
    event BagVersionRecorded(
        bytes32 indexed bagId,
        address indexed creator,
        address indexed bag,
        uint256 version,
        bytes32 compositionHash,
        string metadataURI
    );

    /// @notice The canonical bag id for a (creator, offChainRef) pair. Pure —
    /// off-chain code re-derives the same value (`deriveOnChainBagId()`).
    function deriveBagId(address creator, bytes32 offChainRef) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, offChainRef));
    }

    /// @notice Deploys a new `Bag` for (`msg.sender`, `offChainRef`) and
    /// registers it. Reverts if that pair already has a deployed Bag.
    /// @param offChainRef The off-chain Supabase `bags.id` (UUID) as bytes32 —
    /// see `computeOnChainBagId()` (the UUID's 32 hex chars, left-padded; NOT
    /// hashed, so it round-trips).
    /// @param compositionHash keccak256 of the canonical composition string —
    /// see `Bag.sol` and `computeOnChainCompositionHash()`.
    /// @param metadataURI Display-only pointer; not authoritative.
    /// @param isMutable Whether the Bag may later record new versions (mirrors
    /// off-chain `bags.mutability`; the server verifies it at confirm time).
    /// `msg.value` must equal `creationFee` exactly (`WrongCreationFee`).
    function createBag(
        bytes32 offChainRef,
        bytes32 compositionHash,
        string calldata metadataURI,
        bool isMutable
    ) external payable returns (address bag) {
        if (offChainRef == bytes32(0)) revert ZeroOffChainRef();
        // Same invariant recordBagVersion() enforces: every version, including
        // the first, must commit to a real composition.
        if (compositionHash == bytes32(0)) revert ZeroCompositionHash();

        uint256 fee = creationFee;
        if (msg.value != fee) revert WrongCreationFee(msg.value, fee);

        address creator = msg.sender;
        bytes32 bagId = deriveBagId(creator, offChainRef);
        address existing = bagOf[bagId];
        if (existing != address(0)) revert AlreadyDeployed(bagId, existing);

        bag = address(new Bag(bagId, offChainRef, creator, compositionHash, metadataURI, isMutable));

        bagOf[bagId] = bag;
        bagsByCreator[creator].push(bagId);

        // Registry effects are written first; forwarding the fee is the last
        // external call. A treasury that refuses ETH reverts the creation.
        if (fee > 0) {
            address to = treasury;
            (bool sent, ) = to.call{value: fee}('');
            if (!sent) revert FeeTransferFailed();
            emit CreationFeePaid(bagId, creator, fee, to);
        }

        emit BagCreated(bagId, creator, offChainRef, bag, compositionHash, 1);
    }

    /// @notice Records a new composition version for the CALLER's own Bag.
    /// The Bag is addressed by (`msg.sender`, `offChainRef`) — the same
    /// creator-bound derivation as `createBag` — so a stranger can never reach
    /// another creator's Bag (they derive a different, unregistered id).
    /// `expectedCurrentVersion` is a compare-and-swap guard: two updates built
    /// against the same version cannot both land; the second reverts
    /// `StaleVersion`. An IMMUTABLE Bag reverts `ImmutableBag` (in `Bag`).
    /// @return newVersion The Bag's version after this call.
    function recordBagVersion(
        bytes32 offChainRef,
        uint256 expectedCurrentVersion,
        bytes32 compositionHash,
        string calldata metadataURI
    ) external returns (uint256 newVersion) {
        if (compositionHash == bytes32(0)) revert ZeroCompositionHash();
        bytes32 bagId = deriveBagId(msg.sender, offChainRef);
        address bag = bagOf[bagId];
        if (bag == address(0)) revert UnknownBag(bagId);
        uint256 current = Bag(bag).version();
        if (current != expectedCurrentVersion) revert StaleVersion(expectedCurrentVersion, current);
        newVersion = Bag(bag).recordVersion(compositionHash, metadataURI);
        emit BagVersionRecorded(bagId, msg.sender, bag, newVersion, compositionHash, metadataURI);
    }

    // ------------------------------------------------------------ admin

    /// @notice Sets the creation fee (wei), never above `creationFeeCap`.
    function setCreationFee(uint256 newFee) external onlyOwner {
        if (newFee > creationFeeCap) revert FeeAboveCap(newFee, creationFeeCap);
        emit CreationFeeUpdated(creationFee, newFee);
        creationFee = newFee;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Step one of a two-step ownership handover; `newOwner` must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Number of Bags a given creator has deployed through this factory.
    function bagCountOf(address creator) external view returns (uint256) {
        return bagsByCreator[creator].length;
    }
}
