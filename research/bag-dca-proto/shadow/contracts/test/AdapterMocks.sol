// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { PoolKey, SwapParams } from "../ShadowAdapters.sol";

interface IUnlockCallback { function unlockCallback(bytes calldata) external returns (bytes memory); }

contract MockToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
}

/// Adversarial PoolManager: returns whatever delta the test sets, can re-enter the adapter during
/// swap, and can call the adapter's callback outside of an unlock.
contract MockPoolManager {
    int256 public nextDelta; address public reenterTarget; bytes public reenterData;
    function setDelta(int128 a0, int128 a1) external { nextDelta = int256(uint256(int256(a0)) << 128 | uint256(uint128(a1))); }
    function setReenter(address target, bytes calldata data) external { reenterTarget = target; reenterData = data; }
    function unlock(bytes calldata data) external returns (bytes memory) { return IUnlockCallback(msg.sender).unlockCallback(data); }
    function swap(PoolKey memory, SwapParams memory, bytes calldata) external returns (int256) {
        if (reenterTarget != address(0)) { (bool ok, bytes memory r) = reenterTarget.call(reenterData); if (!ok) assembly { revert(add(r, 32), mload(r)) } }
        return nextDelta;
    }
    function sync(address) external {}
    function settle() external payable returns (uint256) { return 0; }
    function take(address currency, address to, uint256 amount) external { MockToken(currency).transfer(to, amount); }
    function callbackDirect(address adapter, bytes calldata data) external returns (bytes memory) { return IUnlockCallback(adapter).unlockCallback(data); }
}
