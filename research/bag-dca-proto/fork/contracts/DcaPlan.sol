// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @notice RESEARCH PROTOTYPE ONLY (authorization model comparison). Not audited, not a
/// production contract. One plan per owner and term set; every term is immutable and part of
/// the CREATE2 init code. The swap is a single opaque call to one pinned router; the real
/// Composer template checks from BasketPurchase.sol are deliberately out of scope here.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}
interface IDelegationManager {
    function redeemDelegations(bytes[] calldata, bytes32[] calldata, bytes[] calldata) external;
}
interface IPlanRegistry { function cancelled(address) external view returns (bool); }

struct PlanTerms {
    uint8 funding;              // 1 = EOA allowance (A), 2 = smart-account delegation (B)
    address owner;              // user EOA: the only address that can cancel
    address source;             // A: the owner EOA; B: the owner's smart account
    address recipient;          // where purchased tokens are delivered
    address inputToken;         // USDG
    address outputToken;
    address router;             // the only external call target
    address delegationManager;  // B only
    bytes32 definitionHash;     // BAG strategy definition
    uint256 grossPerRun;
    uint256 maxRuns;
    uint256 start;
    uint256 period;
    uint256 expiry;
    uint256 minOutPerRun;       // prototype price rule: fixed floor
}

contract DcaPlan {
    uint256 public constant SPEC_VERSION = 1;
    address public immutable registry;
    uint8 public immutable funding;
    address public immutable owner;
    address public immutable source;
    address public immutable recipient;
    address public immutable inputToken;
    address public immutable outputToken;
    address public immutable router;
    address public immutable delegationManager;
    bytes32 public immutable definitionHash;
    uint256 public immutable grossPerRun;
    uint256 public immutable maxRuns;
    uint256 public immutable start;
    uint256 public immutable period;
    uint256 public immutable expiry;
    uint256 public immutable minOutPerRun;

    uint256 public runs;
    uint256 public lastWindow;
    uint256 public lastExecution;
    bool public cancelled;
    bool private locked;

    event Purchased(uint256 indexed run, uint256 window, uint256 spent, uint256 received);
    event Cancelled();
    error Denied(); error NotDue(); error Inactive(); error FundingMismatch(); error OutputMinimum(); error Residue();

    constructor(PlanTerms memory t) {
        if ((t.funding != 1 && t.funding != 2) || t.owner == address(0) || t.recipient == address(0) || t.router == address(0) ||
            t.grossPerRun == 0 || t.maxRuns == 0 || t.period == 0 || t.expiry <= t.start || t.minOutPerRun == 0 ||
            (t.funding == 1 && t.source != t.owner) || (t.funding == 2 && t.delegationManager == address(0))) revert Denied();
        registry = msg.sender;
        if (IPlanRegistry(msg.sender).cancelled(address(this))) revert Inactive();
        funding = t.funding; owner = t.owner; source = t.source; recipient = t.recipient;
        inputToken = t.inputToken; outputToken = t.outputToken; router = t.router; delegationManager = t.delegationManager;
        definitionHash = t.definitionHash; grossPerRun = t.grossPerRun; maxRuns = t.maxRuns;
        start = t.start; period = t.period; expiry = t.expiry; minOutPerRun = t.minOutPerRun;
    }

    /// Permanent. A later allowance, permit or re-approval cannot revive a cancelled plan.
    function cancel() external {
        if (msg.sender != owner) revert Denied();
        cancelled = true;
        emit Cancelled();
    }

    function active() public view returns (bool) {
        return !cancelled && !IPlanRegistry(registry).cancelled(address(this)) && block.timestamp <= expiry && runs < maxRuns;
    }

    /// Anyone (the keeper) may trigger a due run. Funding, swap and delivery happen in this one
    /// call; any failure reverts the transfer, approvals, plan counters and (B) enforcer counters.
    function run(bytes calldata swapData, bytes calldata permissionContext) external {
        if (locked) revert Denied();
        if (!active()) revert Inactive();
        if (block.timestamp < start) revert NotDue();
        uint256 window = (block.timestamp - start) / period;
        if (runs != 0 && (window <= lastWindow || block.timestamp < lastExecution + period)) revert NotDue();
        locked = true; runs++; lastWindow = window; lastExecution = block.timestamp;

        IERC20 input = IERC20(inputToken);
        IERC20 output = IERC20(outputToken);
        uint256 inputBefore = input.balanceOf(address(this));
        uint256 outputBefore = output.balanceOf(address(this));
        uint256 recipientBefore = output.balanceOf(recipient);
        uint256 sourceBefore = input.balanceOf(source);

        if (funding == 1) {
            if (!input.transferFrom(source, address(this), grossPerRun)) revert FundingMismatch();
        } else {
            bytes[] memory contexts = new bytes[](1); contexts[0] = permissionContext;
            bytes32[] memory modes = new bytes32[](1); // single call, default execution
            bytes[] memory executions = new bytes[](1);
            executions[0] = abi.encodePacked(inputToken, uint256(0), abi.encodeCall(IERC20.transfer, (address(this), grossPerRun)));
            IDelegationManager(delegationManager).redeemDelegations(contexts, modes, executions);
        }
        if (input.balanceOf(address(this)) != inputBefore + grossPerRun || sourceBefore - input.balanceOf(source) != grossPerRun) revert FundingMismatch();

        input.approve(router, grossPerRun);
        (bool ok, bytes memory reason) = router.call(swapData);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        input.approve(router, 0);
        if (input.balanceOf(address(this)) != inputBefore || input.allowance(address(this), router) != 0) revert Residue();

        uint256 received = output.balanceOf(address(this)) - outputBefore;
        if (received < minOutPerRun) revert OutputMinimum();
        if (!output.transfer(recipient, received)) revert Residue();
        if (output.balanceOf(recipient) - recipientBefore < received || output.balanceOf(address(this)) != outputBefore) revert Residue();
        locked = false;
        emit Purchased(runs, window, grossPerRun, received);
    }
}

interface IERC20Permit {
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
}

/// Immutable, ownerless factory and cancellation registry.
contract DcaPlanFactory is IPlanRegistry {
    mapping(address => bool) public cancelled;
    event Deployed(address indexed plan, address indexed owner);
    event PlanCancelled(address indexed plan, address indexed owner);
    error Denied(); error Cancelled();

    function salt(PlanTerms memory t, uint256 nonce) public view returns (bytes32) {
        // The plan code version enters the address through the init-code hash; the spec version,
        // chain and owner enter through the salt.
        return keccak256(abi.encode(uint256(1), block.chainid, t.owner, nonce));
    }
    function predict(PlanTerms memory t, uint256 nonce) public view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(DcaPlan).creationCode, abi.encode(t)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(t, nonce), initHash)))));
    }
    /// Works before or after deployment. Only the plan owner can cancel.
    function cancel(PlanTerms memory t, uint256 nonce) external {
        if (msg.sender != t.owner) revert Denied();
        address plan = predict(t, nonce);
        cancelled[plan] = true;
        emit PlanCancelled(plan, t.owner);
    }
    function deploy(PlanTerms memory t, uint256 nonce) public returns (DcaPlan plan) {
        address predicted = predict(t, nonce);
        if (cancelled[predicted]) revert Cancelled();
        plan = new DcaPlan{salt: salt(t, nonce)}(t);
        if (address(plan) != predicted) revert Denied();
        emit Deployed(address(plan), t.owner);
    }
    /// Model A one-signature setup. A permit already submitted by someone else is not an error;
    /// the allowance is checked instead (front-running a permit only consumes its nonce).
    function deployWithPermit(PlanTerms memory t, uint256 nonce, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external returns (DcaPlan plan)
    {
        if (t.funding != 1) revert Denied();
        plan = deploy(t, nonce);
        try IERC20Permit(t.inputToken).permit(t.owner, address(plan), value, deadline, v, r, s) {} catch {}
        if (IERC20(t.inputToken).allowance(t.owner, address(plan)) < t.grossPerRun * t.maxRuns) revert Denied();
    }
}
