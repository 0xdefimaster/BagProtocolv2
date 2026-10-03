import { encodeFunctionData } from 'viem';
import { UNISWAP_ROUTER_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// V11 — deterministic swap-leg builder for Robinhood Chain, replacing LI.FI
// for the redeem path (LI.FI is a cross-chain aggregator; Robinhood-only
// redemption doesn't need cross-chain routing, and LI.FI's calldata isn't
// composable through RedeemFeeRouter's fee-enforcement wrapper — see
// docs/FINAL_PRODUCTION_AUDIT.md's blocker #1 history for why this exists).
//
// Produces ONLY calldata for `UNISWAP_ROUTER_ADDRESS` (SwapRouter02 on
// Robinhood Chain — verified, see lib/config/robinhood-chain.ts's module
// doc) — never an arbitrary target. This is intentionally the ONLY
// supported swap target for this builder; RedeemFeeRouter's own
// `isAllowedSwapTarget` allowlist is the second, independent, on-chain
// enforcement of the same constraint (defense in depth — this builder
// refusing to target anything else is a convenience/safety net, not the
// actual security boundary).
//
// NOT INDEPENDENTLY VERIFIED THIS SESSION: the exact current ABI shape of
// the deployed `SwapRouter02.exactInputSingle` struct (specifically,
// whether it still omits `deadline` the way the widely-documented
// `@uniswap/swap-router-contracts` package does, relying on
// `multicall(deadline, data[])` for deadline enforcement instead of a
// per-call field). This sandbox has no RPC access to read the deployed
// bytecode/verify the exact selector against Robinhood Chain directly
// (see docs/FINAL_PRODUCTION_AUDIT.md). RedeemFeeRouter's OWN deadline
// check (`p.deadline`, enforced before any swap is attempted) means an
// incorrect assumption here fails a real swap call, not a security
// property — but this must be confirmed against the live contract (or
// its verified source on the Robinhood Chain explorer) before production
// use. Flagged explicitly rather than silently assumed correct.
// -----------------------------------------------------------------------------

const SWAP_ROUTER_02_ABI = [
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
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

/** The three fee tiers Uniswap v3 pools on Robinhood Chain are expected to use, most-common first — matches the standard set Uniswap v3 supports on every chain. Not itself independently verified per-pair this session (see module doc); a real integration should resolve the actual existing pool via `UNISWAP_V3_FACTORY_ADDRESS.getPool(tokenA, tokenB, fee)` rather than assuming one blindly. */
export const COMMON_FEE_TIERS = [3000, 500, 10000] as const;

export interface SwapLegInput {
  inputToken: `0x${string}`;
  inputAmount: bigint;
  outputToken: `0x${string}`;
  /** Where the swap output should land — for a `RedeemFeeRouter` leg, this MUST be the router's own address, since the router (not the user) is `msg.sender` calling this swap and needs to hold the proceeds to compute the fee split. */
  recipient: `0x${string}`;
  minOutput: bigint;
  /** Uniswap v3 fee tier (hundredths of a bip — 3000 = 0.3%). Caller must resolve which tier actually has liquidity for this pair; this builder does not guess one for you beyond the `feeTier` you pass. */
  feeTier: number;
}

export interface SwapLeg {
  swapTarget: `0x${string}`;
  swapCallData: `0x${string}`;
}

export class UniswapRouterNotConfiguredError extends Error {
  constructor() {
    super(
      'UNISWAP_ROUTER_ADDRESS is not configured — cannot build a Robinhood Chain swap leg. ' +
        'See lib/config/robinhood-chain.ts.'
    );
    this.name = 'UniswapRouterNotConfiguredError';
  }
}

export class SameTokenSwapError extends Error {
  constructor(token: string) {
    super(`inputToken and outputToken are both ${token} — use a "no swap" leg (swapTarget = zeroAddress) instead of building a same-token swap.`);
    this.name = 'SameTokenSwapError';
  }
}

/**
 * Builds a `RedeemFeeRouter.RedeemLeg`-compatible `{ swapTarget, swapCallData }`
 * pair for a single input asset, targeting the verified Robinhood Chain
 * SwapRouter02. Deterministic: same input always produces the same
 * calldata (no randomness, no external API call, no LI.FI dependency).
 *
 * Fails closed (throws) rather than returning a best-guess target if
 * `UNISWAP_ROUTER_ADDRESS` is ever unset again (e.g. a future config
 * rollback) — never silently falls back to an unverified/invented address.
 */
export function buildRobinhoodSwapLeg(input: SwapLegInput): SwapLeg {
  if (!UNISWAP_ROUTER_ADDRESS) throw new UniswapRouterNotConfiguredError();
  if (input.inputToken.toLowerCase() === input.outputToken.toLowerCase()) {
    throw new SameTokenSwapError(input.inputToken);
  }

  const swapCallData = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: input.inputToken,
        tokenOut: input.outputToken,
        fee: input.feeTier,
        recipient: input.recipient,
        amountIn: input.inputAmount,
        amountOutMinimum: input.minOutput,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });

  return { swapTarget: UNISWAP_ROUTER_ADDRESS, swapCallData };
}

/** Re-exported so callers building a full multi-leg redemption plan have the factory address available for pool/liquidity resolution without a second import from the config module. */
export { UNISWAP_V3_FACTORY_ADDRESS };
