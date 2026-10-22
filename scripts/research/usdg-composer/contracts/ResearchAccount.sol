// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// RESEARCH ONLY: minimal account, EntryPoint and ECDSA helper.
// No production wallet conformance or ERC-4337 bundler compatibility claim.
struct PackedUserOperation {
    address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits;
    uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature;
}
interface ISmartSessionLocal { function validateUserOp(PackedUserOperation calldata op, bytes32 hash) external returns (uint256); }
interface ILocalAccount { function validateUserOp(PackedUserOperation calldata op, bytes32 hash) external returns(uint256); }
interface IModuleCall { function onInstall(bytes calldata data) external; }

contract LocalEntryPointHarness {
    mapping(address => uint256) public nonce;
    event OperationResult(bytes32 indexed hash, address indexed sender, uint256 nonce, bool success, bytes result);
    function getUserOpHash(PackedUserOperation calldata op) public view returns(bytes32) {
        bytes32 packed = keccak256(abi.encode(op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData),
            op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)));
        return keccak256(abi.encode(packed, address(this), block.chainid));
    }
    function handle(PackedUserOperation calldata op) external returns(bool success) {
        require(op.nonce == nonce[op.sender], "NONCE");
        bytes32 hash = getUserOpHash(op);
        uint256 vd = ILocalAccount(op.sender).validateUserOp(op, hash);
        require(uint160(vd) == 0, "SESSION_SIGNATURE");
        uint48 until = uint48(vd >> 160); uint48 afterTs = uint48(vd >> 208);
        require(block.timestamp >= afterTs && (until == 0 || block.timestamp <= until), "SESSION_TIME");
        nonce[op.sender]++;
        bytes memory result;
        (success, result) = op.sender.call(op.callData);
        // Like ERC-4337, execution revert does not undo successful validation state/nonce.
        emit OperationResult(hash, op.sender, op.nonce, success, result);
    }
}
contract LocalSessionSignerValidator {
    function validateSignatureWithData(bytes32 hash, bytes calldata sig, bytes calldata data) external pure returns(bool) {
        if(sig.length != 65 || data.length != 20) return false;
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset,32)) v := byte(0, calldataload(add(sig.offset,64))) }
        return ecrecover(hash, v, r, s) == address(bytes20(data));
    }
    function isModuleType(uint256 id) external pure returns(bool) { return id == 7; }
    function isInitialized(address) external pure returns(bool) { return true; }
    function onInstall(bytes calldata) external {}
    function onUninstall(bytes calldata) external {}
}
contract Local7579Account {
    address public immutable owner; address public immutable entryPoint; address public immutable validator;
    address public executor; bool private executing;
    constructor(address o, address ep, address v) { owner=o; entryPoint=ep; validator=v; }
    function ownerCall(address target, bytes calldata data) external returns(bytes memory ret) {
        require(msg.sender==owner, "OWNER"); bool ok; (ok,ret)=target.call(data); if(!ok) assembly { revert(add(ret,32),mload(ret)) }
    }
    function installValidator() external { require(msg.sender==owner,"OWNER"); IModuleCall(validator).onInstall(""); }
    function setExecutor(address e) external { require(msg.sender==owner,"OWNER"); executor=e; }
    function isModuleInstalled(uint256 id, address module, bytes calldata) external view returns(bool) { return id==1 && module==validator; }
    function validateUserOp(PackedUserOperation calldata op, bytes32 hash) external returns(uint256) {
        require(msg.sender==entryPoint,"ENTRY_POINT"); return ISmartSessionLocal(validator).validateUserOp(op,hash);
    }
    function execute(bytes32 mode, bytes calldata data) external {
        require(msg.sender==entryPoint || msg.sender==owner,"AUTH"); require(mode==bytes32(0),"SINGLE_DEFAULT_ONLY");
        executing=true; _call(data); executing=false;
    }
    function executeFromExecutor(bytes32 mode, bytes calldata data) external returns(bytes[] memory ret) {
        require(msg.sender==executor && executing,"EXECUTOR"); require(mode==bytes32(0),"SINGLE_DEFAULT_ONLY");
        ret=new bytes[](1); ret[0]=_call(data);
    }
    function _call(bytes calldata data) private returns(bytes memory ret) {
        require(data.length>=52,"CALL_DATA");
        address target=address(bytes20(data[:20])); uint256 value=uint256(bytes32(data[20:52]));
        bool ok; (ok,ret)=target.call{value:value}(data[52:]); if(!ok) assembly { revert(add(ret,32),mload(ret)) }
    }
    receive() external payable {}
}
