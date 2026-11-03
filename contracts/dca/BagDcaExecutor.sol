// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {SignatureChecker} from '@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol';
import {ShortString, ShortStrings} from '@openzeppelin/contracts/utils/ShortStrings.sol';
import {Strings} from '@openzeppelin/contracts/utils/Strings.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {IDcaSwapAdapter} from './IDcaSwapAdapter.sol';

interface IDcaBagFactory {
    function bagOf(bytes32 bagId) external view returns (address);
}

interface IDcaBag {
    function version() external view returns (uint256);

    function compositionHash() external view returns (bytes32);
}

interface IDcaStrategyRegistry {
    function matches(bytes32 strategyId, uint32 version, bytes32 definitionHash) external view returns (bool);
}

/// @title BagDcaExecutor
/// @notice Non-custodial automated DCA into one BAG. The owner signs ONE EIP-712
/// `DcaAuthorization` and approves this contract for at most the total budget
/// of the input token; the funds stay in the owner's wallet. On each run a
/// keeper (anyone) calls `execute`; this contract re-checks every signed limit
/// on chain, pulls exactly one run's amount, buys every asset of the BAG
/// through the pinned typed adapter and delivers each one straight to the
/// signed recipient, with one `AssetDelivered` event per asset.
///
/// TRUST BOUNDARY. No owner, admin, pause, upgrade or fee. The only state is
/// the per-(owner, authorizationId) counter. A keeper chooses only WHEN to call
/// (inside the signed calendar), the fee tier of each leg (from the signed
/// list) and, optionally, a HIGHER minimum per asset; it cannot choose the
/// BAG, the assets, the amounts, the recipient, the venue or a lower minimum.
///
/// The per-asset price limit (`maxPriceRaw`) is a CEILING the owner accepts,
/// not a fair price: a keeper (or anyone it colludes with) can execute at any
/// price up to that ceiling. If any asset cannot be bought within its ceiling
/// the whole run reverts; nothing moves and the window is not consumed. A
/// window that closes without a run is never made up (no catch-up).
///
/// Not proven here: that the ceilings are good prices, or that Uniswap, the
/// tokens or the BAG registry contracts are honest. They are pinned
/// dependencies; see docs/dca/DCA_V1_TYPED_ADAPTER.md.
contract BagDcaExecutor is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct BagRef {
        bytes32 bagId;
        uint256 bagVersion;
        bytes32 compositionHash;
        bytes32 definitionHash;
        bytes32 strategyId;
        uint32 strategyVersion;
    }

    /// @notice One asset of the BAG (its REGISTERED row: the list must rebuild the Bag's
    /// `compositionHash`) and the most the owner pays for one whole token, in input-token
    /// raw units. Minimum output of a leg = ceil(legInput × 10^decimals / maxPriceRaw).
    struct AssetLimit {
        address asset;
        string symbol;
        uint16 weightBps;
        uint8 decimals;
        uint256 maxPriceRaw;
    }

    /// @notice Window k = [startsAt + k·period, startsAt + (k+1)·period). At most one run
    /// per window and at least `periodSeconds` between runs. Missed windows are lost.
    struct Schedule {
        uint256 amountPerRun;
        uint256 totalBudget;
        uint32 maxRuns;
        uint64 startsAt;
        uint64 periodSeconds;
        uint64 expiresAt;
    }

    /// @notice The adapter and the venue it calls, both signed so the wallet shows them.
    struct Route {
        address adapter;
        address swapRouter;
        uint24[] allowedFees;
    }

    /// @notice `allowedCaller`: when non-zero, only this address may call `execute` for the
    /// authorization (the owner's chosen keeper). Zero means anyone may execute; then any
    /// caller can pick the moment and pass no keeper floor, so a run can be pushed to any
    /// price up to the ceilings (e.g. by moving the pool in the same transaction).
    struct DcaAuthorization {
        address owner;
        address recipient;
        address inputToken;
        address allowedCaller;
        BagRef bag;
        AssetLimit[] assets;
        Schedule schedule;
        Route route;
        uint256 nonce;
    }

    /// @notice What the keeper supplies per run. `window` is the window it planned for
    /// (a transaction landing in another window reverts), `fees[i]` the fee tier of leg i
    /// (one of the signed `allowedFees`), `minOutFloors` empty or one value per asset: a
    /// keeper-side minimum used only when it is ABOVE the owner's ceiling-derived minimum.
    struct RunParams {
        bytes32 authorizationId;
        uint64 window;
        uint64 deadline;
        uint24[] fees;
        uint256[] minOutFloors;
    }

    struct RunState {
        uint32 runs;
        uint256 spent;
        uint64 lastWindow;
        uint64 lastRunAt;
        bool revoked;
    }

    // ------------------------------------------------------------- constants

    bytes32 public constant BAG_REF_TYPEHASH =
        keccak256('BagRef(bytes32 bagId,uint256 bagVersion,bytes32 compositionHash,bytes32 definitionHash,bytes32 strategyId,uint32 strategyVersion)');
    bytes32 public constant ASSET_LIMIT_TYPEHASH = keccak256('AssetLimit(address asset,string symbol,uint16 weightBps,uint8 decimals,uint256 maxPriceRaw)');
    bytes32 public constant SCHEDULE_TYPEHASH =
        keccak256('Schedule(uint256 amountPerRun,uint256 totalBudget,uint32 maxRuns,uint64 startsAt,uint64 periodSeconds,uint64 expiresAt)');
    bytes32 public constant ROUTE_TYPEHASH = keccak256('Route(address adapter,address swapRouter,uint24[] allowedFees)');
    bytes32 public constant AUTHORIZATION_TYPEHASH =
        keccak256(
            'DcaAuthorization(address owner,address recipient,address inputToken,address allowedCaller,BagRef bag,AssetLimit[] assets,Schedule schedule,Route route,uint256 nonce)'
            'AssetLimit(address asset,string symbol,uint16 weightBps,uint8 decimals,uint256 maxPriceRaw)'
            'BagRef(bytes32 bagId,uint256 bagVersion,bytes32 compositionHash,bytes32 definitionHash,bytes32 strategyId,uint32 strategyVersion)'
            'Route(address adapter,address swapRouter,uint24[] allowedFees)'
            'Schedule(uint256 amountPerRun,uint256 totalBudget,uint32 maxRuns,uint64 startsAt,uint64 periodSeconds,uint64 expiresAt)'
        );
    bytes32 public constant REVOCATION_TYPEHASH = keccak256('Revocation(address owner,bytes32 authorizationId)');

    uint256 public constant MAX_ASSETS = 10;
    uint256 public constant MAX_DECIMALS = 36;
    uint256 private constant TOTAL_BPS = 10_000;

    // ------------------------------------------------------------- immutables

    IDcaBagFactory public immutable bagFactory;
    /// @notice May be zero; then an authorization must not name a strategy.
    IDcaStrategyRegistry public immutable strategyRegistry;
    IDcaSwapAdapter public immutable adapter;
    /// @notice `adapter.swapRouter()` read at deployment.
    address public immutable swapRouter;
    /// @dev The `chain` field of the BAG app's composition rows (e.g. "robinhood").
    ShortString private immutable _chainLabel;

    mapping(address owner => mapping(bytes32 authorizationId => RunState)) private _state;

    // ------------------------------------------------------------- events

    event AssetDelivered(
        address indexed owner,
        bytes32 indexed authorizationId,
        uint256 indexed executionIndex,
        address recipient,
        address token,
        uint256 balanceBefore,
        uint256 balanceAfter,
        uint256 minReceived
    );

    event PurchaseExecuted(
        address indexed owner,
        bytes32 indexed authorizationId,
        uint256 indexed executionIndex,
        uint256 window,
        address recipient,
        uint256 amountIn,
        uint256 assetCount
    );

    event AuthorizationRevoked(address indexed owner, bytes32 indexed authorizationId);

    // ------------------------------------------------------------- errors

    error ZeroAddress();
    error InvalidChainLabel();
    error AuthorizationMismatch(bytes32 expected, bytes32 given);
    error InvalidOwnerSignature();
    error CallerNotAllowed(address caller);
    error RevokedAuthorization(bytes32 authorizationId);
    /// @dev 1 owner, 2 recipient, 3 input token, 4 schedule, 5 budget, 6 asset count,
    /// 7 asset address, 8 weights, 9 price limit, 10 duplicate asset, 11 route,
    /// 12 fee tier list, 13 BAG hashes, 14 symbol, 15 decimals bound.
    error InvalidTerms(uint256 code);
    error UnknownBag(bytes32 bagId);
    error BagChanged(uint256 version, bytes32 compositionHash);
    error CompositionMismatch(bytes32 signedList, bytes32 registered);
    error StrategyNotRegistered(bytes32 strategyId, uint32 version);
    error AssetDecimalsMismatch(address asset, uint8 signed, uint256 actual);
    error NotDue();
    error Expired();
    error RunDeadlinePassed(uint256 deadline);
    error WrongWindow(uint256 current, uint256 planned);
    error Exhausted();
    error BudgetExceeded();
    error BadRunParams(uint256 code);
    error FeeNotAllowed(uint256 leg, uint24 fee);
    error LegTooSmall(uint256 leg);
    error FundingMismatch(uint256 ownerDebit, uint256 received);
    error AdapterAllowanceLeft(uint256 leg, uint256 left);
    error DeliveryBelowMinimum(address asset, uint256 received, uint256 minimum);
    error InputLeftover(uint256 left);

    constructor(address bagFactory_, address strategyRegistry_, address adapter_, string memory chainLabel_) EIP712('BagDcaExecutor', '1') {
        if (bagFactory_ == address(0) || adapter_ == address(0)) revert ZeroAddress();
        bytes memory label = bytes(chainLabel_);
        if (label.length == 0 || label.length > 31 || !_isRowField(label)) revert InvalidChainLabel();
        address router = IDcaSwapAdapter(adapter_).swapRouter();
        if (router == address(0)) revert ZeroAddress();
        bagFactory = IDcaBagFactory(bagFactory_);
        strategyRegistry = IDcaStrategyRegistry(strategyRegistry_);
        adapter = IDcaSwapAdapter(adapter_);
        swapRouter = router;
        _chainLabel = ShortStrings.toShortString(chainLabel_);
    }

    // ------------------------------------------------------------- execute

    /// @notice Runs one purchase of the authorized DCA. Callable by anyone; every limit
    /// is the owner's. Reverts as a whole (nothing moves, no counter changes) when any
    /// check fails, including any asset above its price ceiling.
    function execute(
        DcaAuthorization calldata a,
        RunParams calldata r,
        bytes calldata ownerSignature
    ) external nonReentrant returns (uint256 executionIndex) {
        bytes32 id = _authorizationId(a);
        if (r.authorizationId != id) revert AuthorizationMismatch(id, r.authorizationId);
        RunState storage st = _state[a.owner][id];
        if (st.revoked) revert RevokedAuthorization(id);
        if (a.allowedCaller != address(0) && msg.sender != a.allowedCaller) revert CallerNotAllowed(msg.sender);
        if (!SignatureChecker.isValidSignatureNow(a.owner, id, ownerSignature)) revert InvalidOwnerSignature();
        _checkTerms(a);
        _checkRegistry(a);

        uint256 window;
        (window, executionIndex) = _reserve(st, a.schedule, r);
        _purchase(a, r, id, executionIndex);
        emit PurchaseExecuted(a.owner, id, executionIndex, window, a.recipient, a.schedule.amountPerRun, a.assets.length);
    }

    function _purchase(DcaAuthorization calldata a, RunParams calldata r, bytes32 id, uint256 executionIndex) private {
        uint256[] memory legIn = _legAmounts(a.schedule.amountPerRun, a.assets);
        uint256[] memory minOut = _runMinimums(a, r, legIn);
        uint256 inputBase = IERC20(a.inputToken).balanceOf(address(this));
        _fund(a);
        for (uint256 i = 0; i < legIn.length; i++) {
            _buyLeg(a, Leg(i, executionIndex, a.assets[i].asset, legIn[i], minOut[i], r.fees[i], 0), id);
        }
        uint256 inputAfter = IERC20(a.inputToken).balanceOf(address(this));
        if (inputAfter != inputBase) revert InputLeftover(inputAfter > inputBase ? inputAfter - inputBase : 0);
    }

    // ------------------------------------------------------------- revocation

    /// @notice Stops an authorization for good. Works before its first run too (the id is
    /// computable off chain). The allowance stays; revoke it in the token separately.
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
        RunState storage st = _state[owner][authorizationId];
        if (st.revoked) return;
        st.revoked = true;
        emit AuthorizationRevoked(owner, authorizationId);
    }

    // ------------------------------------------------------------- views

    function getState(address owner, bytes32 authorizationId) external view returns (RunState memory) {
        return _state[owner][authorizationId];
    }

    function authorizationIdOf(DcaAuthorization calldata a) external view returns (bytes32) {
        return _authorizationId(a);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function chainLabel() external view returns (string memory) {
        return ShortStrings.toString(_chainLabel);
    }

    /// @notice keccak256 of the composition string of `assets` in the given order.
    function compositionHashOf(AssetLimit[] calldata assets) external view returns (bytes32) {
        return _compositionHash(assets);
    }

    function legAmounts(uint256 amount, AssetLimit[] calldata assets) external pure returns (uint256[] memory) {
        return _legAmounts(amount, assets);
    }

    /// @notice Ceiling-derived minimum per asset for `amount` (signed decimals; no token call).
    function ceilingMinimums(uint256 amount, AssetLimit[] calldata assets) external pure returns (uint256[] memory minOut) {
        uint256[] memory legIn = _legAmounts(amount, assets);
        minOut = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) minOut[i] = _ceilingMinimum(legIn[i], assets[i]);
    }

    // ------------------------------------------------------------- hashing

    function _authorizationId(DcaAuthorization calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(_hashAuthorization(a));
    }

    function _hashAuthorization(DcaAuthorization calldata a) private pure returns (bytes32) {
        bytes32[] memory assetHashes = new bytes32[](a.assets.length);
        for (uint256 i = 0; i < a.assets.length; i++) {
            AssetLimit calldata l = a.assets[i];
            assetHashes[i] = keccak256(abi.encode(ASSET_LIMIT_TYPEHASH, l.asset, keccak256(bytes(l.symbol)), l.weightBps, l.decimals, l.maxPriceRaw));
        }
        uint256[] memory fees = new uint256[](a.route.allowedFees.length);
        for (uint256 i = 0; i < fees.length; i++) fees[i] = a.route.allowedFees[i];
        bytes32[4] memory parts = [
            keccak256(abi.encode(BAG_REF_TYPEHASH, a.bag)),
            keccak256(abi.encodePacked(assetHashes)),
            keccak256(abi.encode(SCHEDULE_TYPEHASH, a.schedule)),
            keccak256(abi.encode(ROUTE_TYPEHASH, a.route.adapter, a.route.swapRouter, keccak256(abi.encodePacked(fees))))
        ];
        return keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a.owner, a.recipient, a.inputToken, a.allowedCaller, parts[0], parts[1], parts[2], parts[3], a.nonce));
    }

    // ------------------------------------------------------------- checks

    function _checkTerms(DcaAuthorization calldata a) private view {
        if (a.owner == address(0)) revert InvalidTerms(1);
        if (a.recipient == address(0) || a.recipient == address(this) || a.recipient == address(adapter) || a.recipient == swapRouter) revert InvalidTerms(2);
        if (a.inputToken == address(0) || a.inputToken == address(adapter) || a.inputToken == swapRouter) revert InvalidTerms(3);
        Schedule calldata s = a.schedule;
        if (s.amountPerRun == 0 || s.periodSeconds == 0 || s.maxRuns == 0 || s.startsAt == 0 || s.expiresAt <= s.startsAt) revert InvalidTerms(4);
        if (s.totalBudget != s.amountPerRun * s.maxRuns) revert InvalidTerms(5);

        uint256 n = a.assets.length;
        if (n == 0 || n > MAX_ASSETS) revert InvalidTerms(6);
        uint256 weights;
        for (uint256 i = 0; i < n; i++) {
            AssetLimit calldata l = a.assets[i];
            if (l.asset == address(0) || l.asset == a.inputToken || l.asset == address(adapter) || l.asset == swapRouter || l.asset == a.recipient) {
                revert InvalidTerms(7);
            }
            if (l.weightBps == 0) revert InvalidTerms(8);
            if (l.maxPriceRaw == 0) revert InvalidTerms(9);
            if (l.decimals > MAX_DECIMALS) revert InvalidTerms(15);
            for (uint256 j = 0; j < i; j++) if (a.assets[j].asset == l.asset) revert InvalidTerms(10);
            bytes calldata symbol = bytes(l.symbol);
            if (symbol.length == 0 || symbol.length > 64 || !_isRowField(symbol)) revert InvalidTerms(14);
            weights += l.weightBps;
        }
        if (weights != TOTAL_BPS) revert InvalidTerms(8);

        Route calldata route = a.route;
        if (route.adapter != address(adapter) || route.swapRouter != swapRouter) revert InvalidTerms(11);
        uint256 f = route.allowedFees.length;
        if (f == 0 || f > 4) revert InvalidTerms(12);
        for (uint256 i = 0; i < f; i++) {
            uint24 fee = route.allowedFees[i];
            if (fee != 100 && fee != 500 && fee != 3000 && fee != 10000) revert InvalidTerms(12);
            for (uint256 j = 0; j < i; j++) if (route.allowedFees[j] == fee) revert InvalidTerms(12);
        }
    }

    /// @dev The BAG must exist at the signed version and composition, and the signed asset
    /// list must BE that composition: its rows, rebuilt here, hash to the Bag's registered
    /// `compositionHash`. A real BAG id cannot travel with another token/weight list.
    function _checkRegistry(DcaAuthorization calldata a) private view {
        BagRef calldata b = a.bag;
        if (b.definitionHash == bytes32(0) || b.compositionHash == bytes32(0)) revert InvalidTerms(13);
        address bag = bagFactory.bagOf(b.bagId);
        if (bag == address(0)) revert UnknownBag(b.bagId);
        uint256 version = IDcaBag(bag).version();
        bytes32 composition = IDcaBag(bag).compositionHash();
        if (version != b.bagVersion || composition != b.compositionHash) revert BagChanged(version, composition);
        bytes32 signedList = _compositionHash(a.assets);
        if (signedList != composition) revert CompositionMismatch(signedList, composition);
        if (b.strategyId != bytes32(0)) {
            if (address(strategyRegistry) == address(0) || !strategyRegistry.matches(b.strategyId, b.strategyVersion, b.definitionHash)) {
                revert StrategyNotRegistered(b.strategyId, b.strategyVersion);
            }
        } else if (b.strategyVersion != 0) {
            revert InvalidTerms(13);
        }
    }

    /// @dev The BAG app's composition string (lib/domain/basket-protocol/version.ts): rows
    /// `chain:address:symbol:decimals:weightBps` (lowercase hex address) joined by `|`, in the
    /// caller's order (only the registered order reproduces the registered hash).
    function _compositionHash(AssetLimit[] calldata assets) private view returns (bytes32) {
        bytes memory chain = bytes(ShortStrings.toString(_chainLabel));
        bytes memory s;
        for (uint256 i = 0; i < assets.length; i++) {
            AssetLimit calldata l = assets[i];
            s = abi.encodePacked(
                s,
                i == 0 ? bytes('') : bytes('|'),
                chain,
                ':',
                Strings.toHexString(l.asset),
                ':',
                l.symbol,
                ':',
                Strings.toString(l.decimals),
                ':',
                Strings.toString(l.weightBps)
            );
        }
        return keccak256(s);
    }

    function _isRowField(bytes memory field) private pure returns (bool) {
        for (uint256 i = 0; i < field.length; i++) if (field[i] == ':' || field[i] == '|') return false;
        return true;
    }

    /// @dev Calendar, run count and budget. Counters change here, before any external call,
    /// and roll back with the transaction on any later failure.
    function _reserve(RunState storage st, Schedule calldata s, RunParams calldata r) private returns (uint256 window, uint256 index) {
        uint256 t = block.timestamp;
        if (t < s.startsAt) revert NotDue();
        if (t >= s.expiresAt) revert Expired();
        if (t > r.deadline) revert RunDeadlinePassed(r.deadline);
        window = (t - s.startsAt) / s.periodSeconds;
        if (window != r.window) revert WrongWindow(window, r.window);
        if (st.runs != 0 && (window <= st.lastWindow || t < uint256(st.lastRunAt) + s.periodSeconds)) revert NotDue();
        if (st.runs >= s.maxRuns) revert Exhausted();
        if (st.spent + s.amountPerRun > s.totalBudget) revert BudgetExceeded();
        index = st.runs;
        st.runs += 1;
        st.spent += s.amountPerRun;
        st.lastWindow = uint64(window);
        st.lastRunAt = uint64(t);
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
                if (best == type(uint256).max || rem[i] > rem[best] || (rem[i] == rem[best] && uint160(assets[i].asset) < uint160(assets[best].asset))) best = i;
            }
            parts[best] += 1;
            taken[best] = true;
            leftover -= 1;
        }
    }

    /// @dev ceil(legIn × 10^decimals / maxPriceRaw), full precision (no intermediate overflow).
    function _ceilingMinimum(uint256 legIn, AssetLimit calldata l) private pure returns (uint256) {
        if (l.maxPriceRaw == 0) revert InvalidTerms(9);
        if (l.decimals > MAX_DECIMALS) revert InvalidTerms(15);
        return Math.mulDiv(legIn, 10 ** uint256(l.decimals), l.maxPriceRaw, Math.Rounding.Ceil);
    }

    /// @dev Per-leg checks of the keeper's parameters and the minimum each leg must deliver:
    /// max(ceiling minimum, keeper floor). Also re-reads every asset's decimals.
    function _runMinimums(DcaAuthorization calldata a, RunParams calldata r, uint256[] memory legIn) private view returns (uint256[] memory minOut) {
        uint256 n = a.assets.length;
        if (r.fees.length != n) revert BadRunParams(1);
        if (r.minOutFloors.length != 0 && r.minOutFloors.length != n) revert BadRunParams(2);
        minOut = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            AssetLimit calldata l = a.assets[i];
            if (legIn[i] == 0) revert LegTooSmall(i);
            _checkDecimals(l);
            _checkFee(a.route.allowedFees, i, r.fees[i]);
            uint256 m = _ceilingMinimum(legIn[i], l);
            if (r.minOutFloors.length != 0 && r.minOutFloors[i] > m) m = r.minOutFloors[i];
            minOut[i] = m;
        }
    }

    function _checkDecimals(AssetLimit calldata l) private view {
        uint256 actual;
        try IERC20Metadata(l.asset).decimals() returns (uint8 d) {
            actual = d;
        } catch {
            actual = type(uint256).max;
        }
        if (actual != l.decimals) revert AssetDecimalsMismatch(l.asset, l.decimals, actual);
    }

    function _checkFee(uint24[] calldata allowed, uint256 leg, uint24 fee) private pure {
        for (uint256 j = 0; j < allowed.length; j++) if (allowed[j] == fee) return;
        revert FeeNotAllowed(leg, fee);
    }

    /// @dev Pulls exactly one run's amount from the owner. Both the owner's debit and this
    /// contract's receipt must equal it (a fee-on-transfer or rebasing input token reverts).
    function _fund(DcaAuthorization calldata a) private {
        IERC20 token = IERC20(a.inputToken);
        uint256 amount = a.schedule.amountPerRun;
        uint256 ownerBefore = token.balanceOf(a.owner);
        uint256 selfBefore = token.balanceOf(address(this));
        token.safeTransferFrom(a.owner, address(this), amount);
        uint256 ownerAfter = token.balanceOf(a.owner);
        uint256 debit = ownerBefore >= ownerAfter ? ownerBefore - ownerAfter : 0;
        uint256 received = token.balanceOf(address(this)) - selfBefore;
        if (debit != amount || received != amount) revert FundingMismatch(debit, received);
    }

    /// @dev One leg of a run (memory, to keep the stack small).
    struct Leg {
        uint256 leg;
        uint256 run;
        address asset;
        uint256 amountIn;
        uint256 minOut;
        uint24 fee;
        uint256 balanceBefore;
    }

    /// @dev One leg: exact approval to the adapter, typed swap, approval must be fully used,
    /// recipient balance delta measured HERE (the adapter's own figure is not trusted).
    function _buyLeg(DcaAuthorization calldata a, Leg memory leg, bytes32 id) private {
        leg.balanceBefore = IERC20(leg.asset).balanceOf(a.recipient);
        _swap(a, leg);
        uint256 afterBal = IERC20(leg.asset).balanceOf(a.recipient);
        uint256 received = afterBal > leg.balanceBefore ? afterBal - leg.balanceBefore : 0;
        if (received < leg.minOut) revert DeliveryBelowMinimum(leg.asset, received, leg.minOut);
        emit AssetDelivered(a.owner, id, leg.run, a.recipient, leg.asset, leg.balanceBefore, afterBal, leg.minOut);
    }

    function _swap(DcaAuthorization calldata a, Leg memory leg) private {
        IERC20 input = IERC20(a.inputToken);
        input.forceApprove(address(adapter), leg.amountIn);
        adapter.swapExactIn(a.inputToken, leg.asset, leg.amountIn, leg.minOut, a.recipient, abi.encode(uint256(leg.fee)));
        uint256 left = input.allowance(address(this), address(adapter));
        if (left != 0) revert AdapterAllowanceLeft(leg.leg, left);
    }
}
