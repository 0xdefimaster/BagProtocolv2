// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

// RESEARCH ONLY: shadow measurement on an isolated fork. Not audited, never deployed to a network.

interface IERC20Min {
    function transferFrom(address, address, uint256) external returns (bool);
}

struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// Exact-input, single-pool Uniswap v4 swap between two ERC-20s. Router-compatible shape: the
/// caller approves THIS contract, which is also the call target, and receives the output.
contract ShadowV4Adapter {
    IPoolManager public immutable pm;
    uint160 internal constant MIN_LIMIT = 4295128740;
    uint160 internal constant MAX_LIMIT = 1461446703485210103287273052203988822378723970341;

    struct Ctx { PoolKey key; bool zeroForOne; uint256 amountIn; address payer; }

    constructor(address poolManager) { pm = IPoolManager(poolManager); }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut) external returns (uint256 out, uint256 spent) {
        require(key.currency0 != address(0), "ShadowV4Adapter:native");
        (out, spent) = abi.decode(pm.unlock(abi.encode(Ctx(key, zeroForOne, amountIn, msg.sender))), (uint256, uint256));
        require(out >= minOut, "ShadowV4Adapter:min-out");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "ShadowV4Adapter:caller");
        Ctx memory c = abi.decode(data, (Ctx));
        int256 d = pm.swap(c.key, SwapParams(c.zeroForOne, -int256(c.amountIn), c.zeroForOne ? MIN_LIMIT : MAX_LIMIT), "");
        int128 a0 = int128(d >> 128);
        int128 a1 = int128(d);
        (int128 inD, int128 outD) = c.zeroForOne ? (a0, a1) : (a1, a0);
        (address tin, address tout) = c.zeroForOne ? (c.key.currency0, c.key.currency1) : (c.key.currency1, c.key.currency0);
        uint256 spent = uint256(uint128(-inD));
        uint256 out = uint256(uint128(outD));
        pm.sync(tin);
        require(IERC20Min(tin).transferFrom(c.payer, address(pm), spent), "ShadowV4Adapter:pay");
        pm.settle();
        pm.take(tout, c.payer, out);
        return abi.encode(out, spent);
    }
}

/// Stands in for BagFactory so the existing BagExecutionRouter can run on the fork.
contract ShadowBagFactory {
    function bagOf(bytes32) external pure returns (address) { return address(1); }
}
