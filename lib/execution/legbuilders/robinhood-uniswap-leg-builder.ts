import { encodeFunctionData, type Hex } from 'viem';
import { AssetIdentity } from '@/types/basket-protocol';
import { ROBINHOOD_CHAIN_ID, UNISWAP_ROUTER_ADDRESS } from '@/lib/config/robinhood-chain';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import type { BagExecutionGraph, BagExecutionLeg } from '../types';
import type { BagRouterLegBuilder, BuiltRouterLeg } from '../providers/bag-router-provider';

// -----------------------------------------------------------------------------
// lib/execution/legbuilders/robinhood-uniswap-leg-builder.ts
//
// PHASE 19.X-1 / 19.X-2 — the "Route Builder" box in:
//
//   Execution Engine -> Provider (BagRouterProvider) -> Route Builder (THIS)
//   -> BagExecutionRouter -> DEX (Uniswap v3 SwapRouter02, Robinhood Chain)
//
// This is deliberately NOT a second `BagExecutionProvider`. `BagRouterProvider`
// (providers/bag-router-provider.ts) already implements that interface and
// already builds/signs the full `ExecutionPlan` for `BagExecutionRouter.sol`;
// the one piece it takes as an injected dependency and does NOT implement
// itself is `BagRouterLegBuilder` — turning one `BagExecutionLeg` into real
// swap calldata. That is exactly, and only, what this module does. Building
// a parallel `BagExecutionProvider` here would duplicate the plan-hashing,
// signing and multi-leg min-output aggregation `BagRouterProvider` already
// gets right, and would put quote/routing logic in two places instead of
// one — the thing the spec explicitly says not to do ("BagExecutionRouter
// içine quote/routing logic koyma" applies equally to duplicating that
// logic beside the router instead of inside it).
//
// Scope (first version, per spec):
//   - Robinhood Chain (chainId 4663) only. Any other graph chainId is
//     refused outright — no silent cross-chain behaviour.
//   - Uniswap v3 SwapRouter02 `exactInputSingle` only (same target/ABI
//     `lib/blockchain/robinhood-swap-builder.ts` already uses for the
//     redeem path) — never an arbitrary/injected target.
//   - No LI.FI dependency anywhere in this file.
//   - Multi-leg baskets: this function is called once per leg by
//     `BagRouterProvider.compile()`, which then combines every leg's
//     calldata into ONE `BagExecutionRouter.execute()` transaction — so a
//     4-asset basket still becomes one atomic, one-signature execution.
//     Nothing in THIS file has to know about the other legs.
//
// What it refuses to do, on purpose (spec item 2):
//   - Accept a token that isn't in the caller-supplied canonical registry
//     (`isCanonicalToken`) — a leg's `sourceAsset`/`targetAsset` come from
//     the Bag's own recipe/graph (server-built), never from a raw client
//     request body, but this is checked here too as defense-in-depth,
//     mirroring `BagExecutionRouter.isAllowedToken` on-chain.
//   - Invent a quote. Quoting requires a live RPC call to Robinhood
//     Chain's Uniswap QuoterV2 (`lib/blockchain/robinhood-uniswap-quoter.ts`
//     provides the real implementation); this module takes that as an
//     injected async function and throws if every configured fee tier
//     comes back with no liquidity, rather than fabricating an output.
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

/** Same fee-tier search order `lib/blockchain/robinhood-swap-builder.ts` documents — most-common Uniswap v3 tiers first. Not independently re-derived here; imported would create a circular-ish coupling for a 3-item literal, so it's kept local and identical on purpose. */
export const COMMON_FEE_TIERS = [3000, 500, 10000] as const;

export interface UniswapQuoteResult {
  amountOut: bigint;
}

/**
 * Real on-chain quoting call, injected. Production implementation lives in
 * `lib/blockchain/robinhood-uniswap-quoter.ts` (a `viem` `simulateContract`
 * against `UNISWAP_QUOTER_V2_ADDRESS`). Returns `null` for "no pool / no
 * liquidity at this fee tier" — NOT the same as throwing, which means
 * "quoting itself failed" (RPC error, bad params). The leg builder only
 * moves on to the next fee tier for `null`; an unexpected throw propagates
 * as a real failure.
 */
export type UniswapQuoter = (params: {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  feeTier: number;
}) => Promise<UniswapQuoteResult | null>;

export class WrongChainError extends Error {
  constructor(expected: number, actual: unknown) {
    super(`RobinhoodUniswapLegBuilder is pinned to chainId ${expected}, got graph chainId ${String(actual)}.`);
    this.name = 'WrongChainError';
  }
}

export class UnverifiedTokenError extends Error {
  constructor(identity: AssetIdentity, role: 'sourceAsset' | 'targetAsset') {
    super(`Refusing to build a leg: ${role} ${identity.chain}:${identity.address} is not in the canonical asset registry.`);
    this.name = 'UnverifiedTokenError';
  }
}

export class SameTokenLegError extends Error {
  constructor(token: string) {
    super(`Leg has identical sourceAsset and targetAsset (${token}) — not a real swap.`);
    this.name = 'SameTokenLegError';
  }
}

export class NoLiquidityError extends Error {
  constructor(tokenIn: string, tokenOut: string, feeTiers: readonly number[]) {
    super(`No Uniswap v3 liquidity found for ${tokenIn} -> ${tokenOut} at any of the fee tiers tried: [${feeTiers.join(', ')}].`);
    this.name = 'NoLiquidityError';
  }
}

export interface RobinhoodUniswapLegBuilderConfig {
  /** The deployed `BagExecutionRouter` this builder is producing legs for — swap output is sent HERE (never to the end wallet directly), because the router measures its own balance delta before paying the user out. Must match `BagRouterProviderConfig.routerAddress` for the same deployment. */
  routerAddress: Hex;
  /**
   * Canonical-registry check, sync and side-effect-free by contract — the
   * caller is expected to have already loaded verified identities (e.g.
   * via `getVerifiedIdentityKeys()`) into a `Set` and closed over it here,
   * rather than this module owning a Supabase/DB dependency itself.
   */
  isCanonicalToken: (identity: AssetIdentity) => boolean;
  /** Real on-chain quoting call — see `UniswapQuoter`'s doc. No default: a deployment that hasn't wired one up gets a loud constructor throw, never a silent fabricated-quote fallback. */
  quote: UniswapQuoter;
  /** Fee tiers to try, most-likely-first. Defaults to `COMMON_FEE_TIERS`. */
  feeTiers?: readonly number[];
  /** Defaults to `ROBINHOOD_CHAIN_ID` (4663) — override only for tests. */
  chainId?: number;
}

/**
 * Builds a real `BagRouterLegBuilder` — the function `BagRouterProvider`
 * calls once per leg to get `{ target, callData, value, approveToken,
 * approveAmount, quotedOutputRaw, minimumGuaranteedOutputRaw }`. See module doc for the full seam.
 */
export function createRobinhoodUniswapLegBuilder(config: RobinhoodUniswapLegBuilderConfig): BagRouterLegBuilder {
  if (!UNISWAP_ROUTER_ADDRESS) {
    throw new Error('createRobinhoodUniswapLegBuilder: UNISWAP_ROUTER_ADDRESS is not configured (see lib/config/robinhood-chain.ts).');
  }
  const routerTarget = UNISWAP_ROUTER_ADDRESS;
  const chainId = config.chainId ?? ROBINHOOD_CHAIN_ID;
  const feeTiers = config.feeTiers ?? COMMON_FEE_TIERS;

  return async function robinhoodUniswapLegBuilder(leg: BagExecutionLeg, graph: BagExecutionGraph): Promise<BuiltRouterLeg> {
    if (graph.chainId !== 'robinhood') {
      throw new WrongChainError(chainId, graph.chainId);
    }

    if (!config.isCanonicalToken(leg.sourceAsset)) throw new UnverifiedTokenError(leg.sourceAsset, 'sourceAsset');
    if (!config.isCanonicalToken(leg.targetAsset)) throw new UnverifiedTokenError(leg.targetAsset, 'targetAsset');

    const tokenIn = leg.sourceAsset.address as Hex;
    const tokenOut = leg.targetAsset.address as Hex;
    if (assetIdentityKey(leg.sourceAsset) === assetIdentityKey(leg.targetAsset)) {
      throw new SameTokenLegError(tokenIn);
    }

    const amountIn = BigInt(leg.amountRaw);
    if (amountIn <= BigInt(0)) {
      throw new Error(`Leg ${leg.id}: amountRaw must be > 0, got ${leg.amountRaw}.`);
    }

    let quoted: { amountOut: bigint; feeTier: number } | null = null;
    for (const feeTier of feeTiers) {
      const result = await config.quote({ tokenIn, tokenOut, amountIn, feeTier });
      if (result && result.amountOut > BigInt(0)) {
        quoted = { amountOut: result.amountOut, feeTier };
        break;
      }
    }
    if (!quoted) throw new NoLiquidityError(tokenIn, tokenOut, feeTiers);

    // Floor division, same rounding-down convention as the rest of the
    // codebase's money math (never round a minimum UP in the user's favor
    // against the DEX, and never round the protocol's exposure down in a
    // way that silently accepts more slippage than requested).
    const slippageBps = BigInt(leg.slippageBps);
    const minAmountOut = quoted.amountOut - (quoted.amountOut * slippageBps) / BigInt(10_000);

    const callData = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quoted.feeTier,
          // Output lands at the ROUTER, not the wallet — `BagExecutionRouter`
          // pulls tokenIn from the wallet, calls this leg, measures its own
          // post-call balance delta per `minOutputs`, then pays the wallet
          // out itself. Sending output straight to the wallet would break
          // that accounting model (see BagExecutionRouter.sol's NatSpec).
          recipient: config.routerAddress,
          amountIn,
          amountOutMinimum: minAmountOut,
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });

    return {
      target: routerTarget,
      callData,
      // ERC-20 input only in this first version (spec: "cross-chain yok",
      // native-asset legs are a later phase — `BagRouterProvider`'s own
      // `nativeAsset: false` capability flag already documents this).
      value: BigInt(0),
      approveToken: tokenIn,
      approveAmount: amountIn,
      quotedOutputRaw: quoted.amountOut.toString(),
      minimumGuaranteedOutputRaw: minAmountOut.toString(),
    };
  };
}
