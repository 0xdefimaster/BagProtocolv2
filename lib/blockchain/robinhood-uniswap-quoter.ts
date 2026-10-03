import type { PublicClient, Hex } from 'viem';
import { UNISWAP_QUOTER_V2_ADDRESS } from '@/lib/config/robinhood-chain';
import type { UniswapQuoter } from '@/lib/execution/legbuilders/robinhood-uniswap-leg-builder';

// -----------------------------------------------------------------------------
// lib/blockchain/robinhood-uniswap-quoter.ts
//
// The REAL on-chain half of `UniswapQuoter` (see
// lib/execution/legbuilders/robinhood-uniswap-leg-builder.ts's doc on why
// quoting is injected rather than owned by the leg builder itself).
//
// QuoterV2.quoteExactInputSingle is marked non-view on-chain (it writes to
// storage internally to get exact tick-crossing gas costs, then the whole
// call is meant to be run as an `eth_call`/simulation, never as a real
// state-changing transaction) — so this MUST go through
// `publicClient.simulateContract`, never `writeContract`/`sendTransaction`.
//
// SANDBOX NOTE: this file has NOT been exercised against a live RPC
// endpoint in this session — this container's network egress allowlist
// does not include any Robinhood Chain RPC host (see
// docs/PHASE_19X_REPORT.md's own `curl` 403 finding against
// rpc.mainnet.chain.robinhood.com, same restriction applies here). The
// code path is written to the real QuoterV2 ABI and is unit-testable with
// an injected/mocked `PublicClient` (see
// __tests__/robinhood-uniswap-quoter.test.ts), but "compiles and has a
// passing unit test against a mock" is not the same claim as "verified
// against the live contract" — do not report this as PASS against real
// liquidity until it has actually been run with real RPC access.
// -----------------------------------------------------------------------------

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

/**
 * Builds the real `UniswapQuoter` from a `viem` `PublicClient`. A pool that
 * doesn't exist (or has zero liquidity for the requested size) reverts on
 * `simulateContract` — that revert is caught here and normalized to `null`
 * ("try the next fee tier"), matching `UniswapQuoter`'s contract. Any OTHER
 * error (RPC failure, malformed args, wrong chain) is re-thrown, since that
 * is not a "no liquidity" case and must not be silently swallowed into a
 * fee-tier skip.
 */
export function createRobinhoodUniswapQuoter(publicClient: PublicClient): UniswapQuoter {
  if (!UNISWAP_QUOTER_V2_ADDRESS) {
    throw new Error('createRobinhoodUniswapQuoter: UNISWAP_QUOTER_V2_ADDRESS is not configured.');
  }
  const quoterAddress = UNISWAP_QUOTER_V2_ADDRESS;

  return async function quote({ tokenIn, tokenOut, amountIn, feeTier }) {
    try {
      const { result } = await publicClient.simulateContract({
        address: quoterAddress,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee: feeTier,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      });
      const [amountOut] = result as readonly [bigint, bigint, number, bigint];
      return { amountOut };
    } catch (err) {
      // Distinguish "pool doesn't exist / no liquidity" (a normal,
      // expected revert we should treat as "try next fee tier") from a
      // real infrastructure failure. viem wraps contract reverts in a
      // `ContractFunctionExecutionError`/`ContractFunctionRevertedError`
      // chain; anything that isn't recognizably a revert is re-thrown.
      if (isLikelyPoolRevert(err)) return null;
      throw err;
    }
  };
}

function isLikelyPoolRevert(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // QuoterV2 reverts with no reason string (or an OOG-style revert) when a
  // pool for the (token, token, fee) triple simply doesn't exist — there
  // is no distinguishing custom error to switch on here without a live
  // contract to confirm its exact revert data, hence the conservative
  // substring match rather than a specific selector decode (documented
  // sandbox limitation above).
  return /revert|execution reverted/i.test(message);
}

export type { Hex };
