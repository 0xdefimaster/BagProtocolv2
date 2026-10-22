// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
interface IAccountResearch { function executeFromExecutor(bytes32,bytes calldata) external returns(bytes[] memory); }
interface IERC20Research { function balanceOf(address) external view returns(uint256); function allowance(address,address) external view returns(uint256); }

// RESEARCH ONLY. The owner reviews one exact Composer transaction hash before execution.
// This is deliberately NOT a semantic validator for arbitrary future Composer programs.
contract ReviewedPurchase {
    address public immutable owner;
    address public immutable account;
    address public immutable inputToken;
    address public immutable spender;
    address public immutable factory;
    uint256 public immutable start;
    uint256 public immutable period;
    uint256 public immutable expiry;
    bytes32 public immutable definitionHash;
    bytes32 public reviewedCallHash;
    uint256 public runs;
    uint256 public grossBudgetUsed;
    bool public paused;
    address[] public outputs;
    uint256[] public minima;
    uint256 public immutable grossAmount;
    uint256 public immutable swapAmount;
    error Denied(); error NotDue(); error UnreviewedCall(); error OutputMinimum(); error InputDelta();
    constructor(address a,address token,address proxy,address f,bytes32 bagHash,uint256 due,uint256 interval,uint256 until,uint256 gross,uint256 swapped){
        owner=msg.sender;account=a;inputToken=token;spender=proxy;factory=f;definitionHash=bagHash;
        start=due;period=interval;expiry=until;grossAmount=gross;swapAmount=swapped;
    }
    function review(address target,bytes calldata data,address[] calldata tokens,uint256[] calldata amounts) external {
        if(msg.sender!=owner||runs!=0||tokens.length!=amounts.length||tokens.length!=2)revert Denied();
        if(target!=factory&&target!=spender)revert Denied();
        reviewedCallHash=keccak256(abi.encode(target,data));outputs=tokens;minima=amounts;
    }
    function setPaused(bool value) external {if(msg.sender!=owner)revert Denied();paused=value;}
    function run(address target,bytes calldata data) external {
        if(msg.sender!=account||paused||block.timestamp>expiry||runs>=1)revert Denied();
        if(block.timestamp<start+runs*period)revert NotDue();
        if(reviewedCallHash==bytes32(0)||keccak256(abi.encode(target,data))!=reviewedCallHash)revert UnreviewedCall();
        uint256 beforeInput=IERC20Research(inputToken).balanceOf(account);
        if(beforeInput<grossAmount)revert InputDelta();
        uint256[] memory beforeOutputs=new uint256[](outputs.length);
        for(uint256 i;i<outputs.length;i++)beforeOutputs[i]=IERC20Research(outputs[i]).balanceOf(account);
        runs++;grossBudgetUsed+=grossAmount;
        _call(inputToken,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        _call(inputToken,abi.encodeWithSignature("approve(address,uint256)",spender,swapAmount));
        _call(target,data);
        _call(inputToken,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        uint256 afterInput=IERC20Research(inputToken).balanceOf(account);
        if(afterInput>beforeInput||beforeInput-afterInput!=swapAmount||IERC20Research(inputToken).allowance(account,spender)!=0)revert InputDelta();
        for(uint256 i;i<outputs.length;i++)if(IERC20Research(outputs[i]).balanceOf(account)<beforeOutputs[i]+minima[i])revert OutputMinimum();
    }
    function _call(address target,bytes memory data) private {
        IAccountResearch(account).executeFromExecutor(bytes32(0),abi.encodePacked(target,uint256(0),data));
    }
}
