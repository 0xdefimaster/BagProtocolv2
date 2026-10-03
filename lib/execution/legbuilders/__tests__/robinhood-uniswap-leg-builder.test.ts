import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import {
  createRobinhoodUniswapLegBuilder,
  NoLiquidityError,
  SameTokenLegError,
  UnverifiedTokenError,
  WrongChainError,
  UniswapQuoter,
} from '../robinhood-uniswap-leg-builder';
import { UNISWAP_ROUTER_ADDRESS } from '@/lib/config/robinhood-chain';
import { BagExecutionGraph, BagExecutionLeg } from '../../types';

// -----------------------------------------------------------------------------
// No RPC, no live chain — `quote` is fully mocked. What this proves:
//   1. Correct calldata shape/target (SwapRouter02.exactInputSingle).
//   2. Canonical-registry enforcement (refuses tokens not in the injected
//      allow-set) — item 2's "arbitrary token kabul etme" requirement.
//   3. Fee-tier fallback when the first tier has no liquidity.
//   4. Slippage math (minAmountOut) is computed, never fabricated/omitted.
// A real end-to-end quote against Robinhood Chain mainnet is OUT OF SCOPE
// for this suite — see docs/PHASE_19X_REPORT.md for why this sandbox has
// no RPC access, and robinhood-uniswap-quoter.ts's own doc.
// -----------------------------------------------------------------------------

const ROUTER: Hex = '0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const USDG: Hex = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const BTC: Hex = '0x1111111111111111111111111111111111111111';
const UNVERIFIED: Hex = '0x9999999999999999999999999999999999999999';

function makeLeg(overrides: Partial<BagExecutionLeg> = {}): BagExecutionLeg {
  return {
    id: 'leg_0',
    sourceAsset: { chain: 'robinhood', address: USDG },
    targetAsset: { chain: 'robinhood', address: BTC },
    amountRaw: '1000000',
    weightBps: 10000,
    minimumOutputRaw: null,
    slippageBps: 100, // 1%
    chain: 'robinhood',
    dependsOn: [],
    ...overrides,
  };
}

function makeGraph(overrides: Partial<BagExecutionGraph> = {}): BagExecutionGraph {
  return {
    bagId: 'bag_1',
    wallet: '0x6666666666666666666666666666666666666666',
    chainId: 'robinhood',
    inputAsset: { chain: 'robinhood', address: USDG },
    inputAmountRaw: '1000000',
    legs: [makeLeg()],
    unallocatedRaw: '0',
    ...overrides,
  };
}

const CANONICAL = new Set([`robinhood:${USDG}`, `robinhood:${BTC}`]);

function baseConfig(quote: UniswapQuoter) {
  return {
    routerAddress: ROUTER,
    isCanonicalToken: (identity: { chain: string; address: string }) =>
      CANONICAL.has(`${identity.chain}:${identity.address.toLowerCase()}`),
    quote,
  };
}

describe('createRobinhoodUniswapLegBuilder', () => {
  it('builds SwapRouter02.exactInputSingle calldata targeting UNISWAP_ROUTER_ADDRESS, output routed to the router', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(2_000_000) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph();
    const built = await build(graph.legs[0], graph);

    expect(built.target).toBe(UNISWAP_ROUTER_ADDRESS);
    expect(built.approveToken.toLowerCase()).toBe(USDG.toLowerCase());
    expect(built.approveAmount).toBe(BigInt(1_000_000));
    expect(built.value).toBe(BigInt(0));

    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'exactInputSingle',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'params',
              type: 'tuple',
              components: [
                { name: 'tokenIn', type: 'address' },
                { name: 'tokenOut', type: 'address' },
                { name: 'fee', type: 'uint24' },
                { name: 'recipient', type: 'address' },
                { name: 'amountIn', type: 'uint256' },
                { name: 'amountOutMinimum', type: 'uint256' },
                { name: 'sqrtPriceLimitX96', type: 'uint160' },
              ],
            },
          ],
          outputs: [],
        },
      ] as const,
      data: built.callData,
    });
    const params = decoded.args[0];
    expect(params.tokenIn.toLowerCase()).toBe(USDG.toLowerCase());
    expect(params.tokenOut.toLowerCase()).toBe(BTC.toLowerCase());
    expect(params.recipient.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(params.amountIn).toBe(BigInt(1_000_000));
    // 2,000,000 output, 1% slippage -> minimum 1,980,000.
    expect(params.amountOutMinimum).toBe(BigInt(1_980_000));
  });

  it('applies slippageBps to compute the guaranteed minimum, never using the raw quote as the minimum — and reports the quote separately', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(1_000_000) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph({ legs: [makeLeg({ slippageBps: 250 })] });
    const built = await build(graph.legs[0], graph);
    expect(built.minimumGuaranteedOutputRaw).toBe('975000');
    expect(built.quotedOutputRaw).toBe('1000000');
  });

  it('tries the next fee tier when the first has no liquidity, and passes the winning tier through to calldata', async () => {
    const seen: number[] = [];
    const quote: UniswapQuoter = vi.fn(async ({ feeTier }) => {
      seen.push(feeTier);
      if (feeTier === 3000) return null; // no pool at 0.3%
      return { amountOut: BigInt(500_000) };
    });
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph();
    const built = await build(graph.legs[0], graph);

    expect(seen[0]).toBe(3000);
    expect(seen).toContain(500);

    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'exactInputSingle',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'params',
              type: 'tuple',
              components: [
                { name: 'tokenIn', type: 'address' },
                { name: 'tokenOut', type: 'address' },
                { name: 'fee', type: 'uint24' },
                { name: 'recipient', type: 'address' },
                { name: 'amountIn', type: 'uint256' },
                { name: 'amountOutMinimum', type: 'uint256' },
                { name: 'sqrtPriceLimitX96', type: 'uint160' },
              ],
            },
          ],
          outputs: [],
        },
      ] as const,
      data: built.callData,
    });
    expect(decoded.args[0].fee).toBe(500);
  });

  it('throws NoLiquidityError when every fee tier comes back with no pool', async () => {
    const quote: UniswapQuoter = vi.fn(async () => null);
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph();
    await expect(build(graph.legs[0], graph)).rejects.toBeInstanceOf(NoLiquidityError);
  });

  it('refuses a sourceAsset that is not in the canonical registry — never accepts an arbitrary/client-injected token', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(1) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph({ legs: [makeLeg({ sourceAsset: { chain: 'robinhood', address: UNVERIFIED } })] });
    await expect(build(graph.legs[0], graph)).rejects.toBeInstanceOf(UnverifiedTokenError);
    expect(quote).not.toHaveBeenCalled();
  });

  it('refuses a targetAsset that is not in the canonical registry', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(1) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph({ legs: [makeLeg({ targetAsset: { chain: 'robinhood', address: UNVERIFIED } })] });
    await expect(build(graph.legs[0], graph)).rejects.toBeInstanceOf(UnverifiedTokenError);
  });

  it('refuses a graph on any chain other than robinhood', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(1) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph({ chainId: 'base' });
    await expect(build(graph.legs[0], graph)).rejects.toBeInstanceOf(WrongChainError);
  });

  it('refuses a same-token leg', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(1) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph({ legs: [makeLeg({ targetAsset: { chain: 'robinhood', address: USDG } })] });
    await expect(build(graph.legs[0], graph)).rejects.toBeInstanceOf(SameTokenLegError);
  });

  it('rejects a zero/negative amountRaw leg rather than building a no-op swap', async () => {
    const quote = vi.fn(async () => ({ amountOut: BigInt(1) }));
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph({ legs: [makeLeg({ amountRaw: '0' })] });
    await expect(build(graph.legs[0], graph)).rejects.toThrow(/amountRaw must be > 0/);
  });

  it('propagates a real quoting error (not a liquidity issue) instead of masking it as NoLiquidityError', async () => {
    const quote: UniswapQuoter = vi.fn(async () => {
      throw new Error('RPC timeout');
    });
    const build = createRobinhoodUniswapLegBuilder(baseConfig(quote));
    const graph = makeGraph();
    await expect(build(graph.legs[0], graph)).rejects.toThrow('RPC timeout');
  });
});
