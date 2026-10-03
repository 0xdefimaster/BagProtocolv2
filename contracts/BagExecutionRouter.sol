// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';

interface IBagFactory {
    function bagOf(bytes32 bagId) external view returns (address);
}

/// @title BagExecutionRouter
/// @notice Item 7's production BAG-native execution router. Executes ONE
/// compiled BAG execution plan (`lib/execution/types.ts`'s
/// `CompiledExecution`) as a single atomic transaction: pull the user's
/// input asset, run N allowlisted swap legs, verify every output against
/// its own minimum, return everything to the user.
///
/// This REPLACES `contracts/spike/BagRouterSpike.sol` as the production
/// boundary. That contract remains untouched, for the Phase 19.X
/// composability spike it was written for, and must never be used to move
/// real user funds — it accepts an arbitrary `target` (so its own calldata
/// can be pointed at an ERC-20 to drain another user's leftover allowance),
/// verifies output with an absolute `balanceOf` (so tokens injected into the
/// router by anyone satisfy a `minOutput` the legs never actually produced),
/// and has no notion of which Bag, which plan, or which deadline it is
/// executing for. Every one of those is a deliberate, tested boundary here.
///
/// ------------------------------------------------------------------
/// TRUST BOUNDARY (item 1) — five separate parties, none of which can
/// take another's powers:
///
///  1. `bagFactory` (immutable) — the ONLY trusted Bag registry. A plan is
///     executable only for a `bagId` that `BagFactory.bagOf()` actually
///     resolves to a deployed `Bag`. Reuses the existing factory
///     (item 6); this router never re-implements Bag identity, never
///     deploys a Bag, and never writes to one.
///  2. `owner` — admin/governance (a multisig in production, same
///     expectation as `CreatorRewardsVault.owner`; `BagFactory` itself has no owner).
///     Manages the target/token allowlists and rotates `planSigner`.
///     CANNOT move user funds, cannot execute a plan, cannot sign one.
///  3. `planSigner` — the backend key that attests "this exact plan came
///     out of BAG's own compiler" by EIP-712-signing it. Cannot change
///     allowlists and cannot pull funds from anyone who does not submit the
///     plan themselves. It IS a privileged key, though: it chooses each
///     leg's calldata, and an allowlisted DEX router's calldata can name a
///     swap recipient. A stolen signer could therefore get a user to submit
///     a plan whose legs send output elsewhere, bounded only by the
///     `minOutputs` the router checks on its own balance. Treat it as a hot
///     execution-authorization key: isolated signer/HSM, rotation via
///     `setPlanSigner`, monitoring — see docs/SECURITY_HARDENING_DEPLOY.md.
///  4. the CALLER (`msg.sender`) — the user, and the only source and
///     destination of funds as far as this contract is concerned. Input is
///     pulled from `msg.sender`; everything the router itself ends up
///     holding (declared outputs and leftovers) goes back to `msg.sender`.
///     There is no `recipient` parameter on the router. What an external
///     leg does with the tokens it is approved for is governed by its
///     calldata, i.e. by `planSigner` (#3).
///  5. external protocols (`leg.target`) — untrusted by default, usable
///     only once `owner` allowlists them, never able to receive an
///     allowance beyond the exact amount a leg declares.
/// ------------------------------------------------------------------
contract BagExecutionRouter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One external protocol call. Mirrors the shape every
    /// aggregator/DEX router already expects (approve, then let the target
    /// pull), and maps 1:1 onto one `ExecutableTransaction` a
    /// `CompiledExecution` carries (item 3).
    struct Leg {
        /// Contract to call. MUST be allowlisted (`isAllowedTarget`) and
        /// MUST NOT be a token (see `_assertLegTargetSafe`).
        address target;
        /// Calldata built off-chain by BAG's compiler from the provider's
        /// own quote. Covered by the plan signature, so it is exactly the
        /// bytes BAG compiled — never attacker-substituted.
        bytes callData;
        /// Native value to forward. Non-zero only for native-input legs.
        uint256 value;
        /// Token `target` is allowed to pull from this router for this leg
        /// (address(0) for a pure-native leg).
        address approveToken;
        /// Exact allowance granted for this leg — never unlimited, and
        /// always reset to 0 immediately after the call returns.
        uint256 approveAmount;
    }

    /// @notice Per-output-token floor, measured as a BALANCE DELTA across
    /// the whole execution (never an absolute balance — see
    /// `_snapshotBalances`).
    struct OutputCheck {
        address token;
        uint256 minAmountOut;
    }

    /// @notice A complete compiled execution, as signed by `planSigner`.
    /// Everything economically meaningful is inside the signed struct, so
    /// none of it can be altered by whoever submits the transaction.
    struct ExecutionPlan {
        /// The Bag this execution belongs to, as bytes32 — the SAME
        /// encoding `Bag.bagId` / `BagFactory.bagOf` already use
        /// (`computeOnChainBagId()`), so no new identity concept is
        /// introduced (item 6).
        bytes32 bagId;
        /// `CompiledExecution.executionPlanHash` — BAG's own graph
        /// fingerprint (`computeBagExecutionGraphHash()`), carried
        /// on-chain so an execution is provably tied to one specific
        /// compiled graph. Also the replay key (`executedPlans`).
        bytes32 executionPlanHash;
        /// The wallet this plan was compiled FOR. Enforced to equal
        /// `msg.sender`, so one user's plan can never be executed by
        /// another user's transaction.
        address wallet;
        address inputToken;
        uint256 inputAmount;
        uint256 deadline;
        Leg[] legs;
        OutputCheck[] minOutputs;
    }

    bytes32 private constant LEG_TYPEHASH =
        keccak256('Leg(address target,bytes callData,uint256 value,address approveToken,uint256 approveAmount)');
    bytes32 private constant OUTPUT_CHECK_TYPEHASH = keccak256('OutputCheck(address token,uint256 minAmountOut)');
    bytes32 private constant EXECUTION_PLAN_TYPEHASH =
        keccak256(
            'ExecutionPlan(bytes32 bagId,bytes32 executionPlanHash,address wallet,address inputToken,uint256 inputAmount,uint256 deadline,Leg[] legs,OutputCheck[] minOutputs)Leg(address target,bytes callData,uint256 value,address approveToken,uint256 approveAmount)OutputCheck(address token,uint256 minAmountOut)'
        );

    /// @notice Trusted Bag registry. Immutable — repointing this would
    /// change which Bags are real, so it is fixed at deployment.
    IBagFactory public immutable bagFactory;

    address public owner;
    address public planSigner;

    /// @notice Protocols a leg may call. Empty by default: this router can
    /// do nothing at all until `owner` explicitly allows a target.
    mapping(address => bool) public isAllowedTarget;

    /// @notice Assets this router may take in or hand out. A token being
    /// here is ALSO what forbids it from being used as a leg `target`.
    mapping(address => bool) public isAllowedToken;

    /// @notice Plans already executed, keyed by EIP-712 digest. Makes a
    /// signed plan strictly single-use (item 5: stale/invalid plans).
    mapping(bytes32 => bool) public executedPlans;

    error NotOwner();
    error ZeroAddress();
    error PlanExpired(uint256 deadline, uint256 nowTs);
    error PlanAlreadyExecuted(bytes32 digest);
    error InvalidPlanSignature();
    error WalletMismatch(address planWallet, address caller);
    error UnknownBag(bytes32 bagId);
    error NoLegs();
    error ZeroInputAmount();
    error TargetNotAllowed(address target);
    error TokenNotAllowed(address token);
    error TargetIsToken(address target);
    error LegCallFailed(uint256 legIndex);
    error InsufficientOutput(address token, uint256 received, uint256 minAmountOut);
    error DuplicateOutputCheck(address token);
    error NativeValueMismatch(uint256 supplied, uint256 required);
    error NoOutputChecks();
    error ZeroMinOutput(address token);
    error NativeRefundFailed();
    error OutputIsInputToken(address token);

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event PlanSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event TargetAllowlistUpdated(address indexed target, bool allowed);
    event TokenAllowlistUpdated(address indexed token, bool allowed);

    /// @notice Emitted once per successful execution. `executionPlanHash`
    /// is indexed so an off-chain settlement/verification pass can look up
    /// exactly which compiled graph produced this transaction.
    event ExecutionCompleted(
        bytes32 indexed bagId,
        bytes32 indexed executionPlanHash,
        address indexed wallet,
        address inputToken,
        uint256 inputAmount,
        uint256 legCount
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _bagFactory, address _owner, address _planSigner) EIP712('BagExecutionRouter', '1') {
        if (_bagFactory == address(0) || _owner == address(0) || _planSigner == address(0)) revert ZeroAddress();
        bagFactory = IBagFactory(_bagFactory);
        owner = _owner;
        planSigner = _planSigner;
    }

    // ---------------------------------------------------------------
    // Admin — allowlists and key rotation. None of these can move funds.
    // ---------------------------------------------------------------

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function setPlanSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit PlanSignerUpdated(planSigner, newSigner);
        planSigner = newSigner;
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        isAllowedTarget[target] = allowed;
        emit TargetAllowlistUpdated(target, allowed);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isAllowedToken[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }

    // ---------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------

    /// @notice Executes one signed compiled plan atomically.
    ///
    /// Ordering is deliberate — every cheap authorization/validity check
    /// happens BEFORE a single token moves, so a rejected plan costs the
    /// user nothing but gas:
    ///   1. deadline, replay, signature, wallet, Bag registration
    ///   2. allowlist + target-is-not-a-token checks for every leg
    ///   3. balance snapshot, pull input
    ///   4. legs, each with an exact approval that is revoked immediately
    ///   5. delta-based output verification
    ///   6. sweep this transaction's outputs, unspent input and unspent
    ///      native value back to `msg.sender`
    ///
    /// Reverts entirely on any failure — there is no partial-success path
    /// and nothing is ever left custodied here between transactions.
    function execute(ExecutionPlan calldata plan, bytes calldata planSignature)
        external
        payable
        nonReentrant
        returns (uint256[] memory outputAmounts)
    {
        // --- 1. Authorization / validity, before any value moves -----
        if (block.timestamp > plan.deadline) revert PlanExpired(plan.deadline, block.timestamp);
        if (plan.wallet != msg.sender) revert WalletMismatch(plan.wallet, msg.sender);
        if (plan.legs.length == 0) revert NoLegs();
        if (plan.inputAmount == 0) revert ZeroInputAmount();
        // Every plan must promise the caller something back, and every
        // promise must be a real floor. An empty `minOutputs` (or a 0
        // floor) would let a signed plan spend the whole input while the
        // output check trivially passes — and, since only declared tokens
        // are swept, leave whatever the legs produced stuck here.
        // (Per-entry 0 floors are rejected in `_snapshotBalances`.)
        if (plan.minOutputs.length == 0) revert NoOutputChecks();

        bytes32 digest = _hashTypedDataV4(_hashPlan(plan));
        if (executedPlans[digest]) revert PlanAlreadyExecuted(digest);
        // Marked BEFORE any external call — `nonReentrant` already blocks
        // re-entry into this function, but setting it here also makes the
        // plan single-use across separate transactions in the same block.
        executedPlans[digest] = true;

        if (ECDSA.recover(digest, planSignature) != planSigner) revert InvalidPlanSignature();

        // The Bag must be a real, factory-deployed Bag. This is the whole
        // reason `bagFactory` is a trusted dependency: it is what stops a
        // plan referencing a bagId that never existed.
        if (bagFactory.bagOf(plan.bagId) == address(0)) revert UnknownBag(plan.bagId);

        if (!isAllowedToken[plan.inputToken]) revert TokenNotAllowed(plan.inputToken);

        uint256 requiredValue;
        for (uint256 i = 0; i < plan.legs.length; i++) {
            _assertLegTargetSafe(plan.legs[i]);
            requiredValue += plan.legs[i].value;
        }
        // Native value is checked against the signed total so a plan can
        // never silently consume ETH the user didn't intend to spend, and
        // so leftover ETH can't accumulate in the router.
        if (msg.value != requiredValue) revert NativeValueMismatch(msg.value, requiredValue);

        // --- 2. Snapshot BEFORE pulling input ------------------------
        // Deltas, not absolute balances. This is what makes "unauthorized
        // asset injection" a non-issue: someone transferring tokens to
        // this router (or dust left by an earlier caller) cannot help a
        // plan clear its `minAmountOut`, because only the change caused by
        // THIS transaction's legs is ever counted.
        uint256[] memory before = _snapshotBalances(plan.minOutputs, plan.inputToken);
        // Same rule for the input token and native value: only what THIS
        // transaction left behind is refunded, never a stranger's dust.
        uint256[2] memory leftoverBase = [
            IERC20(plan.inputToken).balanceOf(address(this)),
            address(this).balance - msg.value
        ];

        IERC20(plan.inputToken).safeTransferFrom(msg.sender, address(this), plan.inputAmount);

        // --- 3. Legs -------------------------------------------------
        for (uint256 i = 0; i < plan.legs.length; i++) {
            Leg calldata leg = plan.legs[i];

            if (leg.approveToken != address(0) && leg.approveAmount > 0) {
                IERC20(leg.approveToken).forceApprove(leg.target, leg.approveAmount);
            }

            (bool ok, bytes memory ret) = leg.target.call{value: leg.value}(leg.callData);
            if (!ok) _bubbleRevert(ret, i);

            // Revoked unconditionally after every leg, whether or not the
            // target consumed it — a surviving allowance is a standing
            // right to pull this router's funds later (item 5: approval
            // leakage), so none is ever left behind.
            if (leg.approveToken != address(0) && leg.approveAmount > 0) {
                IERC20(leg.approveToken).forceApprove(leg.target, 0);
            }
        }

        // --- 4. Output verification (delta-based) --------------------
        outputAmounts = new uint256[](plan.minOutputs.length);
        for (uint256 i = 0; i < plan.minOutputs.length; i++) {
            OutputCheck calldata check = plan.minOutputs[i];
            uint256 nowBal = IERC20(check.token).balanceOf(address(this));
            uint256 gained = nowBal > before[i] ? nowBal - before[i] : 0;
            if (gained < check.minAmountOut) revert InsufficientOutput(check.token, gained, check.minAmountOut);
            outputAmounts[i] = gained;
        }

        // --- 5. Sweep everything back to the caller ------------------
        // Only what this transaction produced (`gained`) is sent, so a
        // concurrent donation to the router is never silently paid out to
        // whoever happens to execute next.
        //
        // NOTE: this sweeps exactly the tokens the SIGNED plan declared in
        // `minOutputs`, because a contract cannot enumerate which ERC-20s
        // it holds. An output token a plan never declared would therefore
        // remain here rather than reaching the caller. That is the
        // deliberate trade-off against the alternative — sweeping whatever
        // balance happens to be present — which would hand donated/dust
        // tokens to an arbitrary caller and reintroduce exactly the
        // injection problem the delta accounting above exists to prevent.
        // BAG's own provider always populates `minOutputs` from every
        // leg's target asset (lib/execution/providers/bag-router-provider.ts),
        // and both behaviours are pinned by tests.
        for (uint256 i = 0; i < plan.minOutputs.length; i++) {
            if (outputAmounts[i] > 0) {
                IERC20(plan.minOutputs[i].token).safeTransfer(msg.sender, outputAmounts[i]);
            }
        }

        _refundLeftovers(plan.inputToken, leftoverBase[0], leftoverBase[1]);

        emit ExecutionCompleted(
            plan.bagId,
            plan.executionPlanHash,
            msg.sender,
            plan.inputToken,
            plan.inputAmount,
            plan.legs.length
        );
    }

    // ---------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------

    /// @dev The single most important check in this contract. A leg target
    /// must be allowlisted AND must not be a token this router ever holds
    /// or approves.
    ///
    /// Without the second half, an allowlisted-target plan could set
    /// `target` to an ERC-20 and `callData` to
    /// `transferFrom(otherUser, attacker, amount)` — spending any allowance
    /// another user had granted this router — or `transfer(attacker, ...)`
    /// to drain the router's own mid-execution balance. `BagRouterSpike`
    /// has exactly this hole. Tokens and call targets are kept in two
    /// separate allowlists precisely so they can never overlap.
    function _assertLegTargetSafe(Leg calldata leg) private view {
        if (leg.target == address(0)) revert TargetNotAllowed(leg.target);
        if (!isAllowedTarget[leg.target]) revert TargetNotAllowed(leg.target);
        if (isAllowedToken[leg.target]) revert TargetIsToken(leg.target);
        // Self-calls would let a plan re-enter admin functions with
        // `msg.sender == address(this)`; not currently exploitable (admin
        // is `owner`-gated) but closed anyway rather than relying on that.
        if (leg.target == address(this)) revert TargetNotAllowed(leg.target);
        if (leg.target == address(bagFactory)) revert TargetNotAllowed(leg.target);
        if (leg.approveToken != address(0) && !isAllowedToken[leg.approveToken]) {
            revert TokenNotAllowed(leg.approveToken);
        }
    }

    /// @dev Records pre-execution balances for every declared output token,
    /// rejecting duplicates (a token listed twice would be counted, and
    /// paid out, twice).
    function _snapshotBalances(OutputCheck[] calldata checks, address inputToken)
        private
        view
        returns (uint256[] memory balances)
    {
        balances = new uint256[](checks.length);
        for (uint256 i = 0; i < checks.length; i++) {
            address token = checks[i].token;
            if (!isAllowedToken[token]) revert TokenNotAllowed(token);
            // The snapshot is taken before the input is pulled, so an output
            // check on the input token would count the user's own deposit
            // as "produced" output. BAG plans never swap into the input
            // asset (that allocation is KEPT, not routed).
            if (token == inputToken) revert OutputIsInputToken(token);
            if (checks[i].minAmountOut == 0) revert ZeroMinOutput(token);
            for (uint256 j = 0; j < i; j++) {
                if (checks[j].token == token) revert DuplicateOutputCheck(token);
            }
            balances[i] = IERC20(token).balanceOf(address(this));
        }
    }

    /// @dev Returns unspent input and native value (anything above the
    /// pre-execution baseline) to the caller. Native value a leg did not
    /// spend, or refunded mid-execution, never accumulates here.
    function _refundLeftovers(address inputToken, uint256 inputBefore, uint256 nativeBefore) private {
        uint256 inputNow = IERC20(inputToken).balanceOf(address(this));
        if (inputNow > inputBefore) {
            IERC20(inputToken).safeTransfer(msg.sender, inputNow - inputBefore);
        }
        uint256 nativeNow = address(this).balance;
        if (nativeNow > nativeBefore) {
            (bool refunded, ) = msg.sender.call{value: nativeNow - nativeBefore}('');
            if (!refunded) revert NativeRefundFailed();
        }
    }

    function _hashPlan(ExecutionPlan calldata plan) private pure returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](plan.legs.length);
        for (uint256 i = 0; i < plan.legs.length; i++) {
            Leg calldata leg = plan.legs[i];
            legHashes[i] = keccak256(
                abi.encode(
                    LEG_TYPEHASH,
                    leg.target,
                    keccak256(leg.callData),
                    leg.value,
                    leg.approveToken,
                    leg.approveAmount
                )
            );
        }
        bytes32[] memory outputHashes = new bytes32[](plan.minOutputs.length);
        for (uint256 i = 0; i < plan.minOutputs.length; i++) {
            outputHashes[i] = keccak256(
                abi.encode(OUTPUT_CHECK_TYPEHASH, plan.minOutputs[i].token, plan.minOutputs[i].minAmountOut)
            );
        }
        return
            keccak256(
                abi.encode(
                    EXECUTION_PLAN_TYPEHASH,
                    plan.bagId,
                    plan.executionPlanHash,
                    plan.wallet,
                    plan.inputToken,
                    plan.inputAmount,
                    plan.deadline,
                    keccak256(abi.encodePacked(legHashes)),
                    keccak256(abi.encodePacked(outputHashes))
                )
            );
    }

    function _bubbleRevert(bytes memory returnData, uint256 legIndex) private pure {
        if (returnData.length > 0) {
            assembly {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }
        revert LegCallFailed(legIndex);
    }

    /// @notice Accepts native refunds from legs mid-execution. Deliberately
    /// no `withdraw`/`sweep` admin function exists: `owner` must never have
    /// a path to move assets out of this contract (trust boundary #2).
    receive() external payable {}
}
