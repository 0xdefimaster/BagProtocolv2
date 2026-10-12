// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

/// @title RedeemSettlement — settlement primitive with the creator fee on actual proceeds (B)
/// @notice The on-chain end of a redemption executed elsewhere (a LI.FI
/// Composer flow, or any other executor). The executor sells the user's
/// holdings into `usdg`, transfers ALL of that USDG to this contract, then
/// calls `settle` in the same transaction ("push" model — proven live on
/// Robinhood Chain, docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §7).
///
/// This contract never swaps, never calls an executor or a DEX, and never
/// takes custody between transactions: every `settle` forwards its whole
/// balance and must end at zero.
///
/// Fee (B, docs/FEE_ECONOMICS_DESIGN.md): computed HERE from the amount that
/// actually arrived, not from a quote or a server-computed figure:
///
///     fee = floor(max(0, received − consumedBasis − lossCarry) × feeRateBps / 10000)
///
/// The attestor only supplies (and signs) the inputs it is the authority
/// for — the position's consumed cost basis and loss carry from BAG's
/// ledger (rounded up, §5.7), the Bag's locked fee rate, the creator — and
/// the user's floor. `feeRateBps = 0` (a Bag without a fee, or a creator
/// selling their own Bag) settles everything to the user. The same formula
/// is `computeB0Fee` in lib/domain/basket-protocol/redeem/performance-fee-b0.ts
/// with the gross set to the measured amount; tests check the two agree.
/// The fee goes straight to `creator` — no rewards vault in between
/// (protocol share is 0, F6).
///
/// Fork royalty (v2): when the Bag is a fork, `rootCreator` is the creator of
/// the Bag at the root of its lineage, and FORK_ROYALTY_SHARE_BPS of the fee
/// goes to them in the same transaction; `creator` gets the rest. The user
/// pays nothing extra. A Bag that is not a fork (rootCreator = 0), or a fork
/// whose root creator is its own creator, pays the whole fee to `creator`.
/// The share is a constant of this contract: a different share is a
/// different deployment, never a signed value.
///
/// Creator payout is a direct transfer: if USDG refuses it (USDG is a Paxos
/// token and can freeze addresses), the whole settlement reverts and the
/// user keeps their holdings. That revert is the guarantee. The backend's
/// freeze check before signing is only a preflight that avoids failed
/// transactions: a creator can be frozen between the check and the
/// transaction. Nothing is ever left here for a creator to claim later.
///
/// Authorization: the backend's attestor signs one EIP-712 `Settlement`
/// struct covering every parameter. `msg.sender` must be the executor named
/// in it (for Composer: the user's own execution proxy, taken from that
/// redemption's compile result). `tx.origin` is never used.
///
/// `received` is this contract's USDG balance at settlement time — NOT
/// strictly "this redemption's execution output". In the push model it
/// cannot be a before/after delta: the executor's transfer runs no code
/// here, so there is no "before" to read. Every successful settlement ends
/// at zero, and a failed one rolls back its own transaction — but USDG that
/// a third party sent here in an EARLIER, separate transaction is not rolled
/// back and is counted into the next settlement's `received`. That can only
/// add to that user's proceeds (they get donation × (1 − rate) ≥ 70% of it;
/// the creator the rest above basis); the donor alone loses. Not used,
/// on purpose: an amount argument passed by the executor (it comes from the
/// user's own Composer transaction, so the user could understate it to cut
/// the fee) and an exact "balance == amount pushed" rule (a 1-unit donation
/// would block every settlement).
contract RedeemSettlement is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice Highest fee rate a Bag can lock (types/basket-protocol.ts
    /// MAX_PERFORMANCE_FEE_BPS). A signed rate above it is refused.
    uint256 public constant MAX_FEE_RATE_BPS = 3000;

    /// @notice Share of the fee paid to the root creator of a fork (20%).
    uint256 public constant FORK_ROYALTY_SHARE_BPS = 2000;

    /// @dev Every field is signed; none can be supplied unsigned.
    /// `creator` is the Bag's creator as BAG's own records and the Bag's
    /// on-chain identity give it — never a value the caller chooses.
    /// `consumedBasis` / `lossCarry` are the ledger's figures for the shares
    /// being sold, in USDG raw units, rounded up. `contextHash` binds the rest
    /// of the state the attestor checked (Bag / definition hash, strategy
    /// version, the ledger snapshot those figures came from): stale state is a
    /// different hash, so a different signature. The contract treats it as
    /// opaque and emits it.
    struct Settlement {
        bytes32 redemptionId;
        address user;
        address creator;
        address rootCreator;
        address executor;
        bytes32 contextHash;
        uint256 consumedBasis;
        uint256 lossCarry;
        uint256 feeRateBps;
        uint256 minUserProceeds;
        uint256 deadline;
    }

    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        'Settlement(bytes32 redemptionId,address user,address creator,address rootCreator,address executor,bytes32 contextHash,uint256 consumedBasis,uint256 lossCarry,uint256 feeRateBps,uint256 minUserProceeds,uint256 deadline)'
    );

    /// @notice The only token this contract settles. Fixed at deployment: a
    /// different settlement token is a different deployment.
    IERC20 public immutable usdg;

    /// @notice Backend key whose signature authorizes a settlement. Rotatable
    /// by `owner` (expected: a multisig) if compromised.
    address public attestor;
    address public owner;

    /// @notice A redemption can be settled at most once, by any path.
    mapping(bytes32 => bool) public settled;

    error ZeroAddress();
    error NotOwner();
    error Expired(uint256 deadline, uint256 nowTs);
    error AlreadySettled(bytes32 redemptionId);
    error WrongExecutor(address caller, address expected);
    error InvalidSignature(address recovered);
    error FeeRateTooHigh(uint256 feeRateBps);
    error BelowMinimum(uint256 userProceeds, uint256 minUserProceeds);
    error NothingReceived();
    error BalanceLeft(uint256 remaining);

    event Settled(
        bytes32 indexed redemptionId,
        address indexed user,
        address indexed creator,
        address executor,
        bytes32 contextHash,
        uint256 received,
        uint256 feeBase,
        uint256 fee,
        uint256 userProceeds
    );
    /// @notice Emitted with `Settled` when part of the fee went to a fork's
    /// root creator. `Settled.fee` is the whole fee; the creator received
    /// `fee − royalty`.
    event RoyaltyPaid(bytes32 indexed redemptionId, address indexed rootCreator, address indexed creator, uint256 royalty);
    event AttestorUpdated(address indexed previous, address indexed current);
    event OwnerUpdated(address indexed previous, address indexed current);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _usdg, address _attestor, address _owner) EIP712('BagRedeemSettlement', '2') {
        if (_usdg == address(0) || _attestor == address(0) || _owner == address(0)) revert ZeroAddress();
        usdg = IERC20(_usdg);
        attestor = _attestor;
        owner = _owner;
    }

    /// @notice Settles one redemption: computes the fee on what actually
    /// arrived, pays it to `s.creator` (a fork's root creator gets their share
    /// of it), and everything else to `s.user`.
    function settle(Settlement calldata s, bytes calldata signature) external nonReentrant returns (uint256 userProceeds) {
        Settlement memory m = s;
        return _settle(m, ECDSA.recover(_hashTypedDataV4(_hashSettlement(m)), signature));
    }

    /// @notice The same settlement with flat, static arguments — the form a
    /// LI.FI Composer `core.call` can encode (static Solidity types only; a
    /// tuple or a dynamic `bytes` argument is not relied on). The executor is
    /// `msg.sender`: the attestor signed the expected executor, so a call from
    /// anyone else recovers a different signer and is refused. The signature
    /// is passed in EIP-2098 compact form (r, vs) — one argument fewer than
    /// (v, r, s) — and the fee rate travels with the deadline in one word
    /// (`feeRateAndDeadline = deadline << 16 | feeRateBps`, the rate ≤ 3000
    /// fits 16 bits); both keep this within the legacy code generator's stack
    /// limit without switching the whole project to via-IR. The signed struct
    /// still has them as separate fields.
    function settleFlat(
        bytes32 redemptionId,
        address user,
        address creator,
        address rootCreator,
        bytes32 contextHash,
        uint256 consumedBasis,
        uint256 lossCarry,
        uint256 minUserProceeds,
        uint256 feeRateAndDeadline,
        bytes32 r,
        bytes32 vs
    ) external nonReentrant returns (uint256) {
        Settlement memory m = Settlement({
            redemptionId: redemptionId,
            user: user,
            creator: creator,
            rootCreator: rootCreator,
            executor: msg.sender,
            contextHash: contextHash,
            consumedBasis: consumedBasis,
            lossCarry: lossCarry,
            feeRateBps: feeRateAndDeadline & 0xFFFF,
            minUserProceeds: minUserProceeds,
            deadline: feeRateAndDeadline >> 16
        });
        return _settle(m, ECDSA.recover(_hashTypedDataV4(_hashSettlement(m)), r, vs));
    }

    function _settle(Settlement memory s, address recovered) private returns (uint256 userProceeds) {
        if (block.timestamp > s.deadline) revert Expired(s.deadline, block.timestamp);
        if (settled[s.redemptionId]) revert AlreadySettled(s.redemptionId);
        if (msg.sender != s.executor) revert WrongExecutor(msg.sender, s.executor);
        if (s.user == address(0)) revert ZeroAddress();
        if (s.feeRateBps > MAX_FEE_RATE_BPS) revert FeeRateTooHigh(s.feeRateBps);
        if (s.feeRateBps > 0 && s.creator == address(0)) revert ZeroAddress();
        if (recovered != attestor) revert InvalidSignature(recovered);

        // Effects before the external transfers.
        settled[s.redemptionId] = true;

        uint256 received = usdg.balanceOf(address(this));
        if (received == 0) revert NothingReceived();

        (uint256 feeBase, uint256 fee) = computeFee(received, s.consumedBasis, s.lossCarry, s.feeRateBps);
        userProceeds = received - fee;
        if (userProceeds < s.minUserProceeds) revert BelowMinimum(userProceeds, s.minUserProceeds);

        _payFee(s, fee);
        usdg.safeTransfer(s.user, userProceeds);

        // Never hold anything between transactions.
        uint256 remaining = usdg.balanceOf(address(this));
        if (remaining != 0) revert BalanceLeft(remaining);

        emit Settled(s.redemptionId, s.user, s.creator, s.executor, s.contextHash, received, feeBase, fee, userProceeds);
    }

    /// @dev The fee to the creator, minus a fork root creator's share (RoyaltyPaid).
    function _payFee(Settlement memory s, uint256 fee) private {
        if (fee == 0) return;
        uint256 royalty = computeRoyalty(fee, s.creator, s.rootCreator);
        if (fee > royalty) usdg.safeTransfer(s.creator, fee - royalty);
        if (royalty > 0) {
            usdg.safeTransfer(s.rootCreator, royalty);
            emit RoyaltyPaid(s.redemptionId, s.rootCreator, s.creator, royalty);
        }
    }

    /// @notice fee = floor(max(0, received − basis − carry) × rate / 10000).
    /// Pure and public so the backend's preview and the tests can check they
    /// compute exactly what the contract charges. `fee ≤ received` always
    /// (rate ≤ 10000 and feeBase ≤ received).
    function computeFee(uint256 received, uint256 consumedBasis, uint256 lossCarry, uint256 feeRateBps)
        public
        pure
        returns (uint256 feeBase, uint256 fee)
    {
        uint256 hurdle = consumedBasis + lossCarry;
        feeBase = received > hurdle ? received - hurdle : 0;
        fee = (feeBase * feeRateBps) / 10000;
    }

    /// @notice The root creator's share of `fee`: FORK_ROYALTY_SHARE_BPS of it,
    /// rounded down, when the Bag is a fork with a different root creator;
    /// otherwise 0. `royalty ≤ fee` always.
    function computeRoyalty(uint256 fee, address creator, address rootCreator) public pure returns (uint256 royalty) {
        if (rootCreator == address(0) || rootCreator == creator) return 0;
        return (fee * FORK_ROYALTY_SHARE_BPS) / 10000;
    }

    /// @notice The EIP-712 struct hash of a settlement (exposed so off-chain
    /// signers and tests hash exactly what the contract verifies).
    function hashSettlement(Settlement calldata s) external pure returns (bytes32) {
        return _hashSettlement(s);
    }

    function _hashSettlement(Settlement memory s) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                s.redemptionId,
                s.user,
                s.creator,
                s.rootCreator,
                s.executor,
                s.contextHash,
                s.consumedBasis,
                s.lossCarry,
                s.feeRateBps,
                s.minUserProceeds,
                s.deadline
            )
        );
    }

    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit AttestorUpdated(attestor, newAttestor);
        attestor = newAttestor;
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }
}
