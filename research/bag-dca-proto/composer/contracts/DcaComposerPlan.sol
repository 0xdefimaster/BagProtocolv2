// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @notice RESEARCH PROTOTYPE ONLY. Not audited, not production. The plan contract itself is the
/// Composer signer. Composer program checks are adapted from
/// scripts/research/dca-trial/contracts/BasketPurchase.sol (commit e6bdd10). Differences:
///  - the signer is address(this), funded per run from the owner EOA (A) or smart account (B);
///  - the pinned template is signer-independent: signer slot, proxy-balance slot, context slot
///    and swap slots are excluded from the CREATE2 init code and rebuilt from address(this) at
///    run time, so the plan address does not depend on Composer data that names the plan;
///  - purchased tokens are forwarded to the recipient in the same transaction.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}
interface IDelegationManager { function redeemDelegations(bytes[] calldata, bytes32[] calldata, bytes[] calldata) external; }
interface IComposerFactory { function predictProxyAddress(address) external view returns (address); }
interface IComposerProxy { function owner() external view returns (address); function factory() external view returns (address); }
interface IPlanRegistry { function cancelled(address) external view returns (bool); }

struct Terms {
    uint8 funding;              // 1 = EOA allowance (A), 2 = smart-account delegation (B)
    address owner;              // user EOA: the only address that can cancel
    address source;             // A: owner EOA; B: owner's smart account
    address recipient;          // receives every purchased token
    address delegationManager;  // B only
    bytes32 definitionHash;     // BAG strategy definition
    uint256 grossPerRun;        // USDG per purchase, including any retained USDG share
    uint256 maxRuns;
    uint256 start;
    uint256 period;
    uint256 expiry;
    uint256 cashBps;            // BAG weight kept as USDG (not swapped, never pulled)
}
struct Instruction { uint256 opcode; bytes32 operand; }
struct Leg { address token; uint256 weightBps; uint256 input; uint256 net; uint256 minimum; uint256 slot; bytes32 feeHash; }
/// state[] carries the template; signer-dependent slots must be empty bytes.
struct Profile { Instruction[] instructions; bytes[] state; uint256 signerSlot; uint256 proxyBalanceSlot; uint256 contextSlot; uint256 amountSlot; Leg[] legs; }

contract DcaComposerPlan {
    struct Memory { bytes[] state; }
    struct Swap { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }
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

    address public immutable registry;
    uint8 public immutable funding;
    address public immutable owner;
    address public immutable source;
    address public immutable recipient;
    address public immutable delegationManager;
    bytes32 public immutable definitionHash;
    uint256 public immutable grossPerRun;
    uint256 public immutable swapAmount;
    uint256 public immutable maxRuns;
    uint256 public immutable start;
    uint256 public immutable period;
    uint256 public immutable expiry;
    address public immutable proxy;
    bytes32 public immutable context;
    bytes32 public immutable commandsHash;
    uint256 public immutable signerSlot;
    uint256 public immutable proxyBalanceSlot;
    uint256 public immutable contextSlot;
    uint256 public immutable amountSlot;

    uint256 public runs;
    uint256 public lastWindow;
    uint256 public lastExecution;
    bool public cancelled;
    bool private locked;
    bytes32 private proxyCodeHash;
    Leg[] public legs;
    bytes32[] private stateHashes;          // zero for slots rebuilt at run time
    mapping(uint256 => uint256) private legAtSlot;
    address[] private pinnedAddresses;
    bytes32[] private pinnedCodeHashes;

    event Purchased(uint256 indexed run, uint256 window, bytes32 programHash, uint256[] delivered);
    event Cancelled();
    error Denied(); error NotDue(); error Inactive(); error ProfileViolation(uint256 field);
    error FundingMismatch(); error InputDelta(); error OutputMinimum(); error Residue(); error DeploymentChanged();

    constructor(Terms memory t, Profile memory p) {
        if ((t.funding != 1 && t.funding != 2) || t.owner == address(0) || t.recipient == address(0) || t.definitionHash == bytes32(0) ||
            (t.funding == 1 && t.source != t.owner) || (t.funding == 2 && t.delegationManager == address(0)) ||
            t.period < 60 || t.expiry <= t.start || t.grossPerRun < 1_000_000 || t.maxRuns == 0 || t.maxRuns > 20 || t.cashBps >= 10000 ||
            p.legs.length == 0 || p.legs.length > 10 || p.state.length < 4 || p.state.length > 127) revert Denied();
        uint256 n = p.state.length;
        if (p.signerSlot >= n || p.proxyBalanceSlot >= n || p.contextSlot >= n || p.amountSlot >= n ||
            p.signerSlot == p.proxyBalanceSlot || p.contextSlot == p.signerSlot || p.contextSlot == p.proxyBalanceSlot ||
            p.amountSlot == p.contextSlot || p.amountSlot == p.signerSlot || p.amountSlot == p.proxyBalanceSlot) revert Denied();
        registry = msg.sender;
        if (IPlanRegistry(msg.sender).cancelled(address(this))) revert Inactive();
        funding = t.funding; owner = t.owner; source = t.source; recipient = t.recipient; delegationManager = t.delegationManager;
        definitionHash = t.definitionHash; grossPerRun = t.grossPerRun; maxRuns = t.maxRuns; start = t.start; period = t.period; expiry = t.expiry;
        signerSlot = p.signerSlot; proxyBalanceSlot = p.proxyBalanceSlot; contextSlot = p.contextSlot; amountSlot = p.amountSlot;
        proxy = IComposerFactory(FACTORY).predictProxyAddress(address(this));
        bytes16 key = bytes16(keccak256(abi.encode(address(this), t.definitionHash)));
        context = bytes32(abi.encodePacked(key, key));

        uint256 weights = t.cashBps; uint256 swapped;
        for (uint256 i; i < p.legs.length; i++) {
            Leg memory l = p.legs[i];
            if (l.token == address(0) || l.token == USDG || l.weightBps == 0 || l.minimum == 0 || l.input == 0 || l.net == 0 || l.net > l.input ||
                l.slot >= n || l.slot == p.signerSlot || l.slot == p.proxyBalanceSlot || l.slot == p.contextSlot || l.slot == p.amountSlot || legAtSlot[l.slot] != 0) revert Denied();
            for (uint256 j; j < i; j++) if (p.legs[j].token == l.token) revert Denied();
            if (_distance(l.input, t.grossPerRun * l.weightBps / 10000) > t.grossPerRun / 10000 + p.legs.length + 1) revert Denied();
            legs.push(l); legAtSlot[l.slot] = i + 1; weights += l.weightBps; swapped += l.input; _pin(l.token);
        }
        if (weights != 10000 || swapped > t.grossPerRun || _distance(t.grossPerRun - swapped, t.grossPerRun * t.cashBps / 10000) > 1) revert Denied();
        swapAmount = swapped;
        _equal(p.state[p.amountSlot], abi.encode(swapped), 12);
        for (uint256 i; i < n; i++) {
            bool derived = i == p.signerSlot || i == p.proxyBalanceSlot || i == p.contextSlot || legAtSlot[i] != 0;
            if (derived) { if (p.state[i].length != 0) revert ProfileViolation(13); stateHashes.push(bytes32(0)); continue; }
            stateHashes.push(keccak256(p.state[i]));
            if (p.state[i].length > 32) _qualifyFixedData(p.state[i]);
        }
        _qualifyCommands(p.instructions);
        commandsHash = keccak256(abi.encode(p.instructions));
        if (FACTORY.codehash != 0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5) revert DeploymentChanged();
        _pin(FACTORY); _pin(USDG); _pin(DIAMOND); _pin(FEE); _pin(ROUTER); _pin(ROUTER_TWO); _pin(MATH_ONE); _pin(MATH_TWO);
        if (t.funding == 2) _pin(t.delegationManager);
    }

    function cancel() external { if (msg.sender != owner) revert Denied(); cancelled = true; emit Cancelled(); }
    function active() public view returns (bool) {
        return !cancelled && !IPlanRegistry(registry).cancelled(address(this)) && block.timestamp <= expiry && runs < maxRuns;
    }

    function _distance(uint256 a, uint256 b) private pure returns (uint256) { return a > b ? a - b : b - a; }
    function _token(address a) private view returns (bool) { if (a == USDG) return true; for (uint256 i; i < legs.length; i++) if (legs[i].token == a) return true; return false; }
    function _pin(address a) private { if (a.code.length == 0) revert DeploymentChanged(); pinnedAddresses.push(a); pinnedCodeHashes.push(a.codehash); }
    function _checkProxy() private view { if (IComposerProxy(proxy).owner() != address(this) || IComposerProxy(proxy).factory() != FACTORY) revert DeploymentChanged(); }

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
        if (s == 0x095ea7b3) {
            (address spender, uint256 amount) = abi.decode(_tail(data), (address, uint256));
            if (spender != DIAMOND) revert ProfileViolation(62);
            bool known; for (uint256 i; i < legs.length; i++) if (legs[i].input == amount) known = true;
            if (!known) revert ProfileViolation(63);
            _equal(data, abi.encodeWithSignature("approve(address,uint256)", spender, amount), 64); return;
        }
        // Frozen arithmetic/partition ABI data, with its exact hash pinned. A balanceOf(proxy) here
        // would name the plan and is rejected: it must sit in proxyBalanceSlot.
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
            if (i == signerSlot) _equal(mem.state[i], abi.encode(address(this)), 9);
            else if (i == proxyBalanceSlot) _equal(mem.state[i], _body(abi.encodeWithSignature("balanceOf(address)", proxy)), 10);
            else if (i == contextSlot) _equal(mem.state[i], abi.encode(context), 7);
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

    /// Anyone (the keeper) may trigger a due run. Funding, Composer execution and delivery to the
    /// recipient happen in this one call; any failure reverts all of it, including (B) enforcer counters.
    function run(address target, bytes calldata data, bytes calldata permissionContext) external {
        if (locked) revert Denied();
        if (!active()) revert Inactive();
        if (block.timestamp < start) revert NotDue();
        uint256 window = (block.timestamp - start) / period;
        if (runs != 0 && (window <= lastWindow || block.timestamp < lastExecution + period)) revert NotDue();
        validate(target, data);
        locked = true; runs++; lastWindow = window; lastExecution = block.timestamp;

        uint256 planInputBefore = IERC20(USDG).balanceOf(address(this));
        uint256[] memory planBefore = new uint256[](legs.length);
        uint256[] memory recipientBefore = new uint256[](legs.length);
        for (uint256 i; i < legs.length; i++) {
            planBefore[i] = IERC20(legs[i].token).balanceOf(address(this));
            recipientBefore[i] = IERC20(legs[i].token).balanceOf(recipient);
        }
        _fund(planInputBefore, permissionContext);
        _execute(target, data, planInputBefore);
        uint256[] memory delivered = _deliver(planBefore, recipientBefore);
        _checkProxy();
        if (proxyCodeHash != bytes32(0) && proxy.codehash != proxyCodeHash) revert DeploymentChanged();
        proxyCodeHash = proxy.codehash; locked = false;
        emit Purchased(runs, window, keccak256(data), delivered);
    }

    /// 1. Fund exactly the swapped share (a retained USDG share never leaves the source).
    function _fund(uint256 planInputBefore, bytes calldata permissionContext) private {
        IERC20 input = IERC20(USDG);
        uint256 sourceBefore = input.balanceOf(source);
        if (funding == 1) {
            if (!input.transferFrom(source, address(this), swapAmount)) revert FundingMismatch();
        } else {
            bytes[] memory contexts = new bytes[](1); contexts[0] = permissionContext;
            bytes32[] memory modes = new bytes32[](1);
            bytes[] memory executions = new bytes[](1);
            executions[0] = abi.encodePacked(USDG, uint256(0), abi.encodeCall(IERC20.transfer, (address(this), swapAmount)));
            IDelegationManager(delegationManager).redeemDelegations(contexts, modes, executions);
        }
        if (input.balanceOf(address(this)) != planInputBefore + swapAmount || sourceBefore - input.balanceOf(source) != swapAmount) revert FundingMismatch();
    }

    /// 2. Composer program, with the plan as signer and an exact, temporary proxy allowance.
    function _execute(address target, bytes calldata data, uint256 planInputBefore) private {
        IERC20 input = IERC20(USDG);
        uint256 ethBefore = address(this).balance;
        input.approve(proxy, 0);
        input.approve(proxy, swapAmount);
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        input.approve(proxy, 0);
        if (input.balanceOf(address(this)) != planInputBefore || input.allowance(address(this), proxy) != 0 || address(this).balance != ethBefore) revert InputDelta();
    }

    /// 3. Deliver every purchased token to the recipient.
    function _deliver(uint256[] memory planBefore, uint256[] memory recipientBefore) private returns (uint256[] memory delivered) {
        delivered = new uint256[](legs.length);
        for (uint256 i; i < legs.length; i++) {
            IERC20 token = IERC20(legs[i].token);
            uint256 minimum = legs[i].minimum;
            uint256 received = token.balanceOf(address(this)) - planBefore[i];
            if (received < minimum || token.allowance(address(this), proxy) != 0) revert OutputMinimum();
            if (!token.transfer(recipient, received)) revert Residue();
            if (token.balanceOf(address(this)) != planBefore[i] || token.balanceOf(recipient) - recipientBefore[i] < minimum) revert Residue();
            delivered[i] = received;
        }
    }

    function _equal(bytes memory a, bytes memory b, uint256 field) private pure { if (keccak256(a) != keccak256(b)) revert ProfileViolation(field); }
    function _selector(bytes memory a) private pure returns (bytes4 s) { if (a.length < 4) revert ProfileViolation(40); assembly { s := mload(add(a, 32)) } }
    function _tail(bytes memory a) private pure returns (bytes memory b) { b = new bytes(a.length - 4); for (uint256 i; i < b.length; i++) b[i] = a[i + 4]; }
    function _body(bytes memory a) private pure returns (bytes memory b) { bytes memory e = abi.encode(a); b = new bytes(e.length - 32); for (uint256 i; i < b.length; i++) b[i] = e[i + 32]; }
}

interface IERC20Permit { function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external; }

/// Immutable, ownerless CREATE2 factory and cancellation registry.
contract DcaComposerPlanFactory is IPlanRegistry {
    mapping(address => bool) public cancelled;
    event Deployed(address indexed plan, address indexed owner);
    event PlanCancelled(address indexed plan, address indexed owner);
    error Denied(); error Cancelled();

    /// Spec version, chain and owner enter through the salt; plan code version, terms and the
    /// signer-independent Composer template enter through the init-code hash.
    function salt(Terms memory t, uint256 nonce) public view returns (bytes32) { return keccak256(abi.encode(uint256(1), block.chainid, t.owner, nonce)); }
    function initCodeHash(Terms memory t, Profile memory p) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(DcaComposerPlan).creationCode, abi.encode(t, p)));
    }
    function predict(Terms memory t, Profile memory p, uint256 nonce) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(t, nonce), initCodeHash(t, p))))));
    }
    function cancel(Terms memory t, Profile memory p, uint256 nonce) external {
        if (msg.sender != t.owner) revert Denied();
        address plan = predict(t, p, nonce); cancelled[plan] = true; emit PlanCancelled(plan, t.owner);
    }
    function deploy(Terms memory t, Profile memory p, uint256 nonce) public returns (DcaComposerPlan plan) {
        address predicted = predict(t, p, nonce);
        if (cancelled[predicted]) revert Cancelled();
        plan = new DcaComposerPlan{salt: salt(t, nonce)}(t, p);
        if (address(plan) != predicted) revert Denied();
        emit Deployed(address(plan), t.owner);
    }
    struct PermitSignature { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }
    function deployWithPermit(Terms memory t, Profile memory p, uint256 nonce, PermitSignature calldata sig) external returns (DcaComposerPlan plan) {
        if (t.funding != 1) revert Denied();
        plan = deploy(t, p, nonce);
        try IERC20Permit(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168).permit(t.owner, address(plan), sig.value, sig.deadline, sig.v, sig.r, sig.s) {} catch {}
        if (IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168).allowance(t.owner, address(plan)) < plan.swapAmount() * t.maxRuns) revert Denied();
    }
}
