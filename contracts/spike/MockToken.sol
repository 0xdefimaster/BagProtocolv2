// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockToken
/// @notice A plain mintable ERC-20, deployed and minted by us on Robinhood
/// Chain Testnet only. Has no real-world value. Exists so Phase 19.X-A can
/// seed its own two test pools without depending on any third-party
/// testnet token/DEX deployment we could not independently verify (see the
/// Phase 19.X-A report's Step-0 section on testnet liquidity).
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Anyone can mint. Deliberately unrestricted: this token is
    /// only ever meant to exist on testnet, only ever meant to back the
    /// spike's own seeded pools, and must never be mistaken for anything
    /// with value. Do not deploy this contract to mainnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
