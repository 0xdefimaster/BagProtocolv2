// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

// ERC-4337 v0.7 PackedUserOperation.
struct PackedUserOperation {
    address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits;
    uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature;
}

/// RESEARCH, FORK ONLY. Its runtime code is placed with hardhat_setCode at a keyless address
/// (keccak256 of a published label), so on Robinhood Chain no code can ever exist there. A user
/// operation that names it in paymasterAndData (which the owner signs) can only validate on the fork.
/// No constructor, storage or immutables: the code does not depend on its own address.
/// paymasterAndData = paymaster(20) | verificationGas(16) | postOpGas(16) | validUntil(6) | validAfter(6)
contract ForkOnlyPaymaster {
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256)
        external view returns (bytes memory context, uint256 validationData)
    {
        require(msg.sender == ENTRY_POINT, "ForkOnlyPaymaster:entry-point");
        require(op.paymasterAndData.length == 64, "ForkOnlyPaymaster:data");
        uint48 validUntil = uint48(bytes6(op.paymasterAndData[52:58]));
        uint48 validAfter = uint48(bytes6(op.paymasterAndData[58:64]));
        require(validUntil != 0, "ForkOnlyPaymaster:no-expiry");
        // authorizer 0 (valid) | validUntil << 160 | validAfter << 208; EntryPoint enforces the window.
        return ("", (uint256(validUntil) << 160) | (uint256(validAfter) << 208));
    }

    function postOp(uint8, bytes calldata, uint256, uint256) external pure {}
}
