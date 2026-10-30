// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {BasketIntent, ExecutionPlan, SellIntent, BasketTypes} from "../settlement/BasketTypes.sol";

/// Test-only: exposes BasketTypes so the shared vectors can be checked against Solidity.
contract BasketTypesHarness {
    function domainSeparator(uint256 chainId, address router) external pure returns (bytes32) {
        return BasketTypes.domainSeparator(chainId, router);
    }

    function hashIntent(BasketIntent calldata i) external pure returns (bytes32) {
        return BasketTypes.hashIntent(i);
    }

    function intentDigest(BasketIntent calldata i, uint256 chainId, address router) external pure returns (bytes32) {
        return BasketTypes.digest(BasketTypes.domainSeparator(chainId, router), BasketTypes.hashIntent(i));
    }

    function hashSellIntent(SellIntent calldata s) external pure returns (bytes32) {
        return BasketTypes.hashSellIntent(s);
    }

    function sellDigest(SellIntent calldata s, uint256 chainId, address router) external pure returns (bytes32) {
        return BasketTypes.digest(BasketTypes.domainSeparator(chainId, router), BasketTypes.hashSellIntent(s));
    }

    function priceLimitsHash(uint256[] calldata maxPriceX18) external pure returns (bytes32) {
        return BasketTypes.priceLimitsHash(maxPriceX18);
    }

    function holdingsHash(address[] calldata tokens, uint256[] calldata amounts) external pure returns (bytes32) {
        return BasketTypes.holdingsHash(tokens, amounts);
    }

    function planHash(ExecutionPlan calldata p) external pure returns (bytes32) {
        return BasketTypes.planHash(p);
    }

    function minOutFromPriceLimit(uint256 amountIn, uint256 maxPriceX18) external pure returns (uint256) {
        return BasketTypes.minOutFromPriceLimit(amountIn, maxPriceX18, 0);
    }

    function splitByWeight(uint256 amount, uint16[] calldata weightsBps) external pure returns (uint256[] memory) {
        return BasketTypes.splitByWeight(amount, weightsBps);
    }

    function isValidSignature(address signer, bytes32 digest, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }
}
