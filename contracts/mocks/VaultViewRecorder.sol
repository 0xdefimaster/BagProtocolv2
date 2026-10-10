// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IVaultViews {
    function totalSupply() external view returns (uint256);
    function holdings() external view returns (uint256[] memory);
}

/// @title VaultViewRecorder
/// @notice TEST ONLY. Called from a token hook in the middle of a vault mint
/// or redeem; records what the vault's views return at that moment, to check
/// that a read-only reentrant caller never sees holdings and supply out of step.
contract VaultViewRecorder {
    IVaultViews public immutable vault;
    uint256 public seenSupply;
    uint256[] private _seenHoldings;
    bool public recorded;

    constructor(address vault_) {
        vault = IVaultViews(vault_);
    }

    function record() external {
        seenSupply = vault.totalSupply();
        _seenHoldings = vault.holdings();
        recorded = true;
    }

    function seenHoldings() external view returns (uint256[] memory) {
        return _seenHoldings;
    }
}
