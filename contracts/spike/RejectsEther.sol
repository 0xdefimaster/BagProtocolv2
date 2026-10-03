// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RejectsEther
/// @notice Test-only: a contract with no receive/fallback, so any plain ETH
/// transfer to it reverts. Used to prove BagFactory refuses to create a Bag
/// when the treasury cannot accept the creation fee.
contract RejectsEther {}
