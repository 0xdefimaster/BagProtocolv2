// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {CreatorRewardsVault} from './CreatorRewardsVault.sol';

/// @title RedeemFeeRouter
/// @notice V11 revision: supports N input-asset legs in one atomic
/// redemption (Bag Protocol is multi-asset — a single redemption can span
/// BTC + ETH + SOL-wrapped + a Stock Token simultaneously; the prior
/// single-leg version of this contract could not represent that and
/// `signFeeAttestation()` failed closed with
/// `MultiAssetRedemptionNotSupportedError` for any such redemption,
/// meaning fee enforcement simply did not exist for the common case).
///
/// Same core guarantee as before, now over N legs instead of 1: pulls each
/// leg's input token from the caller, swaps each through an
/// owner-allowlisted DEX target (see `isAllowedSwapTarget` — verified
/// against Robinhood Chain's actual Uniswap v3 deployment, never a
/// self-hosted or invented address), sums the resulting `quoteToken`
/// output, verifies the backend's EIP-712 fee attestation (now binding the
/// FULL legs array, not just one token+amount), settles the fee to the
/// creator via `CreatorRewardsVault.settleReward` atomically, and sends
/// the remainder to the user — all in the same transaction, same user
/// signature (the one-time unrelated ERC-20 `approve` per leg's token, if
/// not already approved, aside).
///
/// A `swapTarget == address(0)` leg is a "no swap needed" leg: valid ONLY
/// when `inputToken == address(quoteToken)` (a Bag holding a position
/// already denominated in the settlement currency itself) — pulls the
/// token straight in without any external call, since there is nothing to
/// swap.
///
/// V12 revision (H1 security-audit follow-up): `redeem()` now also checks
/// every leg's `inputToken` against a real, owner-managed
/// `isAllowedInputToken` registry (populated off-chain from the canonical
/// Asset Registry — `lib/server/canonical-input-tokens.ts` — never a
/// second, hand-maintained list) BEFORE pulling anything from the caller.
/// `quoteToken` itself MUST be allowlisted here at deployment time (via
/// `setAllowedInputToken`) or every "no swap needed" leg reverts. This also
/// closes the remaining gap the original swapTarget-vs-token check left
/// open: a swap target can now never be ANY registered input token, not
/// only the current leg's own — see `_assertSwapTargetSafe()`.
contract RedeemFeeRouter is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on legs per redemption — bounds gas and reverts
    /// deterministically rather than letting an attacker (or a buggy
    /// frontend) submit an unbounded array. 12 comfortably covers any
    /// realistic Bag composition (`lib/domain/basket-protocol` bags are
    /// never this large in practice).
    uint256 public constant MAX_LEGS = 12;

    bytes32 private constant LEG_TYPEHASH =
        keccak256('RedeemLegAttestation(address inputToken,uint256 inputAmount,address swapTarget,bytes32 swapCallDataHash)');

    bytes32 private constant FEE_ATTESTATION_TYPEHASH = keccak256(
        'FeeAttestation(bytes32 redemptionId,address user,address creator,uint256 feeAmount,uint256 minUserProceeds,uint256 deadline,bytes32 legsHash)'
    );

    /// @notice The single settlement/quote currency every leg swaps into
    /// and fees are paid in — USDG on Robinhood Chain in production (see
    /// lib/config/robinhood-chain.ts). Fixed at deployment, same reasoning
    /// as `CreatorRewardsVault.rewardToken`.
    IERC20 public immutable quoteToken;

    /// @notice The vault every performance fee settles into.
    CreatorRewardsVault public immutable vault;

    /// @notice Backend signer trusted to attest fee amounts and the exact
    /// input legs they were computed from. Server-only key (see
    /// .env.example REDEEM_FEE_ATTESTOR_PRIVATE_KEY) — never shipped to
    /// the client. Rotatable by `owner` in case of compromise.
    address public feeAttestor;

    /// @notice Owner — rotates `feeAttestor` and the swap-target
    /// allowlist. Same multisig expectation as `CreatorRewardsVault.owner`.
    address public owner;

    /// @notice DEX/router contracts this contract is allowed to route
    /// swap legs to. Never forwards arbitrary calldata to an arbitrary
    /// target — a leg's `swapTarget` is checked against this mapping
    /// before any external call, for every leg, every time.
    mapping(address => bool) public isAllowedSwapTarget;

    /// @notice H1 follow-up (security audit) — a real, owner-managed
    /// registry of tokens this router will accept as a leg's `inputToken`
    /// (populated off-chain from the canonical Asset Registry — see
    /// `lib/server/canonical-input-tokens.ts` — plus the protocol's fixed
    /// settlement currency; never a second, independently-drifting list).
    ///
    /// This ALSO closes the remaining gap the security audit's H1 finding
    /// left open: `_assertLegSafe()` below now rejects a `swapTarget` that
    /// is ANY registered input token, not just the current leg's OWN
    /// `inputToken`/`quoteToken`. Without this, `owner` allowlisting some
    /// unrelated registered token X as a `swapTarget` (mistake or key
    /// compromise) would let a leg's `swapCallData` be
    /// `X.transferFrom(otherRedeemer, attacker, amount)` — spending ANY
    /// standing approval a DIFFERENT redeemer previously gave this router
    /// for X, since the call executes with `msg.sender == RedeemFeeRouter`.
    /// Checking against the registry (not just the current leg) closes the
    /// FULL class, not only the narrow same-leg variant.
    mapping(address => bool) public isAllowedInputToken;

    /// @notice Prevents the same signed attestation from being replayed —
    /// independent of, and in addition to, `CreatorRewardsVault.refUsed`
    /// (that mapping is keyed by the vault's own refId derived from
    /// `redemptionId`; this one gates the router's swap execution itself,
    /// so a replay is rejected before any swap is even attempted).
    mapping(bytes32 => bool) public redemptionExecuted;

    error ZeroAddress();
    error NotOwner();
    error NoLegs();
    error TooManyLegs(uint256 count, uint256 max);
    error SwapTargetNotAllowed(address target);
    error InputTokenNotAllowed(address token);
    error InvalidNoSwapLeg(address inputToken);
    error AttestationExpired(uint256 deadline, uint256 nowTs);
    error InvalidAttestationSigner(address recovered, address expected);
    error RedemptionAlreadyExecuted(bytes32 redemptionId);
    error SwapFailed(uint256 legIndex, bytes returnData);
    error InsufficientSwapOutput(uint256 output, uint256 required);
    error FeeExceedsOutput(uint256 feeAmount, uint256 swapOutput);

    event Redeemed(
        bytes32 indexed redemptionId,
        address indexed user,
        address indexed creator,
        uint256 legCount,
        uint256 swapOutput,
        uint256 feeAmount,
        uint256 userProceeds
    );
    event SwapTargetUpdated(address indexed target, bool allowed);
    event InputTokenAllowlistUpdated(address indexed token, bool allowed);
    event FeeAttestorUpdated(address indexed previousAttestor, address indexed newAttestor);
    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    struct RedeemLeg {
        address inputToken;
        uint256 inputAmount;
        /// @dev address(0) means "no swap" — only valid if inputToken == quoteToken.
        address swapTarget;
        bytes swapCallData;
    }

    /// @notice Bundles `redeem`'s parameters — avoids "stack too deep" and
    /// keeps the call site self-documenting, same reasoning as the
    /// single-leg version.
    struct RedeemParams {
        bytes32 redemptionId;
        RedeemLeg[] legs;
        address creator;
        uint256 feeAmount;
        uint256 minUserProceeds;
        uint256 deadline;
        bytes attestationSignature;
    }

    constructor(
        address _quoteToken,
        address _vault,
        address _feeAttestor,
        address _owner
    ) EIP712('BagRedeemFeeRouter', '3') {
        if (_quoteToken == address(0) || _vault == address(0) || _feeAttestor == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        quoteToken = IERC20(_quoteToken);
        vault = CreatorRewardsVault(_vault);
        feeAttestor = _feeAttestor;
        owner = _owner;
    }

    /// @notice Executes one redemption across N input-asset legs: pulls
    /// each leg's token from the caller, swaps it to `quoteToken` (or
    /// takes it directly if it already IS `quoteToken`), verifies the
    /// backend's fee attestation over the combined result, settles
    /// `feeAmount` to `creator` via the vault, and sends the remainder to
    /// the caller. Reverts entirely — no partial swap, no partial fee, no
    /// stuck funds, no leg left half-executed — if ANY leg or any later
    /// step fails.
    /// @param p Redemption parameters. `p.redemptionId` should be a
    /// deterministic id for this redemption (e.g. the Supabase
    /// `redeem_intents.id`, encoded as bytes32). It also becomes the
    /// vault's `refId`, so the same redemption can never be fee-settled
    /// twice by any path.
    function redeem(RedeemParams calldata p) external nonReentrant returns (uint256 userProceeds) {
        if (block.timestamp > p.deadline) revert AttestationExpired(p.deadline, block.timestamp);
        if (redemptionExecuted[p.redemptionId]) revert RedemptionAlreadyExecuted(p.redemptionId);
        if (p.legs.length == 0) revert NoLegs();
        if (p.legs.length > MAX_LEGS) revert TooManyLegs(p.legs.length, MAX_LEGS);

        _verifyAttestation(p);

        // Mark executed BEFORE any external call (checks-effects-interactions;
        // nonReentrant is defense in depth on top of this, not a substitute).
        redemptionExecuted[p.redemptionId] = true;

        uint256 quoteBefore = quoteToken.balanceOf(address(this));

        for (uint256 i = 0; i < p.legs.length; i++) {
            RedeemLeg calldata leg = p.legs[i];

            if (!isAllowedInputToken[leg.inputToken]) revert InputTokenNotAllowed(leg.inputToken);

            if (leg.swapTarget == address(0)) {
                if (leg.inputToken != address(quoteToken)) revert InvalidNoSwapLeg(leg.inputToken);
                IERC20(leg.inputToken).safeTransferFrom(msg.sender, address(this), leg.inputAmount);
                continue;
            }

            _assertSwapTargetSafe(leg.swapTarget);

            uint256 inputBefore = IERC20(leg.inputToken).balanceOf(address(this));
            IERC20(leg.inputToken).safeTransferFrom(msg.sender, address(this), leg.inputAmount);
            IERC20(leg.inputToken).forceApprove(leg.swapTarget, leg.inputAmount);

            (bool ok, bytes memory ret) = leg.swapTarget.call(leg.swapCallData);
            if (!ok) revert SwapFailed(i, ret);

            // Revoke any unused approval so a swap that only partially
            // consumed `inputAmount` can never be drained again later.
            IERC20(leg.inputToken).forceApprove(leg.swapTarget, 0);

            // Input the swap did not consume goes back to the redeemer
            // instead of staying in the router. Skipped for the quote token
            // itself, whose balance is the fee/proceeds accounting below.
            if (leg.inputToken != address(quoteToken)) {
                uint256 inputAfter = IERC20(leg.inputToken).balanceOf(address(this));
                if (inputAfter > inputBefore) {
                    IERC20(leg.inputToken).safeTransfer(msg.sender, inputAfter - inputBefore);
                }
            }
        }

        uint256 swapOutput = quoteToken.balanceOf(address(this)) - quoteBefore;
        if (swapOutput < p.minUserProceeds + p.feeAmount) {
            revert InsufficientSwapOutput(swapOutput, p.minUserProceeds + p.feeAmount);
        }
        if (p.feeAmount > swapOutput) revert FeeExceedsOutput(p.feeAmount, swapOutput);

        userProceeds = swapOutput - p.feeAmount;

        if (p.feeAmount > 0) {
            quoteToken.forceApprove(address(vault), p.feeAmount);
            vault.settleReward(p.creator, p.feeAmount, p.redemptionId);
        }

        quoteToken.safeTransfer(msg.sender, userProceeds);

        emit Redeemed(p.redemptionId, msg.sender, p.creator, p.legs.length, swapOutput, p.feeAmount, userProceeds);
    }

    /// @dev Binds redemptionId/user/creator/feeAmount/minUserProceeds/deadline
    /// PLUS a hash of every leg's (inputToken, inputAmount, swapTarget,
    /// keccak256(swapCallData)) — so the exact swap the backend quoted (its
    /// route, recipient and slippage floor) is the only one that can run.
    /// The fee is still checked against the REAL resulting balance; binding
    /// the calldata additionally stops a caller from substituting a
    /// different call against an allowlisted target.
    function _verifyAttestation(RedeemParams calldata p) private view {
        bytes32[] memory legHashes = new bytes32[](p.legs.length);
        for (uint256 i = 0; i < p.legs.length; i++) {
            legHashes[i] = keccak256(
                abi.encode(
                    LEG_TYPEHASH,
                    p.legs[i].inputToken,
                    p.legs[i].inputAmount,
                    p.legs[i].swapTarget,
                    keccak256(p.legs[i].swapCallData)
                )
            );
        }
        bytes32 legsHash = keccak256(abi.encodePacked(legHashes));

        bytes32 structHash = keccak256(
            abi.encode(
                FEE_ATTESTATION_TYPEHASH,
                p.redemptionId,
                msg.sender,
                p.creator,
                p.feeAmount,
                p.minUserProceeds,
                p.deadline,
                legsHash
            )
        );
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), p.attestationSignature);
        if (recovered != feeAttestor) revert InvalidAttestationSigner(recovered, feeAttestor);
    }

    /// @dev A swap target must be owner-allowlisted AND must never be a
    /// registered input token — see `isAllowedInputToken`'s own NatSpec for
    /// the exact attack this closes. Mirrors
    /// `BagExecutionRouter._assertLegTargetSafe()`'s identical reasoning
    /// (kept as its own function here, rather than inlined, so the
    /// invariant has one place to read and one place to test).
    function _assertSwapTargetSafe(address swapTarget) private view {
        if (!isAllowedSwapTarget[swapTarget]) revert SwapTargetNotAllowed(swapTarget);
        if (isAllowedInputToken[swapTarget]) revert SwapTargetNotAllowed(swapTarget);
    }

    function setSwapTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        isAllowedSwapTarget[target] = allowed;
        emit SwapTargetUpdated(target, allowed);
    }

    /// @notice Adds or removes a token from the input-token registry (see
    /// its own NatSpec). Owner-only, same trust level as `setSwapTarget` —
    /// neither can move funds, both only shape which legs `redeem()` will
    /// accept at all.
    function setAllowedInputToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isAllowedInputToken[token] = allowed;
        emit InputTokenAllowlistUpdated(token, allowed);
    }

    function setFeeAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit FeeAttestorUpdated(feeAttestor, newAttestor);
        feeAttestor = newAttestor;
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }
}
