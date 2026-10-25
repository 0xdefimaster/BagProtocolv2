// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

// RESEARCH ONLY. Copy of scripts/research/usdg-composer/contracts/LocalArbSysRead.sol (repo commit
// e6bdd10), pragma lowered to the prototype compiler. Hardhat's L1 EVM does not execute Nitro's
// native ArbSys precompile; only arbBlockNumber() is modeled, everything else reverts.
contract LocalArbSysRead {
    error UnsupportedArbSysSelector(bytes4 selector);
    function arbBlockNumber() external view returns (uint256) { return block.number; }
    fallback() external { revert UnsupportedArbSysSelector(msg.sig); }
}
