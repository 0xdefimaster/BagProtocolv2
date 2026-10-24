// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IBasketAccount { function executeFromExecutor(bytes32, bytes calldata) external returns (bytes[] memory); }
interface IBasketToken {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}
interface IBasketFactory { function predictProxyAddress(address) external view returns (address); }
interface IBasketProxy { function owner() external view returns (address); function factory() external view returns (address); }

/// @notice Local-fork research only. One owner-authorized Composer template per
/// strategy, amount and allocation. Fresh quotes may change only swap payloads;
/// every other state cell and instruction is pinned. No oracle or BAG ledger.
contract BasketPurchase {
    struct Instruction { uint256 opcode; bytes32 operand; }
    struct Memory { bytes[] state; }
    struct Swap { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }
    struct Leg { address token; uint256 weightBps; uint256 input; uint256 net; uint256 minimum; uint256 slot; bytes32 feeHash; }
    struct Budget { address account; bytes32 definitionHash; uint256 gross; uint256 total; uint256 start; uint256 period; uint256 expiry; uint256 cashBps; }
    struct Profile { Instruction[] instructions; bytes[] state; uint256 contextSlot; uint256 amountSlot; Leg[] legs; }
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FACTORY = 0xACEB3Bb6C75488b5b806B9de4dCF78814465BdaE;
    address constant DIAMOND = 0xB477751B76CF82d00a686A1232f5fCD772414Af3;
    address constant FEE = 0xF4BFFE4dfC693f37715A47c15BdA8af9ed8f7Cf1;
    address constant ROUTER = 0x603206D6105217DD972E4Ab30676A220CA393346;
    address constant ROUTER_TWO = 0x8E6fD69A77e88ee20Ba4B4fBd59DfCDA3EC0E98A;
    address constant MATH_ONE = 0xe450D45C03745909e08B5C46A87016c33F16a4A6;
    address constant MATH_TWO = 0x0DC20AF039443DC9A8a193f0f42F0AF2Ea611e8a;
    bytes4 constant VM = 0x00a32e6c;
    bytes4 constant WRAPPER = 0x22aca0ca;
    bytes4 constant SWAP = 0x5fd9ae2e;
    address public immutable owner;
    address public immutable account;
    address public immutable proxy;
    bytes32 public immutable definitionHash;
    bytes32 public immutable context;
    bytes32 public immutable commandsHash;
    uint256 public immutable grossAmount;
    uint256 public immutable swapAmount;
    uint256 public immutable maxGross;
    uint256 public immutable maxRuns;
    uint256 public immutable start;
    uint256 public immutable period;
    uint256 public immutable expiry;
    uint256 public immutable contextSlot;
    uint256 public immutable amountSlot;
    uint256 public runs;
    uint256 public grossBudgetUsed;
    uint256 public lastExecution;
    uint256 public lastWindow;
    bool public paused;
    bool public revoked;
    bool private locked;
    bytes32 private proxyCodeHash;
    Leg[] public legs;
    bytes32[] private stateHashes;
    mapping(uint256 => uint256) private legAtSlot;
    address[] private pinnedAddresses;
    bytes32[] private pinnedCodeHashes;
    event Purchased(uint256 indexed run, uint256 window, bytes32 programHash, uint256[] received);
    event Paused(bool value);
    event Revoked();
    error Denied(); error NotDue(); error ProfileViolation(uint256 field);
    error InputDelta(); error OutputMinimum(); error DeploymentChanged();

    constructor(Budget memory b, Profile memory p) {
        if (block.chainid != 4663 || b.account == address(0) || b.definitionHash == bytes32(0) || b.period < 60 ||
            b.start <= block.timestamp || b.expiry <= b.start || b.gross < 1_000_000 || b.total > 1_000_000_000 ||
            b.total < b.gross || b.total % b.gross != 0 || b.total / b.gross > 20 || b.cashBps >= 10000 ||
            p.legs.length == 0 || p.legs.length > 10 || p.state.length > 127 || p.state.length < 4 ||
            p.contextSlot < 2 || p.contextSlot >= p.state.length || p.amountSlot >= p.state.length || p.amountSlot == p.contextSlot) revert Denied();
        owner = msg.sender; account = b.account; definitionHash = b.definitionHash;
        grossAmount = b.gross; maxGross = b.total; maxRuns = b.total / b.gross;
        start = b.start; period = b.period; expiry = b.expiry;
        contextSlot = p.contextSlot; amountSlot = p.amountSlot;
        proxy = IBasketFactory(FACTORY).predictProxyAddress(b.account);
        bytes16 key = bytes16(keccak256(abi.encode(address(this), b.account, b.definitionHash)));
        context = bytes32(abi.encodePacked(key, key));
        uint256 weights = b.cashBps; uint256 swapped;
        for (uint256 i; i < p.legs.length; i++) {
            Leg memory l = p.legs[i];
            if (l.token == address(0) || l.token == USDG || l.weightBps == 0 || l.minimum == 0 || l.input == 0 || l.net == 0 || l.net > l.input ||
                l.slot < 2 || l.slot >= p.state.length || l.slot == p.contextSlot || l.slot == p.amountSlot || legAtSlot[l.slot] != 0) revert Denied();
            for (uint256 j; j < i; j++) if (p.legs[j].token == l.token) revert Denied();
            uint256 target = b.gross * l.weightBps / 10000;
            if (_distance(l.input, target) > b.gross / 10000 + p.legs.length + 1) revert Denied();
            legs.push(l); legAtSlot[l.slot] = i + 1; weights += l.weightBps; swapped += l.input; _pin(l.token);
        }
        if (weights != 10000 || swapped > b.gross || _distance(b.gross - swapped, b.gross * b.cashBps / 10000) > 1) revert Denied();
        swapAmount = swapped;
        _equal(p.state[0], abi.encode(b.account), 10);
        _equal(p.state[1], _body(abi.encodeWithSignature("balanceOf(address)", proxy)), 11);
        _equal(p.state[p.amountSlot], abi.encode(swapped), 12);
        for (uint256 i; i < p.state.length; i++) {
            stateHashes.push(keccak256(p.state[i]));
            if (legAtSlot[i] != 0) _swap(p.state[i], legs[legAtSlot[i] - 1]);
            else if (i != p.contextSlot && p.state[i].length > 32) _qualifyFixedData(p.state[i]);
        }
        _qualifyCommands(p.instructions);
        commandsHash = keccak256(abi.encode(p.instructions));
        if (FACTORY.codehash != 0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5) revert DeploymentChanged();
        _pin(FACTORY); _pin(USDG); _pin(DIAMOND); _pin(FEE); _pin(ROUTER); _pin(ROUTER_TWO); _pin(MATH_ONE); _pin(MATH_TWO);
        if (proxy.code.length != 0) { _checkProxy(); proxyCodeHash = proxy.codehash; }
    }
    function _distance(uint256 a, uint256 b) private pure returns (uint256) { return a > b ? a - b : b - a; }
    function _token(address a) private view returns (bool) { if (a == USDG) return true; for (uint256 i; i < legs.length; i++) if (legs[i].token == a) return true; return false; }
    function _pin(address a) private { if (a.code.length == 0) revert DeploymentChanged(); pinnedAddresses.push(a); pinnedCodeHashes.push(a.codehash); }
    function _checkProxy() private view { if (IBasketProxy(proxy).owner() != account || IBasketProxy(proxy).factory() != FACTORY) revert DeploymentChanged(); }
    function setPaused(bool value) external { if (msg.sender != owner || revoked) revert Denied(); paused = value; emit Paused(value); }
    function revoke() external { if (msg.sender != owner) revert Denied(); revoked = true; emit Revoked(); }

    function _qualifyCommands(Instruction[] memory cmds) private view {
        if (cmds.length == 0 || cmds.length > 320 || cmds[0].opcode != 9 || uint8(cmds[0].operand[2]) != contextSlot) revert ProfileViolation(50);
        uint256 pulls;
        for (uint256 i; i < cmds.length; i++) {
            bytes32 a = cmds[i].operand; uint256 op = cmds[i].opcode;
            if (op == 0) {
                address target = address(bytes20(a << 8)); uint8 kind = uint8(a[0]);
                if (kind == 1) { if (target != USDG && target != DIAMOND) revert ProfileViolation(51); }
                else if (kind == 2) { if (!_token(target) && target != MATH_ONE && target != MATH_TWO) revert ProfileViolation(52); }
                else revert ProfileViolation(53);
            } else if (op == 1) {
                bytes4 selector = bytes4(a);
                if (selector != 0xad207fd7 && selector != 0xfe79e115 && selector != 0xe1f0273e) revert ProfileViolation(54);
            } else if (op == 3) {
                if (address(bytes20(a)) != USDG || uint8(a[20]) != contextSlot || uint8(a[21]) != amountSlot) revert ProfileViolation(55);
                pulls++;
            } else if (op == 10) {
                if (!_token(address(bytes20(a))) || uint8(a[20]) != 0) revert ProfileViolation(56);
            } else if (op != 9) revert ProfileViolation(57);
        }
        if (pulls != 1) revert ProfileViolation(58);
    }
    function _qualifyFixedData(bytes memory body) private view {
        bytes memory data = abi.decode(abi.encodePacked(uint256(32), body), (bytes));
        _equal(body, _body(data), 60);
        bytes4 s = _selector(data);
        if (s == 0x70a08231) { _equal(data, abi.encodeWithSignature("balanceOf(address)", proxy), 61); return; }
        if (s == 0x095ea7b3) {
            (address spender, uint256 amount) = abi.decode(_tail(data), (address, uint256));
            if (spender != DIAMOND) revert ProfileViolation(62);
            bool known; for (uint256 i; i < legs.length; i++) if (legs[i].input == amount) known = true;
            if (!known) revert ProfileViolation(63);
            _equal(data, abi.encodeWithSignature("approve(address,uint256)", spender, amount), 64); return;
        }
        // Frozen arithmetic/partition ABI data, with its exact hash pinned.
        if (s != 0xfe79e115) revert ProfileViolation(65);
    }
    function validate(address target, bytes calldata data) public view {
        for (uint256 i; i < pinnedAddresses.length; i++) if (pinnedAddresses[i].codehash != pinnedCodeHashes[i]) revert DeploymentChanged();
        bytes memory program;
        if (proxy.code.length == 0) {
            if (target != FACTORY || data.length < 4 || bytes4(data[:4]) != WRAPPER) revert ProfileViolation(1);
            program = abi.decode(data[4:], (bytes));
            _equal(data, abi.encodePacked(WRAPPER, abi.encode(program)), 2);
        } else {
            if (target != proxy || (proxyCodeHash != bytes32(0) && proxy.codehash != proxyCodeHash)) revert ProfileViolation(3);
            _checkProxy(); program = data;
        }
        if (_selector(program) != VM) revert ProfileViolation(4);
        (Instruction[] memory cmds, Memory memory mem) = abi.decode(_tail(program), (Instruction[], Memory));
        _equal(program, abi.encodePacked(VM, abi.encode(cmds, mem)), 5);
        if (keccak256(abi.encode(cmds)) != commandsHash || mem.state.length != stateHashes.length) revert ProfileViolation(6);
        for (uint256 i; i < mem.state.length; i++) {
            if (i == contextSlot) _equal(mem.state[i], abi.encode(context), 7);
            else if (legAtSlot[i] != 0) _swap(mem.state[i], legs[legAtSlot[i] - 1]);
            else if (keccak256(mem.state[i]) != stateHashes[i]) revert ProfileViolation(8);
        }
    }
    function _swap(bytes memory body, Leg memory l) private view {
        bytes memory data = abi.decode(abi.encodePacked(uint256(32), body), (bytes));
        _equal(body, _body(data), 30);
        if (_selector(data) != SWAP) revert ProfileViolation(31);
        (bytes32 id, string memory integrator, string memory referrer, address receiver, uint256 minimum, Swap[] memory swaps) = abi.decode(_tail(data), (bytes32, string, string, address, uint256, Swap[]));
        _equal(data, abi.encodePacked(SWAP, abi.encode(id, integrator, referrer, receiver, minimum, swaps)), 32);
        if (receiver != proxy || minimum < l.minimum || swaps.length != 2 || keccak256(bytes(integrator)) != keccak256("lifi-api") || keccak256(bytes(referrer)) != keccak256("0x0000000000000000000000000000000000000000")) revert ProfileViolation(33);
        Swap memory fee = swaps[0]; Swap memory route = swaps[1];
        if (fee.callTo != FEE || fee.approveTo != FEE || fee.sendingAssetId != USDG || fee.receivingAssetId != USDG || fee.fromAmount != l.input || !fee.requiresDeposit || keccak256(fee.callData) != l.feeHash) revert ProfileViolation(34);
        bool known = (route.callTo == ROUTER && _selector(route.callData) == 0x3f0bde25) || (route.callTo == ROUTER_TWO && _selector(route.callData) == 0x5f3bd1c8);
        if (!known || route.approveTo != route.callTo || route.sendingAssetId != USDG || route.receivingAssetId != l.token || route.fromAmount != l.net || route.requiresDeposit) revert ProfileViolation(35);
    }
    function run(address target, bytes calldata data) external {
        if (msg.sender != account || locked || paused || revoked || block.timestamp > expiry || runs >= maxRuns || grossBudgetUsed + grossAmount > maxGross) revert Denied();
        if (block.timestamp < start) revert NotDue();
        uint256 window = (block.timestamp - start) / period;
        if (runs != 0 && (window <= lastWindow || block.timestamp < lastExecution + period)) revert NotDue();
        validate(target, data);
        uint256 inputBefore = IBasketToken(USDG).balanceOf(account); uint256 ethBefore = account.balance;
        uint256[] memory before = new uint256[](legs.length);
        for (uint256 i; i < legs.length; i++) {
            if (IBasketToken(legs[i].token).allowance(account, proxy) != 0) revert InputDelta();
            before[i] = IBasketToken(legs[i].token).balanceOf(account);
        }
        uint256 reserved = (runs + 1) * (grossAmount - swapAmount);
        if (inputBefore < swapAmount + reserved) revert InputDelta();
        locked = true; runs++; grossBudgetUsed += grossAmount; lastWindow = window; lastExecution = block.timestamp;
        _call(USDG, abi.encodeWithSignature("approve(address,uint256)", proxy, 0));
        _call(USDG, abi.encodeWithSignature("approve(address,uint256)", proxy, swapAmount));
        _call(target, data);
        _call(USDG, abi.encodeWithSignature("approve(address,uint256)", proxy, 0));
        uint256 inputAfter = IBasketToken(USDG).balanceOf(account);
        if (inputAfter > inputBefore || inputBefore - inputAfter != swapAmount || inputAfter < reserved || IBasketToken(USDG).allowance(account, proxy) != 0 || account.balance != ethBefore) revert InputDelta();
        uint256[] memory received = new uint256[](legs.length);
        for (uint256 i; i < legs.length; i++) {
            uint256 afterBalance = IBasketToken(legs[i].token).balanceOf(account);
            if (afterBalance < before[i] + legs[i].minimum || IBasketToken(legs[i].token).allowance(account, proxy) != 0) revert OutputMinimum();
            received[i] = afterBalance - before[i];
        }
        _checkProxy();
        if (proxyCodeHash != bytes32(0) && proxy.codehash != proxyCodeHash) revert DeploymentChanged();
        proxyCodeHash = proxy.codehash; locked = false;
        emit Purchased(runs, window, keccak256(data), received);
    }
    function _call(address target, bytes memory data) private { IBasketAccount(account).executeFromExecutor(bytes32(0), abi.encodePacked(target, uint256(0), data)); }
    function _equal(bytes memory a, bytes memory b, uint256 field) private pure { if (keccak256(a) != keccak256(b)) revert ProfileViolation(field); }
    function _selector(bytes memory a) private pure returns (bytes4 s) { if (a.length < 4) revert ProfileViolation(40); assembly { s := mload(add(a, 32)) } }
    function _tail(bytes memory a) private pure returns (bytes memory b) { b = new bytes(a.length - 4); for (uint256 i; i < b.length; i++) b[i] = a[i + 4]; }
    function _body(bytes memory a) private pure returns (bytes memory b) { bytes memory e = abi.encode(a); b = new bytes(e.length - 32); for (uint256 i; i < b.length; i++) b[i] = e[i + 32]; }
}
