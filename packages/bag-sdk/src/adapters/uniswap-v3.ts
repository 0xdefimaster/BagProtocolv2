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

export interface RecurringRunLeg {
  asset: Hex;
  amountInRaw: bigint;
  fee: number;
  quotedOutRaw: bigint;
  /** The owner's price-limit floor: ceil(amountIn × 10^decimals / maxPriceRaw). */
  priceLimitFloorRaw: bigint;
  /** What the plan requires: max(price-limit floor, quote − slippage). */
  minimumOutRaw: bigint;
  alternatives: { fee: number; quotedOutRaw: bigint | null }[];
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

/**
 * Builds one run of an authorization: fresh QuoterV2 quotes for every allowed fee tier, the best tier per
 * asset, and a BagExecutionRouter plan the executor accepts. Throws `NO_ROUTE` when an asset has no quote,
 * `PRICE_LIMIT_NOT_MET` when the best quote is below the owner's limit, `RECURRING_TERMS_INVALID` outside the
 * calendar, `RPC_READ_FAILED` for transport errors (never read as "no liquidity").
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
    const asset = auth.assets[i].asset;
    const alternatives: RecurringRunLeg['alternatives'] = [];
    for (const fee of auth.route.allowedFees) {
      try {
        const { result } = await client.simulateContract({
          address: params.quoter,
          abi: UNISWAP_V3_QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: auth.inputToken, tokenOut: asset, amountIn: legIn[i], fee, sqrtPriceLimitX96: BigInt(0) }],
        });
        const out = (result as readonly bigint[])[0];
        alternatives.push({ fee, quotedOutRaw: typeof out === 'bigint' && out > BigInt(0) ? out : null });
      } catch (e) {
        if (!isRevert(e)) throw new BagSdkError('RPC_READ_FAILED');
        alternatives.push({ fee, quotedOutRaw: null }); // no pool or no liquidity at this tier
      }
    }
    const best = alternatives.filter((a) => a.quotedOutRaw !== null).sort((a, b) => (b.quotedOutRaw! > a.quotedOutRaw! ? 1 : b.quotedOutRaw! < a.quotedOutRaw! ? -1 : 0))[0];
    if (!best) throw new BagSdkError('NO_ROUTE', `No allowed Uniswap v3 fee tier quoted ${asset}.`);
    if (best.quotedOutRaw! < floors[i]) {
      throw new BagSdkError('PRICE_LIMIT_NOT_MET', `${asset}: best quote ${best.quotedOutRaw} is below the owner's limit ${floors[i]}.`);
    }
    const afterSlippage = best.quotedOutRaw! - (best.quotedOutRaw! * BigInt(slippageBps)) / BigInt(10_000);
    legs.push({ asset, amountInRaw: legIn[i], fee: best.fee, quotedOutRaw: best.quotedOutRaw!, priceLimitFloorRaw: floors[i], minimumOutRaw: afterSlippage > floors[i] ? afterSlippage : floors[i], alternatives });
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
