// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

/// @title RedeemSettlement — settlement primitive with the B0 creator fee
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
/// Fee (B0, docs/FEE_ECONOMICS_DESIGN.md): the attestor signs `feeAmount`,
/// computed off-chain on the guaranteed minimum (never above the fee on the
/// actual result), and the contract pays it straight to the signed
/// `creator` — no rewards vault in between (protocol share is 0, F6). The
/// user gets everything else. `feeAmount = 0` (a Bag without a fee, or a
/// creator selling their own Bag) settles everything to the user. B (fee
/// computed here from the measured amount) is a later version.
///
/// Creator payout is a direct transfer: if USDG refuses it (USDG is a Paxos
/// token and can freeze addresses), the whole settlement reverts and the
/// user keeps their holdings — the backend must not sign for a frozen
/// creator. Assets never leave the user's wallet outside a settlement.
///
/// Amounts: the amount settled is what this contract actually holds when
/// `settle` runs — never a quote or a simulation. Live runs showed the two
/// differ (a route intermediary kept a few units, §7.1a).
///
/// Authorization: the backend's attestor signs one EIP-712 `Settlement`
/// struct covering every parameter. `msg.sender` must be the executor named
/// in it (for Composer: the user's own execution proxy, taken from that
/// redemption's compile result). `tx.origin` is never used.
///
/// Stray balance: anyone can send USDG here between transactions. It is
/// counted into the next settlement and paid to that settlement's user —
/// it can only add to a user's proceeds, never block a settlement. (Requiring
/// "balance == amount pushed" instead would let a 1-unit donation block
/// every settlement.)
contract RedeemSettlement is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @dev Every field is signed; none can be supplied unsigned.
    /// `contextHash` binds the off-chain state the attestor checked (Bag,
    /// strategy version, accounting snapshot such as basis and loss carry):
    /// a stale or different context is a different hash, so a different
    /// signature. The contract treats it as opaque and emits it. `creator`
    /// is the Bag's creator as BAG's own records and the Bag's on-chain
    /// identity give it — never a value the caller chooses; the attestor signs
    /// it together with the fee.
    struct Settlement {
        bytes32 redemptionId;
        address user;
        address creator;
        address executor;
        bytes32 contextHash;
        uint256 feeAmount;
        uint256 minUserProceeds;
        uint256 deadline;
    }

    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        'Settlement(bytes32 redemptionId,address user,address creator,address executor,bytes32 contextHash,uint256 feeAmount,uint256 minUserProceeds,uint256 deadline)'
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
    error BelowMinimum(uint256 received, uint256 required);
    error NothingReceived();
    error BalanceLeft(uint256 remaining);

    event Settled(
        bytes32 indexed redemptionId,
        address indexed user,
        address indexed creator,
        address executor,
        bytes32 contextHash,
        uint256 received,
        uint256 feeAmount,
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

    /// @notice Settles one redemption: pays `s.feeAmount` to `s.creator` and
    /// everything else this contract holds to `s.user`. The executor must have transferred the redemption's USDG
    /// here earlier in the same transaction.
    function settle(Settlement calldata s, bytes calldata signature) external nonReentrant returns (uint256 userProceeds) {
        if (block.timestamp > s.deadline) revert Expired(s.deadline, block.timestamp);
        if (settled[s.redemptionId]) revert AlreadySettled(s.redemptionId);
        if (msg.sender != s.executor) revert WrongExecutor(msg.sender, s.executor);
        if (s.user == address(0)) revert ZeroAddress();
        if (s.feeAmount > 0 && s.creator == address(0)) revert ZeroAddress();

        address recovered = ECDSA.recover(_hashTypedDataV4(hashSettlement(s)), signature);
        if (recovered != attestor) revert InvalidSignature(recovered);

        // Effects before the external transfer.
        settled[s.redemptionId] = true;

        uint256 received = usdg.balanceOf(address(this));
        if (received == 0) revert NothingReceived();
        // The user's floor holds after the fee: received ≥ minUserProceeds + feeAmount.
        uint256 required = s.minUserProceeds + s.feeAmount;
        if (received < required) revert BelowMinimum(received, required);

        userProceeds = received - s.feeAmount;
        if (s.feeAmount > 0) usdg.safeTransfer(s.creator, s.feeAmount);
        usdg.safeTransfer(s.user, userProceeds);

        // Never hold anything between transactions.
        uint256 remaining = usdg.balanceOf(address(this));
        if (remaining != 0) revert BalanceLeft(remaining);

        emit Settled(s.redemptionId, s.user, s.creator, s.executor, s.contextHash, received, s.feeAmount, userProceeds);
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
                s.feeAmount,
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
