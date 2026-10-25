// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {IERC20Permit} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {SignatureChecker} from '@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol';
import {BagExecutionRouter} from '../BagExecutionRouter.sol';
import {IRecurringPurchaseExecution} from './IRecurringPurchaseExecution.sol';

interface IBagFactoryRegistry {
    function bagOf(bytes32 bagId) external view returns (address);
}

interface IBagVersioned {
    function version() external view returns (uint256);
    function compositionHash() external view returns (bytes32);
}

interface IStrategyRegistryMatcher {
    function matches(bytes32 strategyId, uint32 version, bytes32 definitionHash) external view returns (bool);
}

interface IDelegationManagerRedeem {
    function redeemDelegations(bytes[] calldata permissionContexts, bytes32[] calldata modes, bytes[] calldata executionCallDatas) external;
}

/// @title RecurringPurchaseExecutor
/// @notice Executes owner-signed, bounded recurring BAG purchases through the
/// existing BagExecutionRouter. See IRecurringPurchaseExecution for the model.
///
/// TRUST BOUNDARY. No owner, no admin, no upgrade, no fee, no pause; the only
/// state is the per-(owner, authorizationId) counter. User funds move only in
/// `execute`, only from the signed source account, only by the signed per-run
/// amount, and only through the signed router and swap target. The router's
/// `planSigner` proposes calldata and minimums; this contract re-checks the
/// plan against the signed authorization BEFORE the call and the measured
/// balances AFTER it, so no planSigner, router owner or keeper can buy another
/// BAG, pay another recipient, spend more or more often, or accept a worse
/// price than the owner signed.
///
/// What it does NOT prove: that the owner's price limits are good prices
/// (they are the owner's own choice, shown before signing), or that the
/// router/Uniswap/token contracts are honest (they are trusted dependencies,
/// pinned per authorization). In ALLOWANCE mode the remaining allowance is a
/// standing right of THIS contract; revocation stops purchases even if an
/// allowance or an unused permit remains (see test V-A3/V-A4).
contract RecurringPurchaseExecutor is IRecurringPurchaseExecution, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant BAG_REF_TYPEHASH =
        keccak256('BagRef(bytes32 bagId,uint256 bagVersion,bytes32 compositionHash,bytes32 definitionHash,bytes32 strategyId,uint32 strategyVersion)');
    bytes32 public constant ASSET_LIMIT_TYPEHASH = keccak256('AssetLimit(address asset,uint16 weightBps,uint8 decimals,uint256 maxPriceRaw)');
    bytes32 public constant SCHEDULE_TYPEHASH =
        keccak256('Schedule(uint256 grossAmountPerRun,uint256 totalBudget,uint32 maxExecutions,uint64 startsAt,uint64 periodSeconds,uint64 expiresAt)');
    bytes32 public constant ROUTE_TYPEHASH = keccak256('Route(address router,address swapTarget,uint24[] allowedFees)');
    bytes32 public constant AUTHORIZATION_TYPEHASH =
        keccak256(
            'Authorization(address owner,address sourceAccount,address recipient,uint8 fundingKind,address fundingContract,address inputToken,BagRef bag,AssetLimit[] assets,Schedule schedule,Route route,uint256 nonce)'
            'AssetLimit(address asset,uint16 weightBps,uint8 decimals,uint256 maxPriceRaw)'
            'BagRef(bytes32 bagId,uint256 bagVersion,bytes32 compositionHash,bytes32 definitionHash,bytes32 strategyId,uint32 strategyVersion)'
            'Route(address router,address swapTarget,uint24[] allowedFees)'
            'Schedule(uint256 grossAmountPerRun,uint256 totalBudget,uint32 maxExecutions,uint64 startsAt,uint64 periodSeconds,uint64 expiresAt)'
        );
    bytes32 public constant REVOCATION_TYPEHASH = keccak256('Revocation(address owner,bytes32 authorizationId)');

    /// @dev SwapRouter02 `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`.
    bytes4 public constant EXACT_INPUT_SINGLE = 0x04e45aaf;
    uint256 private constant EXACT_INPUT_SINGLE_LENGTH = 4 + 7 * 32;
    uint256 public constant MAX_ASSETS = 10;
    uint256 private constant TOTAL_BPS = 10_000;

    IBagFactoryRegistry public immutable bagFactory;
    /// @notice May be the zero address; then an authorization must not name a strategyId.
    IStrategyRegistryMatcher public immutable strategyRegistry;

    mapping(address owner => mapping(bytes32 authorizationId => ExecutionState)) private _state;

    error ZeroAddress();
    error AuthorizationMismatch(bytes32 expected, bytes32 given);
    error InvalidOwnerSignature();
    error RevokedAuthorization(bytes32 authorizationId);
    error InvalidTerms(uint256 code);
    error UnknownBag(bytes32 bagId);
    error BagChanged(uint256 version, bytes32 compositionHash);
    error StrategyNotRegistered(bytes32 strategyId, uint32 version);
    error AssetDecimalsMismatch(address asset, uint8 signed, uint8 actual);
    error NotDue();
    error Expired();
    error QuoteExpired(uint256 deadline);
    error WrongWindow(uint256 current, uint256 planned);
    error Exhausted();
    error BudgetExceeded();
    error PlanMismatch(uint256 code);
    error RouteViolation(uint256 leg, uint256 code);
    error FundingMismatch();
    error InputNotFullySpent(uint256 refunded);
    error OutputBelowLimit(address asset, uint256 received, uint256 minimum);
    error DeliveryMismatch(address asset);

    constructor(address bagFactory_, address strategyRegistry_) EIP712('BagRecurringPurchase', '1') {
        if (bagFactory_ == address(0)) revert ZeroAddress();
        bagFactory = IBagFactoryRegistry(bagFactory_);
        strategyRegistry = IStrategyRegistryMatcher(strategyRegistry_);
    }

    // ---------------------------------------------------------------- execute

    function execute(
        Authorization calldata a,
        PurchaseExecution calldata x,
        bytes calldata ownerSignature,
        bytes calldata fundingProof
    ) external nonReentrant returns (uint256 executionIndex) {
        bytes32 id = _verify(a, x, ownerSignature);
        uint256 window = _reserve(_state[a.owner][id], a.schedule, x);
        executionIndex = _state[a.owner][id].executions;
        _purchase(a, x, fundingProof);
        _emitExecuted(a, id, x, window, executionIndex);
    }

    /// @dev Identity, signature, revocation, static terms and BAG registry.
    function _verify(Authorization calldata a, PurchaseExecution calldata x, bytes calldata ownerSignature) private view returns (bytes32 id) {
        id = _authorizationId(a);
        if (x.authorizationId != id) revert AuthorizationMismatch(id, x.authorizationId);
        if (!SignatureChecker.isValidSignatureNow(a.owner, id, ownerSignature)) revert InvalidOwnerSignature();
        if (_state[a.owner][id].revoked) revert RevokedAuthorization(id);
        _checkTerms(a);
        _checkRegistry(a.bag);
    }

    function _purchase(Authorization calldata a, PurchaseExecution calldata x, bytes calldata fundingProof) private {
        uint256[] memory legIn = _legAmounts(a.schedule.grossAmountPerRun, a.assets);
        uint256[] memory minOut = _minimumOutputs(legIn, a.assets);
        _checkPlan(a, x.plan, legIn, minOut);
        uint256 inputBase = _fund(a, fundingProof);
        _swapAndDeliver(a, x, minOut, inputBase);
    }

    function _emitExecuted(Authorization calldata a, bytes32 id, PurchaseExecution calldata x, uint256 window, uint256 index) private {
        uint256 gross = a.schedule.grossAmountPerRun;
        emit PurchaseExecuted(a.owner, id, keccak256(abi.encode(x.plan)), window, index, gross, gross);
    }

    // ---------------------------------------------------------------- revoke

    /// @notice Revokes in the CALLER's namespace: nobody can revoke someone else's plan.
    /// Works for an authorization that never ran. Does not touch token allowances.
    function revoke(bytes32 authorizationId) external {
        _revoke(msg.sender, authorizationId);
    }

    /// @notice Gasless revocation: anyone may submit the owner's signed `Revocation`.
    function revokeBySig(address owner, bytes32 authorizationId, bytes calldata signature) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REVOCATION_TYPEHASH, owner, authorizationId)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert InvalidOwnerSignature();
        _revoke(owner, authorizationId);
    }

    function _revoke(address owner, bytes32 authorizationId) private {
        _state[owner][authorizationId].revoked = true;
        emit AuthorizationRevoked(owner, authorizationId);
    }

    // ---------------------------------------------------------------- views

    function getState(address owner, bytes32 authorizationId) external view returns (ExecutionState memory) {
        return _state[owner][authorizationId];
    }

    function authorizationIdOf(Authorization calldata a) external view returns (bytes32) {
        return _authorizationId(a);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The exact per-asset input split (bag.json v1 largest-remainder rule, the SDK's `splitByWeight`).
    function legAmounts(uint256 amount, AssetLimit[] calldata assets) external pure returns (uint256[] memory) {
        return _legAmounts(amount, assets);
    }

    /// @notice Minimum output per asset implied by the signed price limits for one run.
    function minimumOutputs(uint256 amount, AssetLimit[] calldata assets) external view returns (uint256[] memory) {
        return _minimumOutputs(_legAmounts(amount, assets), assets);
    }

    // ---------------------------------------------------------------- hashing

    function _authorizationId(Authorization calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(_hashAuthorization(a));
    }

    function _hashAuthorization(Authorization calldata a) private pure returns (bytes32) {
        bytes32[] memory assetHashes = new bytes32[](a.assets.length);
        for (uint256 i = 0; i < a.assets.length; i++) {
            AssetLimit calldata l = a.assets[i];
            assetHashes[i] = keccak256(abi.encode(ASSET_LIMIT_TYPEHASH, l.asset, l.weightBps, l.decimals, l.maxPriceRaw));
        }
        bytes32[4] memory parts = [
            keccak256(abi.encode(BAG_REF_TYPEHASH, a.bag)),
            keccak256(abi.encodePacked(assetHashes)),
            keccak256(abi.encode(SCHEDULE_TYPEHASH, a.schedule)),
            keccak256(abi.encode(ROUTE_TYPEHASH, a.route.router, a.route.swapTarget, keccak256(abi.encodePacked(a.route.allowedFees))))
        ];
        return
            keccak256(
                abi.encode(
                    AUTHORIZATION_TYPEHASH,
                    a.owner,
                    a.sourceAccount,
                    a.recipient,
                    a.fundingKind,
                    a.fundingContract,
                    a.inputToken,
                    parts[0],
                    parts[1],
                    parts[2],
                    parts[3],
                    a.nonce
                )
            );
    }

    // ---------------------------------------------------------------- checks

    /// @dev Static validity of the signed terms. Codes: 1 owner/source, 2 recipient,
    /// 3 funding, 4 schedule, 5 budget, 6 asset count, 7 asset, 8 weights, 9 price
    /// limit, 10 duplicate asset, 11 route, 12 fee tier.
    function _checkTerms(Authorization calldata a) private view {
        if (a.owner == address(0) || a.sourceAccount != a.owner) revert InvalidTerms(1);
        if (a.recipient == address(0) || a.recipient == address(this)) revert InvalidTerms(2);
        if (a.inputToken == address(0)) revert InvalidTerms(3);
        if (a.fundingKind == uint8(FundingKind.ALLOWANCE)) {
            if (a.fundingContract != a.inputToken) revert InvalidTerms(3);
        } else if (a.fundingKind == uint8(FundingKind.DELEGATION)) {
            if (a.fundingContract == address(0)) revert InvalidTerms(3);
        } else {
            revert InvalidTerms(3);
        }
        Schedule calldata s = a.schedule;
        if (s.grossAmountPerRun == 0 || s.periodSeconds == 0 || s.maxExecutions == 0 || s.expiresAt <= s.startsAt) revert InvalidTerms(4);
        if (s.totalBudget != s.grossAmountPerRun * s.maxExecutions) revert InvalidTerms(5);

        uint256 n = a.assets.length;
        if (n == 0 || n > MAX_ASSETS) revert InvalidTerms(6);
        uint256 weights;
        for (uint256 i = 0; i < n; i++) {
            AssetLimit calldata l = a.assets[i];
            if (l.asset == address(0) || l.asset == a.inputToken || l.asset == a.route.swapTarget || l.asset == a.route.router) revert InvalidTerms(7);
            if (l.weightBps == 0) revert InvalidTerms(8);
            if (l.maxPriceRaw == 0 || l.maxPriceRaw == type(uint256).max) revert InvalidTerms(9);
            for (uint256 j = 0; j < i; j++) if (a.assets[j].asset == l.asset) revert InvalidTerms(10);
            weights += l.weightBps;
        }
        if (weights != TOTAL_BPS) revert InvalidTerms(8);

        Route calldata r = a.route;
        if (r.router == address(0) || r.swapTarget == address(0) || r.swapTarget == a.inputToken || r.router == a.inputToken) revert InvalidTerms(11);
        if (r.allowedFees.length == 0) revert InvalidTerms(12);
        for (uint256 i = 0; i < r.allowedFees.length; i++) {
            uint24 f = r.allowedFees[i];
            if (f != 100 && f != 500 && f != 3000 && f != 10000) revert InvalidTerms(12);
        }
    }

    function _checkRegistry(BagRef calldata b) private view {
        if (b.definitionHash == bytes32(0) || b.compositionHash == bytes32(0)) revert InvalidTerms(13);
        address bag = bagFactory.bagOf(b.bagId);
        if (bag == address(0)) revert UnknownBag(b.bagId);
        uint256 version = IBagVersioned(bag).version();
        bytes32 composition = IBagVersioned(bag).compositionHash();
        if (version != b.bagVersion || composition != b.compositionHash) revert BagChanged(version, composition);
        if (b.strategyId != bytes32(0)) {
            if (address(strategyRegistry) == address(0) || !strategyRegistry.matches(b.strategyId, b.strategyVersion, b.definitionHash)) {
                revert StrategyNotRegistered(b.strategyId, b.strategyVersion);
            }
        }
    }

    /// @dev Calendar window, run count and budget; the counters are updated here, before
    /// any external call, and roll back with the whole transaction on any later failure.
    function _reserve(ExecutionState storage st, Schedule calldata s, PurchaseExecution calldata x) private returns (uint256 window) {
        uint256 t = block.timestamp;
        if (t < s.startsAt) revert NotDue();
        if (t >= s.expiresAt) revert Expired();
        if (t > x.quoteDeadline) revert QuoteExpired(x.quoteDeadline);
        window = (t - s.startsAt) / s.periodSeconds;
        if (window != x.window) revert WrongWindow(window, x.window);
        if (st.executions != 0 && (window <= st.lastWindow || t < uint256(st.lastExecutionAt) + s.periodSeconds)) revert NotDue();
        if (st.executions >= s.maxExecutions) revert Exhausted();
        if (st.grossUsed + s.grossAmountPerRun > s.totalBudget) revert BudgetExceeded();
        st.executions += 1;
        st.grossUsed += s.grossAmountPerRun;
        st.lastWindow = uint64(window);
        st.lastExecutionAt = uint64(t);
    }

    /// @dev bag.json v1 normative split (packages/bag-sdk/src/split.ts): floor each share,
    /// then one unit each to the largest remainders, ties by address ascending.
    function _legAmounts(uint256 amount, AssetLimit[] calldata assets) private pure returns (uint256[] memory parts) {
        uint256 n = assets.length;
        parts = new uint256[](n);
        uint256[] memory rem = new uint256[](n);
        uint256 sum;
        uint256 weights;
        for (uint256 i = 0; i < n; i++) weights += assets[i].weightBps;
        if (n == 0 || weights != TOTAL_BPS) revert InvalidTerms(8);
        for (uint256 i = 0; i < n; i++) {
            uint256 num = amount * assets[i].weightBps;
            parts[i] = num / TOTAL_BPS;
            rem[i] = num % TOTAL_BPS;
            sum += parts[i];
        }
        uint256 leftover = amount - sum;
        bool[] memory taken = new bool[](n);
        while (leftover > 0) {
            uint256 best = type(uint256).max;
            for (uint256 i = 0; i < n; i++) {
                if (taken[i]) continue;
                if (
                    best == type(uint256).max ||
                    rem[i] > rem[best] ||
                    (rem[i] == rem[best] && uint160(assets[i].asset) < uint160(assets[best].asset))
                ) best = i;
            }
            parts[best] += 1;
            taken[best] = true;
            leftover -= 1;
        }
    }

    function _minimumOutputs(uint256[] memory legIn, AssetLimit[] calldata assets) private view returns (uint256[] memory minOut) {
        minOut = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            AssetLimit calldata l = assets[i];
            uint8 actual = IERC20Metadata(l.asset).decimals();
            if (actual != l.decimals) revert AssetDecimalsMismatch(l.asset, l.decimals, actual);
            if (l.maxPriceRaw == 0 || l.maxPriceRaw == type(uint256).max) revert InvalidTerms(9);
            uint256 num = legIn[i] * (10 ** uint256(l.decimals));
            // ceil without overflow; num > 0 because every leg gets a positive share of a positive amount
            minOut[i] = num == 0 ? 0 : (num - 1) / l.maxPriceRaw + 1;
            if (minOut[i] == 0) revert InvalidTerms(9);
        }
    }

    /// @dev The router plan must be exactly the signed purchase: this executor as wallet,
    /// the signed BAG, input token and amount, one SwapRouter02 exactInputSingle leg per
    /// asset in signed order with the exact split amount, output to the router, an
    /// allowed fee tier, no price limit, and router-side minimums no lower than the
    /// owner's price limits.
    function _checkPlan(
        Authorization calldata a,
        BagExecutionRouter.ExecutionPlan calldata plan,
        uint256[] memory legIn,
        uint256[] memory minOut
    ) private view {
        if (plan.wallet != address(this)) revert PlanMismatch(1);
        if (plan.inputToken != a.inputToken) revert PlanMismatch(2);
        if (plan.inputAmount != a.schedule.grossAmountPerRun) revert PlanMismatch(3);
        if (plan.bagId != a.bag.bagId) revert PlanMismatch(4);
        uint256 n = a.assets.length;
        if (plan.legs.length != n || plan.minOutputs.length != n) revert PlanMismatch(5);
        for (uint256 i = 0; i < n; i++) {
            BagExecutionRouter.Leg calldata leg = plan.legs[i];
            if (leg.target != a.route.swapTarget) revert RouteViolation(i, 1);
            if (leg.value != 0) revert RouteViolation(i, 2);
            if (leg.approveToken != a.inputToken || leg.approveAmount != legIn[i]) revert RouteViolation(i, 3);
            _checkSwapCall(leg.callData, a, i, legIn[i]);
            if (plan.minOutputs[i].token != a.assets[i].asset) revert RouteViolation(i, 10);
            if (plan.minOutputs[i].minAmountOut < minOut[i]) revert RouteViolation(i, 11);
        }
    }

    function _checkSwapCall(bytes calldata data, Authorization calldata a, uint256 i, uint256 amountIn) private pure {
        if (data.length != EXACT_INPUT_SINGLE_LENGTH || bytes4(data[:4]) != EXACT_INPUT_SINGLE) revert RouteViolation(i, 4);
        (address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 legAmount, , uint160 priceLimit) = abi.decode(
            data[4:],
            (address, address, uint24, address, uint256, uint256, uint160)
        );
        if (tokenIn != a.inputToken || tokenOut != a.assets[i].asset) revert RouteViolation(i, 5);
        if (recipient != a.route.router) revert RouteViolation(i, 6);
        if (legAmount != amountIn) revert RouteViolation(i, 7);
        if (priceLimit != 0) revert RouteViolation(i, 8);
        bool allowed;
        for (uint256 k = 0; k < a.route.allowedFees.length; k++) if (a.route.allowedFees[k] == fee) allowed = true;
        if (!allowed) revert RouteViolation(i, 9);
    }

    // ---------------------------------------------------------------- funding and delivery

    /// @return inputBase this contract's input balance before funding.
    function _fund(Authorization calldata a, bytes calldata fundingProof) private returns (uint256 inputBase) {
        IERC20 token = IERC20(a.inputToken);
        uint256 gross = a.schedule.grossAmountPerRun;
        uint256 sourceBefore = token.balanceOf(a.sourceAccount);
        inputBase = token.balanceOf(address(this));
        if (a.fundingKind == uint8(FundingKind.ALLOWANCE)) {
            if (fundingProof.length != 0) {
                // An optional EIP-2612 permit for THIS contract. Front-running it only
                // consumes the nonce; the allowance check below decides.
                (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) = abi.decode(fundingProof, (uint256, uint256, uint8, bytes32, bytes32));
                try IERC20Permit(a.inputToken).permit(a.sourceAccount, address(this), value, deadline, v, r, s) {} catch {}
            }
            token.safeTransferFrom(a.sourceAccount, address(this), gross);
        } else {
            bytes[] memory contexts = new bytes[](1);
            contexts[0] = abi.decode(fundingProof, (bytes));
            bytes32[] memory modes = new bytes32[](1);
            bytes[] memory calls = new bytes[](1);
            calls[0] = abi.encodePacked(a.inputToken, uint256(0), abi.encodeCall(IERC20.transfer, (address(this), gross)));
            IDelegationManagerRedeem(a.fundingContract).redeemDelegations(contexts, modes, calls);
        }
        uint256 sourceAfter = token.balanceOf(a.sourceAccount);
        uint256 selfAfter = token.balanceOf(address(this));
        if (sourceAfter > sourceBefore || sourceBefore - sourceAfter != gross || selfAfter < inputBase || selfAfter - inputBase != gross) revert FundingMismatch();
    }

    function _swapAndDeliver(Authorization calldata a, PurchaseExecution calldata x, uint256[] memory minOut, uint256 inputBase) private {
        IERC20 token = IERC20(a.inputToken);
        uint256 n = a.assets.length;
        uint256[] memory before = new uint256[](n);
        for (uint256 i = 0; i < n; i++) before[i] = IERC20(a.assets[i].asset).balanceOf(address(this));

        token.forceApprove(a.route.router, a.schedule.grossAmountPerRun);
        BagExecutionRouter(payable(a.route.router)).execute(x.plan, x.planSignature);
        token.forceApprove(a.route.router, 0);
        uint256 inputNow = token.balanceOf(address(this));
        if (inputNow != inputBase) revert InputNotFullySpent(inputNow > inputBase ? inputNow - inputBase : 0);

        for (uint256 i = 0; i < n; i++) {
            IERC20 out = IERC20(a.assets[i].asset);
            uint256 gained = out.balanceOf(address(this)) - before[i];
            if (gained < minOut[i]) revert OutputBelowLimit(address(out), gained, minOut[i]);
            uint256 recipientBefore = out.balanceOf(a.recipient);
            out.safeTransfer(a.recipient, gained);
            if (out.balanceOf(a.recipient) - recipientBefore < minOut[i] || out.balanceOf(address(this)) != before[i]) revert DeliveryMismatch(address(out));
        }
    }
}
