// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// -----------------------------------------------------------------------------
// BagSettlementRouter message types and their hashing (G1 of
// docs/MIGRATION_AND_ROLLOUT.md; spec: docs/BAG_SETTLEMENT_ARCHITECTURE.md).
//
// Pure definitions only: no router, no token movement. The off-chain twin is
// lib/domain/settlement/basket-types.ts; both are pinned by the shared vectors
// in contracts/test/vectors/basket-settlement-v1.json.
// -----------------------------------------------------------------------------

/// Signed by the payer (EIP-712, ECDSA or ERC-1271).
struct BasketIntent {
    address payer;
    address recipient;
    bytes32 strategyId;
    uint32 strategyVersion;
    bytes32 definitionHash;
    bytes32 compositionHash;
    address inputToken;
    uint256 maxInput;
    /// keccak256(abi.encode(uint256[] maxPriceX18)), composition order.
    bytes32 priceLimitsHash;
    uint16 maxIntegratorFeeBps;
    uint16 maxProtocolFeeBps;
    /// Unordered, single use (bitmap).
    uint256 nonce;
    uint64 deadline;
}

/// One swap of an ExecutionPlan. Supplied by the quote provider, not signed.
struct Leg {
    address tokenOut;
    uint256 amountIn;
    uint256 minOut;
    address adapter;
    bytes adapterData;
}

/// Short-lived route for one BasketIntent. Supplied by the quote provider, not signed.
struct ExecutionPlan {
    bytes32 intentHash;
    uint64 expiry;
    uint256 inputAmount;
    address integratorFeeRecipient;
    uint256 integratorFee;
    uint256 protocolFee;
    Leg[] legs;
}

/// Signed by the seller for the sale direction (EIP-712, ECDSA or ERC-1271).
struct SellIntent {
    address seller;
    address recipient;
    bytes32 strategyId;
    uint32 strategyVersion;
    /// keccak256(abi.encode(address[] tokens, uint256[] amounts)): the exact holdings sold.
    bytes32 holdingsHash;
    address outputToken;
    uint256 minGrossOutput;
    uint256 nonce;
    uint64 deadline;
}

library BasketTypes {
    string internal constant NAME = "BagSettlementRouter";
    string internal constant VERSION = "1";

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant BASKET_INTENT_TYPEHASH = keccak256(
        "BasketIntent(address payer,address recipient,bytes32 strategyId,uint32 strategyVersion,bytes32 definitionHash,bytes32 compositionHash,address inputToken,uint256 maxInput,bytes32 priceLimitsHash,uint16 maxIntegratorFeeBps,uint16 maxProtocolFeeBps,uint256 nonce,uint64 deadline)"
    );

    bytes32 internal constant SELL_INTENT_TYPEHASH = keccak256(
        "SellIntent(address seller,address recipient,bytes32 strategyId,uint32 strategyVersion,bytes32 holdingsHash,address outputToken,uint256 minGrossOutput,uint256 nonce,uint64 deadline)"
    );

    uint256 internal constant TOTAL_BPS = 10_000;
    uint256 internal constant PRICE_SCALE = 1e18;

    error InvalidPriceLimit(uint256 index);
    error BadWeights();

    function domainSeparator(uint256 chainId, address router) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), chainId, router));
    }

    /// EIP-712 digest: keccak256("\x19\x01" ‖ domainSeparator ‖ structHash).
    function digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function hashIntent(BasketIntent memory i) internal pure returns (bytes32) {
        // Every field is a static 32-byte word, so two concatenated halves equal one abi.encode
        // and keep the stack shallow.
        return keccak256(
            bytes.concat(
                abi.encode(
                    BASKET_INTENT_TYPEHASH, i.payer, i.recipient, i.strategyId, i.strategyVersion, i.definitionHash, i.compositionHash
                ),
                abi.encode(
                    i.inputToken, i.maxInput, i.priceLimitsHash, i.maxIntegratorFeeBps, i.maxProtocolFeeBps, i.nonce, i.deadline
                )
            )
        );
    }

    function hashSellIntent(SellIntent memory s) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(SELL_INTENT_TYPEHASH, s.seller, s.recipient, s.strategyId, s.strategyVersion, s.holdingsHash),
                abi.encode(s.outputToken, s.minGrossOutput, s.nonce, s.deadline)
            )
        );
    }

    function priceLimitsHash(uint256[] memory maxPriceX18) internal pure returns (bytes32) {
        return keccak256(abi.encode(maxPriceX18));
    }

    function holdingsHash(address[] memory tokens, uint256[] memory amounts) internal pure returns (bytes32) {
        return keccak256(abi.encode(tokens, amounts));
    }

    /// Emitted in BasketSettled; replay is prevented by the intent nonce, not by this hash.
    function planHash(ExecutionPlan memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// minOut = floor(amountIn × 1e18 / maxPriceX18). A zero limit is invalid (fail closed).
    function minOutFromPriceLimit(uint256 amountIn, uint256 maxPriceX18, uint256 index) internal pure returns (uint256) {
        if (maxPriceX18 == 0) revert InvalidPriceLimit(index);
        return Math.mulDiv(amountIn, PRICE_SCALE, maxPriceX18);
    }

    /// The v1 target allocation, identical to packages/bag-sdk/src/split.ts for one chain:
    /// floor shares, then one unit each to the largest remainders, ties to the lower index.
    /// `weightsBps` is in composition order (token address ascending), so a lower index is
    /// the lower address, as in the SDK's `chain:address` tie-break.
    function splitByWeight(uint256 amount, uint16[] memory weightsBps) internal pure returns (uint256[] memory parts) {
        uint256 n = weightsBps.length;
        parts = new uint256[](n);
        uint256[] memory remainders = new uint256[](n);
        uint256 total;
        uint256 assigned;
        for (uint256 k; k < n; ++k) {
            uint256 w = weightsBps[k];
            if (w == 0) revert BadWeights();
            total += w;
            (parts[k], remainders[k]) = (Math.mulDiv(amount, w, TOTAL_BPS), mulmod(amount, w, TOTAL_BPS));
            assigned += parts[k];
        }
        if (total != TOTAL_BPS) revert BadWeights();
        bool[] memory taken = new bool[](n);
        // Fewer than n units are left over; each goes to the largest remaining remainder.
        for (uint256 left = amount - assigned; left > 0; --left) {
            uint256 best = type(uint256).max;
            for (uint256 k; k < n; ++k) {
                if (!taken[k] && (best == type(uint256).max || remainders[k] > remainders[best])) best = k;
            }
            taken[best] = true;
            ++parts[best];
        }
    }
}
