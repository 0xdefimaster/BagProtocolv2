// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// RESEARCH ONLY. Hardhat's L1 EVM does not execute Nitro's native ArbSys precompile.
// On this fork the local EVM block height is the copied chain's L2 RPC height.
// The runner first qualifies the native getter against that pinned RPC block.
// No other ArbSys selector, gas rule, state transition or Nitro behavior is modeled.
contract LocalArbSysRead {
    error UnsupportedArbSysSelector(bytes4 selector);

    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    fallback() external {
        revert UnsupportedArbSysSelector(msg.sig);
    }
}
