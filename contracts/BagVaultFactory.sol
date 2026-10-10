// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BagVault} from './BagVault.sol';

/// @title BagVaultFactory (SPIKE — not deployed, not wired to the app)
/// @notice Creates at most one `BagVault` per genuine `Bag`. Kept separate
/// from `BagFactory` on purpose: the live factory stays untouched.
///
/// Only the Bag's own creator can create its vault, and only for a Bag the
/// trusted `BagFactory` actually deployed (checked through `bagOf`). The
/// vault records the Bag's composition version and hash at creation.
///
/// What it cannot check on chain: that `tokens`/`unitAmounts` match the
/// Bag's `compositionHash`. That hash is built from a string with symbols and
/// addresses as stored (lib/domain/basket-protocol/version.ts) and is not
/// re-computable here; an off-chain verifier compares them. See
/// docs/BAG_VAULT_DESIGN.md, "Open questions".
///
/// No owner, no fee, no upgrade.
contract BagVaultFactory {
    address public immutable bagFactory;

    /// @notice Bag address → its vault.
    mapping(address => address) public vaultOf;

    error ZeroAddress();
    error NotBagCreator(address caller, address creator);
    error NotAFactoryBag(address bag);
    error VaultExists(address bag, address vault);

    event VaultCreated(address indexed bag, address indexed vault, address indexed creator, uint256 bagVersion, bytes32 compositionHash);

    constructor(address bagFactory_) {
        if (bagFactory_ == address(0)) revert ZeroAddress();
        bagFactory = bagFactory_;
    }

    function createVault(
        address bag,
        string calldata name,
        string calldata symbol,
        address[] calldata tokens,
        uint256[] calldata unitAmounts,
        address guardian
    ) external returns (address vault) {
        if (bag == address(0)) revert ZeroAddress();
        if (vaultOf[bag] != address(0)) revert VaultExists(bag, vaultOf[bag]);
        IFactoryBag b = IFactoryBag(bag);
        // A genuine Bag: deployed by the trusted BagFactory under its own id.
        if (b.factory() != bagFactory || IBagFactoryRegistry(bagFactory).bagOf(b.bagId()) != bag) revert NotAFactoryBag(bag);
        if (b.creator() != msg.sender) revert NotBagCreator(msg.sender, b.creator());

        BagVault.Config memory config = BagVault.Config({
            name: name,
            symbol: symbol,
            bag: bag,
            bagVersion: b.version(),
            compositionHash: b.compositionHash(),
            tokens: tokens,
            unitAmounts: unitAmounts,
            guardian: guardian
        });
        vault = address(new BagVault(config));
        vaultOf[bag] = vault;
        emit VaultCreated(bag, vault, msg.sender, config.bagVersion, config.compositionHash);
    }
}

interface IFactoryBag {
    function bagId() external view returns (bytes32);
    function creator() external view returns (address);
    function factory() external view returns (address);
    function version() external view returns (uint256);
    function compositionHash() external view returns (bytes32);
}

interface IBagFactoryRegistry {
    function bagOf(bytes32 bagId) external view returns (address);
}
