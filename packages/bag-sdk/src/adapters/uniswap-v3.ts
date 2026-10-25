import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem';
import { BAG_V1_CHAINS } from '../chains';
import { BagSdkError } from '../errors';
import {
  recurringAuthorizationId,
  recurringLegAmounts,
  recurringMinimumOutputs,
  recurringWindowAt,
  type RecurringAuthorization,
  type RecurringDeployment,
} from '../recurring';
import type { Hex } from '../types';

// -----------------------------------------------------------------------------
// Composer-free run builder for RecurringPurchaseExecutor: on-chain Uniswap v3
// quotes (QuoterV2, through the CALLER's RPC client) and SwapRouter02
// `exactInputSingle` legs for the existing BagExecutionRouter. No HTTP, no API
// key, no LI.FI. Every quote is an eth_call against the chain the caller reads.
//
// The result is UNSIGNED: the router's planSigner signs `routerPlanTypedData`,
// and the executor re-checks the plan against the owner's authorization before
// anything moves. A quote below the owner's signed price limit builds nothing.
//
// Quotes stop at the owner's limit: each QuoterV2 call carries the pool price
// of the owner's maxPrice as `sqrtPriceLimitX96`, so a thin or empty pool is
// not walked tick by tick to the end of the range, and a tier whose marginal
// price reaches the limit is unusable (conservative: its average price could
// still be inside). The swap itself is built with sqrtPriceLimitX96 = 0, which
// the executor requires (no partial fills).
// -----------------------------------------------------------------------------

/** Robinhood Chain Uniswap v3 contracts, as verified in the BAG app (lib/config/robinhood-chain.ts). */
export const ROBINHOOD_UNISWAP_V3 = Object.freeze({
  chainId: BAG_V1_CHAINS.robinhood,
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Hex,
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Hex,
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2' as Hex,
});

export const UNISWAP_V3_QUOTER_V2_ABI = [
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

export const SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI = [
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

/** BagExecutionRouter EIP-712 plan types (contracts/BagExecutionRouter.sol). */
export const BAG_ROUTER_PLAN_TYPES = {
  ExecutionPlan: [
    { name: 'bagId', type: 'bytes32' },
    { name: 'executionPlanHash', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'inputToken', type: 'address' },
    { name: 'inputAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'legs', type: 'Leg[]' },
    { name: 'minOutputs', type: 'OutputCheck[]' },
  ],
  Leg: [
    { name: 'target', type: 'address' },
    { name: 'callData', type: 'bytes' },
    { name: 'value', type: 'uint256' },
    { name: 'approveToken', type: 'address' },
    { name: 'approveAmount', type: 'uint256' },
  ],
  OutputCheck: [
    { name: 'token', type: 'address' },
    { name: 'minAmountOut', type: 'uint256' },
  ],
} as const;

export interface RouterExecutionPlan {
  bagId: Hex;
  executionPlanHash: Hex;
  wallet: Hex;
  inputToken: Hex;
  inputAmount: bigint;
  deadline: bigint;
  legs: { target: Hex; callData: Hex; value: bigint; approveToken: Hex; approveAmount: bigint }[];
  minOutputs: { token: Hex; minAmountOut: bigint }[];
}

/** Anything with viem's `simulateContract` (a viem PublicClient). The caller owns the RPC. */
export interface QuoteClient {
  simulateContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<{ result: unknown }>;
}

/** QUOTED: full amount within the limit; PRICE_LIMIT_REACHED: the marginal price hit the owner's limit (or was past it); NO_QUOTE: no pool or no liquidity. */
export type RecurringQuoteStatus = 'QUOTED' | 'PRICE_LIMIT_REACHED' | 'NO_QUOTE';

export interface RecurringRunLeg {
  asset: Hex;
  amountInRaw: bigint;
  fee: number;
  quotedOutRaw: bigint;
  /** The owner's price-limit floor: ceil(amountIn × 10^decimals / maxPriceRaw). */
  priceLimitFloorRaw: bigint;
  /** What the plan requires: max(price-limit floor, quote − slippage). */
  minimumOutRaw: bigint;
  /** The quote bound used for every tier of this asset (the owner's maxPrice as a pool price). */
  quoteSqrtPriceLimitX96: bigint;
  alternatives: { fee: number; quotedOutRaw: bigint | null; status: RecurringQuoteStatus }[];
}

export interface RecurringRunPlan {
  /** Unsigned; sign `routerPlanTypedData(plan, ...)` with the router's planSigner. */
  plan: RouterExecutionPlan;
  execution: { authorizationId: Hex; window: bigint; quoteDeadline: bigint };
  legs: RecurringRunLeg[];
  /** Quotes are eth_call results at the caller's block: SIMULATED, never execution evidence. */
  evidence: 'SIMULATED_ON_CHAIN_QUOTE';
}

const isRevert = (e: unknown): boolean => {
  for (let x: any = e; x; x = x.cause) if (x?.name === 'ContractFunctionRevertedError') return true;
  return false;
};
const revertReason = (e: unknown): string | undefined => {
  for (let x: any = e; x; x = x.cause) if (x?.name === 'ContractFunctionRevertedError') return typeof x.reason === 'string' ? x.reason : undefined;
  return undefined;
};

const MIN_SQRT_RATIO = BigInt('4295128739');
const MAX_SQRT_RATIO = BigInt('1461446703485210103287273052203988822378723970342');
const Q192 = BigInt(1) << BigInt(192);
function isqrt(n: bigint): bigint {
  if (n < BigInt(2)) return n;
  let x = BigInt(1) << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> BigInt(1);
    if (y >= x) return x;
    x = y;
  }
}

/**
 * The owner's maxPrice (input raw units per whole asset) as a Uniswap v3 sqrtPriceLimitX96 for an
 * input→asset swap, rounded so the bound is never looser than the limit. Clamped inside the pool's range.
 */
export function ownerLimitSqrtPriceX96(inputToken: string, asset: string, decimals: number, maxPriceRaw: bigint): bigint {
  if (maxPriceRaw <= BigInt(0)) throw new BagSdkError('INVALID_ARGUMENT', 'maxPriceRaw must be positive.');
  const unit = BigInt(10) ** BigInt(decimals);
  if (inputToken.toLowerCase() < asset.toLowerCase()) {
    // input is token0: price (asset per input) falls; lowest acceptable = unit / maxPrice, rounded up
    const q = (unit * Q192 + maxPriceRaw - BigInt(1)) / maxPriceRaw;
    let r = isqrt(q);
    if (r * r < q) r += BigInt(1);
    return r <= MIN_SQRT_RATIO ? MIN_SQRT_RATIO + BigInt(1) : r;
  }
  // input is token1: price (input per asset) rises; highest acceptable = maxPrice / unit, rounded down
  const r = isqrt((maxPriceRaw * Q192) / unit);
  return r >= MAX_SQRT_RATIO ? MAX_SQRT_RATIO - BigInt(1) : r;
}

/**
 * Builds one run of an authorization: fresh QuoterV2 quotes (bounded by the owner's limit) for every allowed
 * fee tier, the best tier per asset, and a BagExecutionRouter plan the executor accepts. Throws `NO_ROUTE` when
 * an asset has no pool or liquidity at any allowed tier, `PRICE_LIMIT_NOT_MET` when every quotable tier reaches
 * the owner's limit or the best average is below it, `RECURRING_TERMS_INVALID` outside the calendar, and
 * `RPC_READ_FAILED` for transport errors (never read as "no liquidity").
 */
export async function buildRecurringRunPlan(params: {
  client: QuoteClient;
  auth: RecurringAuthorization;
  deployment: RecurringDeployment;
  quoter: Hex;
  nowSeconds: bigint;
  quoteTtlSeconds?: bigint;
  slippageBps?: number;
}): Promise<RecurringRunPlan> {
  const { client, auth, deployment } = params;
  const window = recurringWindowAt(auth, params.nowSeconds);
  if (window === null) throw new BagSdkError('RECURRING_TERMS_INVALID', 'The current time is outside the authorization calendar.');
  const slippageBps = params.slippageBps ?? 100;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new BagSdkError('INVALID_ARGUMENT', 'slippageBps must be 0–10000.');
  const ttl = params.quoteTtlSeconds ?? BigInt(300);
  const legIn = recurringLegAmounts(auth);
  const floors = recurringMinimumOutputs(auth);

  const legs: RecurringRunLeg[] = [];
  for (let i = 0; i < auth.assets.length; i++) {
    const { asset, symbol, decimals, maxPriceRaw } = auth.assets[i];
    const limit = ownerLimitSqrtPriceX96(auth.inputToken, asset, decimals, maxPriceRaw);
    const alternatives: RecurringRunLeg['alternatives'] = [];
    for (const fee of auth.route.allowedFees) {
      try {
        const { result } = await client.simulateContract({
          address: params.quoter,
          abi: UNISWAP_V3_QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: auth.inputToken, tokenOut: asset, amountIn: legIn[i], fee, sqrtPriceLimitX96: limit }],
        });
        const [out, priceAfter] = result as readonly bigint[];
        if (priceAfter === limit) alternatives.push({ fee, quotedOutRaw: null, status: 'PRICE_LIMIT_REACHED' }); // stopped at the limit: partial
        else if (typeof out === 'bigint' && out > BigInt(0)) alternatives.push({ fee, quotedOutRaw: out, status: 'QUOTED' });
        else alternatives.push({ fee, quotedOutRaw: null, status: 'NO_QUOTE' });
      } catch (e) {
        if (!isRevert(e)) throw new BagSdkError('RPC_READ_FAILED');
        // 'SPL': the pool price is already past the owner's limit; anything else: no pool or no liquidity
        alternatives.push({ fee, quotedOutRaw: null, status: revertReason(e) === 'SPL' ? 'PRICE_LIMIT_REACHED' : 'NO_QUOTE' });
      }
    }
    const best = alternatives.filter((a) => a.quotedOutRaw !== null).sort((a, b) => (b.quotedOutRaw! > a.quotedOutRaw! ? 1 : b.quotedOutRaw! < a.quotedOutRaw! ? -1 : 0))[0];
    if (!best && alternatives.some((a) => a.status === 'PRICE_LIMIT_REACHED')) {
      throw new BagSdkError('PRICE_LIMIT_NOT_MET', `${symbol} (${asset}): the pool price is at or above the FIXED max price ${maxPriceRaw} at every allowed fee tier; no purchase in this window (not made up later).`);
    }
    if (!best) throw new BagSdkError('NO_ROUTE', `No allowed Uniswap v3 fee tier quoted ${asset}.`);
    if (best.quotedOutRaw! < floors[i]) {
      // Average price of this leg at the best quote, in raw input units per whole token (rounded up, as the floor is).
      const marketPriceRaw = (legIn[i] * BigInt(10) ** BigInt(decimals) + best.quotedOutRaw! - BigInt(1)) / best.quotedOutRaw!;
      throw new BagSdkError('PRICE_LIMIT_NOT_MET', `${symbol} (${asset}): market price ~${marketPriceRaw} is above the FIXED max price ${maxPriceRaw} (best quote ${best.quotedOutRaw} < floor ${floors[i]}); no purchase in this window (not made up later).`);
    }
    const afterSlippage = best.quotedOutRaw! - (best.quotedOutRaw! * BigInt(slippageBps)) / BigInt(10_000);
    legs.push({ asset, amountInRaw: legIn[i], fee: best.fee, quotedOutRaw: best.quotedOutRaw!, priceLimitFloorRaw: floors[i], minimumOutRaw: afterSlippage > floors[i] ? afterSlippage : floors[i], quoteSqrtPriceLimitX96: limit, alternatives });
  }

  const authorizationId = recurringAuthorizationId(auth, deployment);
  const quoteDeadline = params.nowSeconds + ttl;
  const plan: RouterExecutionPlan = {
    bagId: auth.bag.bagId,
    executionPlanHash: keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256[]' }, { type: 'uint256[]' }],
        [authorizationId, window, legs.map((l) => BigInt(l.fee)), legs.map((l) => l.quotedOutRaw)],
      ),
    ),
    wallet: deployment.executor,
    inputToken: auth.inputToken,
    inputAmount: auth.schedule.grossAmountPerRun,
    deadline: quoteDeadline,
    legs: legs.map((l) => ({
      target: auth.route.swapTarget,
      callData: encodeFunctionData({
        abi: SWAP_ROUTER_02_EXACT_INPUT_SINGLE_ABI,
        functionName: 'exactInputSingle',
        args: [{ tokenIn: auth.inputToken, tokenOut: l.asset, fee: l.fee, recipient: auth.route.router, amountIn: l.amountInRaw, amountOutMinimum: l.minimumOutRaw, sqrtPriceLimitX96: BigInt(0) }],
      }),
      value: BigInt(0),
      approveToken: auth.inputToken,
      approveAmount: l.amountInRaw,
    })),
    minOutputs: legs.map((l) => ({ token: l.asset, minAmountOut: l.minimumOutRaw })),
  };
  return { plan, execution: { authorizationId, window, quoteDeadline }, legs, evidence: 'SIMULATED_ON_CHAIN_QUOTE' };
}

/** The request the router's planSigner signs. */
export function routerPlanTypedData(plan: RouterExecutionPlan, deployment: { chainId: number; router: Hex }) {
  return {
    domain: { name: 'BagExecutionRouter', version: '1', chainId: deployment.chainId, verifyingContract: deployment.router },
    types: BAG_ROUTER_PLAN_TYPES,
    primaryType: 'ExecutionPlan' as const,
    message: plan,
  };
}
