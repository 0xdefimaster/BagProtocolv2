// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRecurringAccount {
    function executeFromExecutor(bytes32, bytes calldata) external returns (bytes[] memory);
}
interface IRecurringToken {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}
interface IRecurringFactory { function predictProxyAddress(address) external view returns (address); }
interface IRecurringProxy {
    function owner() external view returns (address);
    function factory() external view returns (address);
}

/// @notice RESEARCH ONLY: a deliberately narrow, pinned Composer program profile.
/// Not a general VM verifier, audited module, production wallet or oracle policy.
contract ConfiguredPurchase {
    struct Instruction { uint256 opcode; bytes32 operand; }
    struct Memory { bytes[] state; }
    struct Swap {
        address callTo; address approveTo; address sendingAssetId; address receivingAssetId;
        uint256 fromAmount; bytes callData; bool requiresDeposit;
    }
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant BTC = 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4;
    address constant FACTORY = 0xACEB3Bb6C75488b5b806B9de4dCF78814465BdaE;
    address constant DIAMOND = 0xB477751B76CF82d00a686A1232f5fCD772414Af3;
    address constant FEE = 0xF4BFFE4dfC693f37715A47c15BdA8af9ed8f7Cf1;
    address constant ROUTER = 0x603206D6105217DD972E4Ab30676A220CA393346;
    address constant ROUTER_TWO = 0x8E6fD69A77e88ee20Ba4B4fBd59DfCDA3EC0E98A;
    bytes32 constant COMMANDS = 0xf6f3c39cb90f6bee24b03389d8a99b1bfe5a31b4bc92f7157516802ae11d1e4d;
    bytes32 public immutable partitionHash;
    uint256 public immutable btcInput; uint256 public immutable ethInput;
    uint256 public immutable btcNet; uint256 public immutable ethNet;
    bytes32 public immutable btcFeeHash; bytes32 public immutable ethFeeHash;
    struct Profile { uint256 btcInput; uint256 ethInput; uint256 btcNet; uint256 ethNet; bytes32 partitionHash; bytes32 btcFeeHash; bytes32 ethFeeHash; }
    bytes4 constant VM = 0x00a32e6c;
    bytes4 constant WRAPPER = 0x22aca0ca;
    bytes4 constant SWAP = 0x5fd9ae2e;
    uint256 public immutable grossAmount;
    uint256 public immutable swapAmount;
    uint256 public immutable maxRuns;
    uint256 public immutable maxGross;
    address public immutable owner;
    address public immutable account;
    address public immutable proxy;
    bytes32 public immutable definitionHash;
    bytes32 public immutable context;
    uint256 public immutable start;
    uint256 public immutable period;
    uint256 public immutable expiry;
    uint256 public immutable minWeth;
    uint256 public immutable minBtc;
    uint256 public runs;
    uint256 public grossBudgetUsed;
    uint256 public lastExecution;
    uint256 public lastWindow;
    bool public paused;
    bool public revoked;
    bool private locked;
    address[] public pinnedAddresses;
    bytes32[] public pinnedCodeHashes;
    event Purchased(uint256 indexed run, uint256 window, bytes32 programHash, uint256 wethReceived, uint256 btcReceived);
    event Paused(bool value);
    event Revoked();
    error Denied(); error NotDue(); error ProfileViolation(uint256 field);
    error InputDelta(); error OutputMinimum(); error DeploymentChanged();

    constructor(address a, bytes32 bagHash, uint256 gross, uint256 budget, uint256 due, uint256 interval, uint256 until, uint256 ethFloor, uint256 btcFloor, Profile memory p) {
        if (block.chainid != 4663 || a == address(0) || bagHash == bytes32(0) || interval == 0 ||
            until <= due || due <= block.timestamp || ethFloor == 0 || btcFloor == 0) revert Denied();
        if (gross < 1_000_000 || budget < gross || budget > 1_000_000_000 || budget / gross > 20 || interval < 60) revert Denied();
        grossAmount = gross; swapAmount = p.btcInput + p.ethInput; maxGross = budget; maxRuns = budget / gross;
        // SDK uses largest-remainder allocation. The USDG 30% leg can receive
        // one extra base unit; the captured profile pins the exact swap amount.
        uint256 cashFloor = gross * 3000 / 10000;
        if (swapAmount > gross - cashFloor || swapAmount < gross - cashFloor - 1 || p.btcNet == 0 || p.btcNet > p.btcInput || p.ethNet == 0 || p.ethNet > p.ethInput) revert Denied();
        uint256 expectedBtc = gross * 3000 / 10000;
        uint256 difference = p.btcInput > expectedBtc ? p.btcInput - expectedBtc : expectedBtc - p.btcInput;
        if (difference > gross / 10000 + 2) revert Denied();
        btcInput = p.btcInput; ethInput = p.ethInput; btcNet = p.btcNet; ethNet = p.ethNet;
        partitionHash = p.partitionHash; btcFeeHash = p.btcFeeHash; ethFeeHash = p.ethFeeHash;
        owner = msg.sender; account = a; definitionHash = bagHash;
        start = due; period = interval; expiry = until; minWeth = ethFloor; minBtc = btcFloor;
        proxy = IRecurringFactory(FACTORY).predictProxyAddress(a);
        bytes16 key = bytes16(keccak256(abi.encode(address(this), a, bagHash)));
        context = bytes32(abi.encodePacked(key, key));
        if (FACTORY.codehash != 0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5) revert DeploymentChanged();
        _pin(FACTORY); _pin(USDG); _pin(WETH); _pin(BTC); _pin(DIAMOND); _pin(FEE); _pin(ROUTER); _pin(ROUTER_TWO);
        _pin(0xe450D45C03745909e08B5C46A87016c33F16a4A6);
        _pin(0x0DC20AF039443DC9A8a193f0f42F0AF2Ea611e8a);
    }
    function _pin(address a) private { if (a.code.length == 0) revert DeploymentChanged(); pinnedAddresses.push(a); pinnedCodeHashes.push(a.codehash); }
    function setPaused(bool value) external { if (msg.sender != owner || revoked) revert Denied(); paused = value; emit Paused(value); }
    function revoke() external { if (msg.sender != owner) revert Denied(); revoked = true; emit Revoked(); }

    function validate(address target, bytes calldata data) public view {
        for (uint256 i; i < pinnedAddresses.length; i++) if (pinnedAddresses[i].codehash != pinnedCodeHashes[i]) revert DeploymentChanged();
        bytes memory program;
        if (proxy.code.length == 0) {
            if (target != FACTORY || bytes4(data[:4]) != WRAPPER) revert ProfileViolation(1);
            program = abi.decode(data[4:], (bytes));
            if (keccak256(data) != keccak256(abi.encodePacked(WRAPPER, abi.encode(program)))) revert ProfileViolation(2);
        } else {
            if (target != proxy || IRecurringProxy(proxy).owner() != account || IRecurringProxy(proxy).factory() != FACTORY) revert ProfileViolation(3);
            program = data;
        }
        if (program.length < 4 || _selector(program) != VM) revert ProfileViolation(4);
        (Instruction[] memory instructions, Memory memory mem) = abi.decode(_tail(program), (Instruction[], Memory));
        if (keccak256(program) != keccak256(abi.encodePacked(VM, abi.encode(instructions, mem)))) revert ProfileViolation(5);
        if (instructions.length != 34 || keccak256(abi.encode(instructions)) != COMMANDS || mem.state.length != 17) revert ProfileViolation(6);
        bytes[] memory s = mem.state;
        _equal(s[0], abi.encode(account), 10);
        _equal(s[1], _body(abi.encodeWithSignature("balanceOf(address)", proxy)), 11);
        _equal(s[2], abi.encode(uint256(0)), 12);
        _equal(s[3], abi.encode(bytes32(0x8081010000000000000000000000000000000000000000000000000000000000)), 13);
        _equal(s[4], abi.encode(uint256(3)), 14);
        _equal(s[5], abi.encode(btcInput), 15);
        _equal(s[7], _body(abi.encodeWithSignature("approve(address,uint256)", DIAMOND, btcInput)), 17);
        _equal(s[8], abi.encode(ethInput), 18);
        _equal(s[9], abi.encode(swapAmount), 19);
        _equal(s[11], _body(abi.encodeWithSignature("approve(address,uint256)", DIAMOND, ethInput)), 21);
        if (keccak256(s[12]) != partitionHash) revert ProfileViolation(22);
        _equal(s[13], abi.encode(USDG), 23);
        _equal(s[14], abi.encode(bytes32(0x5548c837ab068cf56a2c2479df0882a4922fd203edb7517321831d95078c5f62)), 24);
        _equal(s[15], abi.encode(context), 25);
        _equal(s[16], abi.encode(bytes32(0x47469f21e209d43e16bd7f4ca3e96bbfe3f1a41d7d486028d515bb7b3879bf27)), 26);
        _swap(s[6], BTC, btcInput, btcNet, minBtc, btcFeeHash);
        _swap(s[10], WETH, ethInput, ethNet, minWeth, ethFeeHash);
    }
    function _swap(bytes memory body, address output, uint256 amount, uint256 netAmount, uint256 floor, bytes32 feeHash) private view {
        // VM state uses an ABI bytes body (length+data+padding), without the leading offset.
        bytes memory callData = abi.decode(abi.encodePacked(uint256(32), body), (bytes));
        _equal(body, _body(callData), 30);
        if (_selector(callData) != SWAP) revert ProfileViolation(31);
        (bytes32 id, string memory integrator, string memory referrer, address receiver, uint256 minimum, Swap[] memory swaps) =
            abi.decode(_tail(callData), (bytes32, string, string, address, uint256, Swap[]));
        _equal(callData, abi.encodePacked(SWAP, abi.encode(id, integrator, referrer, receiver, minimum, swaps)), 32);
        if (receiver != proxy || minimum < floor || swaps.length != 2 ||
            keccak256(bytes(integrator)) != keccak256("lifi-api") ||
            keccak256(bytes(referrer)) != keccak256("0x0000000000000000000000000000000000000000")) revert ProfileViolation(33);
        Swap memory fee = swaps[0]; Swap memory route = swaps[1];
        if (fee.callTo != FEE || fee.approveTo != FEE || fee.sendingAssetId != USDG || fee.receivingAssetId != USDG ||
            fee.fromAmount != amount || !fee.requiresDeposit || keccak256(fee.callData) != feeHash) revert ProfileViolation(34);
        bool knownRouter = (route.callTo == ROUTER && _selector(route.callData) == 0x3f0bde25) ||
            (route.callTo == ROUTER_TWO && _selector(route.callData) == 0x5f3bd1c8);
        if (!knownRouter || route.approveTo != route.callTo || route.sendingAssetId != USDG || route.receivingAssetId != output ||
            route.fromAmount != netAmount || route.requiresDeposit) revert ProfileViolation(35);
    }
    function run(address target, bytes calldata data) external {
        if (msg.sender != account || locked || paused || revoked || block.timestamp > expiry || runs >= maxRuns || grossBudgetUsed + grossAmount > maxGross) revert Denied();
        if (block.timestamp < start) revert NotDue();
        uint256 window = (block.timestamp - start) / period;
        if (runs != 0 && (window <= lastWindow || block.timestamp < lastExecution + period)) revert NotDue();
        validate(target, data);
        uint256 inputBefore = IRecurringToken(USDG).balanceOf(account);
        uint256 ethBefore = IRecurringToken(WETH).balanceOf(account);
        uint256 btcBefore = IRecurringToken(BTC).balanceOf(account);
        // Retained cash is reserved across runs; a withdrawal pauses execution until replenished.
        uint256 reservedAfter = (runs + 1) * (grossAmount - swapAmount);
        if (inputBefore < swapAmount + reservedAfter) revert InputDelta();
        locked = true; runs++; grossBudgetUsed += grossAmount; lastWindow = window; lastExecution = block.timestamp;
        _call(USDG, abi.encodeWithSignature("approve(address,uint256)", proxy, 0));
        _call(USDG, abi.encodeWithSignature("approve(address,uint256)", proxy, swapAmount));
        _call(target, data);
        _call(USDG, abi.encodeWithSignature("approve(address,uint256)", proxy, 0));
        uint256 inputAfter = IRecurringToken(USDG).balanceOf(account);
        if (inputAfter > inputBefore || inputBefore - inputAfter != swapAmount || inputAfter < reservedAfter || IRecurringToken(USDG).allowance(account, proxy) != 0) revert InputDelta();
        uint256 ethAfter = IRecurringToken(WETH).balanceOf(account);
        uint256 btcAfter = IRecurringToken(BTC).balanceOf(account);
        if (ethAfter < ethBefore + minWeth || btcAfter < btcBefore + minBtc) revert OutputMinimum();
        if (IRecurringProxy(proxy).owner() != account || IRecurringProxy(proxy).factory() != FACTORY) revert DeploymentChanged();
        locked = false;
        emit Purchased(runs, window, keccak256(data), ethAfter - ethBefore, btcAfter - btcBefore);
    }
    function _call(address target, bytes memory data) private {
        IRecurringAccount(account).executeFromExecutor(bytes32(0), abi.encodePacked(target, uint256(0), data));
    }
    function _equal(bytes memory a, bytes memory b, uint256 field) private pure { if (keccak256(a) != keccak256(b)) revert ProfileViolation(field); }
    function _selector(bytes memory a) private pure returns (bytes4 s) { if (a.length < 4) revert ProfileViolation(40); assembly { s := mload(add(a, 32)) } }
    function _tail(bytes memory a) private pure returns (bytes memory b) { b = new bytes(a.length - 4); for (uint256 i; i < b.length; i++) b[i] = a[i + 4]; }
    function _body(bytes memory a) private pure returns (bytes memory b) { bytes memory e = abi.encode(a); b = new bytes(e.length - 32); for (uint256 i; i < b.length; i++) b[i] = e[i + 32]; }
}

