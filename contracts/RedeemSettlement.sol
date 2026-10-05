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
        address executor;
        bytes32 contextHash;
        uint256 consumedBasis;
        uint256 lossCarry;
        uint256 feeRateBps;
        uint256 minUserProceeds;
        uint256 deadline;
    }

    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        'Settlement(bytes32 redemptionId,address user,address creator,address executor,bytes32 contextHash,uint256 consumedBasis,uint256 lossCarry,uint256 feeRateBps,uint256 minUserProceeds,uint256 deadline)'
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
    event AttestorUpdated(address indexed previous, address indexed current);
    event OwnerUpdated(address indexed previous, address indexed current);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _usdg, address _attestor, address _owner) EIP712('BagRedeemSettlement', '1') {
        if (_usdg == address(0) || _attestor == address(0) || _owner == address(0)) revert ZeroAddress();
        usdg = IERC20(_usdg);
        attestor = _attestor;
        owner = _owner;
    }

    /// @notice Settles one redemption: computes the fee on what actually
    /// arrived, pays it to `s.creator`, and everything else to `s.user`.
    function settle(Settlement calldata s, bytes calldata signature) external nonReentrant returns (uint256 userProceeds) {
        if (block.timestamp > s.deadline) revert Expired(s.deadline, block.timestamp);
        if (settled[s.redemptionId]) revert AlreadySettled(s.redemptionId);
        if (msg.sender != s.executor) revert WrongExecutor(msg.sender, s.executor);
        if (s.user == address(0)) revert ZeroAddress();
        if (s.feeRateBps > MAX_FEE_RATE_BPS) revert FeeRateTooHigh(s.feeRateBps);
        if (s.feeRateBps > 0 && s.creator == address(0)) revert ZeroAddress();

        address recovered = ECDSA.recover(_hashTypedDataV4(hashSettlement(s)), signature);
        if (recovered != attestor) revert InvalidSignature(recovered);

        // Effects before the external transfers.
        settled[s.redemptionId] = true;

        uint256 received = usdg.balanceOf(address(this));
        if (received == 0) revert NothingReceived();

        (uint256 feeBase, uint256 fee) = computeFee(received, s.consumedBasis, s.lossCarry, s.feeRateBps);
        userProceeds = received - fee;
        if (userProceeds < s.minUserProceeds) revert BelowMinimum(userProceeds, s.minUserProceeds);

        if (fee > 0) usdg.safeTransfer(s.creator, fee);
        usdg.safeTransfer(s.user, userProceeds);

        // Never hold anything between transactions.
        uint256 remaining = usdg.balanceOf(address(this));
        if (remaining != 0) revert BalanceLeft(remaining);

        emit Settled(s.redemptionId, s.user, s.creator, s.executor, s.contextHash, received, feeBase, fee, userProceeds);
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

    /// @notice The EIP-712 struct hash of a settlement (exposed so off-chain
    /// signers and tests hash exactly what the contract verifies).
    function hashSettlement(Settlement calldata s) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                s.redemptionId,
                s.user,
                s.creator,
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
