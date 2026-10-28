import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import { buildComposerRebalance, composerPortAmounts, rebalanceBuyNodeId, rebalanceSellNodeId, type RebalanceShape } from '@/lib/blockchain/lifi-composer-adapter';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS, composerFallbackFrom } from '@/lib/blockchain/lifi-purchase-quote';
import { PRICE_IMPACT_ACCEPT_BUFFER_BPS, type ComposerFallbackNotice } from '@/types/purchase-intent';
import { COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS } from '@/lib/server/strategy-policy';
import { loadRebalancePreview } from '@/lib/server/rebalance-preview';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { NAV_VALUE_DECIMALS } from '@/lib/domain/basket-protocol/nav/nav';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing';
import { largestRemainderBps } from '@/packages/bag-sdk/src';

// -----------------------------------------------------------------------------
// Rebalance quote (R2): the position preview (rebalance-preview.ts) turned into
// a real LI.FI Composer route — what the overweight tokens sell for and what the
// underweight ones would arrive at, with Composer's own simulated and enforced
// minimum outputs, price impact and fees.
//
// `quoteRebalance` never returns the compiled transaction: a rebalance changes
// what a position holds, so it is signed only through a recorded intent BAG
// verifies on-chain and books (`planRebalance` → rebalance-execution.ts, R3).
// Signs and sends nothing.
// -----------------------------------------------------------------------------

/** The most slippage a rebalance swap may take, whatever the strategy says. */
const MAX_REBALANCE_SLIPPAGE_BPS = 300;

/**
 * Hard ceiling on the price impact an investor may accept for a rebalance (10%). Without acceptance the limit is
 * COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS (5%); between the two, the card shows the impact and the investor can accept
 * it explicitly (same flow as purchases and the swap card, lower ceiling). Above it a rebalance is refused outright.
 */
export const MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS = 1000;

/**
 * The price-impact limit Composer is asked to enforce: the default, or — when the investor accepted a measured impact —
 * that impact plus a small buffer (a price move between the warning and the retry), never above the ceiling and never
 * below the default. Null when the accepted value is not a whole bps figure within [0, ceiling].
 */
export function rebalancePriceImpactLimitBps(acceptedPriceImpactBps: number | undefined): number | null {
  if (acceptedPriceImpactBps === undefined) return COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS;
  if (!Number.isInteger(acceptedPriceImpactBps) || acceptedPriceImpactBps < 0 || acceptedPriceImpactBps > MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS) return null;
  return Math.max(COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS, Math.min(acceptedPriceImpactBps + PRICE_IMPACT_ACCEPT_BUFFER_BPS, MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS));
}

export interface RebalanceQuoteLeg {
  address: string;
  symbol: string;
  decimals: number;
  /** Sells: the exact amount sold. Buys: null (bought with the proceeds). */
  amountRaw: string | null;
  /** Buys only: share of the proceeds. */
  weightBps: number | null;
  expectedOutRaw: string | null;
  minOutRaw: string | null;
}

export type RebalanceQuoteResult =
  | {
      ok: true;
      targetVersion: number;
      shape: RebalanceShape;
      sells: RebalanceQuoteLeg[];
      buys: RebalanceQuoteLeg[];
      slippageBps: number;
      priceImpactBps: number | null;
      fees: { token: string; bps: number; amount: string | null }[];
      approvalsNeeded: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
      composerFallback?: ComposerFallbackNotice;
      /** Set with a price-impact refusal: whether the measured impact is within what the investor may accept. */
      acceptablePriceImpactBps?: number | null;
    };

/** Largest-remainder split of `values` into whole bps summing to exactly 10000 (bag-sdk `largestRemainderBps`); a value too small for 1 bp gets 0. */
export function weightsFromValues(values: bigint[]): number[] {
  if (values.reduce((s, v) => s + v, BigInt(0)) <= BigInt(0)) throw new Error('Buy values must be positive.');
  return largestRemainderBps(values);
}

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const sumOrNull = (values: (string | null)[]) => (values.some((v) => v === null) ? null : values.reduce((s, v) => s + BigInt(v as string), BigInt(0)).toString());

/** One leg of a planned rebalance, as an intent records it. */
export interface RebalancePlanSell {
  chain: string;
  address: string;
  decimals: number;
  symbol: string;
  amountRaw: string;
}
export interface RebalancePlanBuy {
  chain: string;
  address: string;
  decimals: number;
  symbol: string;
  weightBps: number;
  expectedOutRaw: string | null;
  minOutRaw: string | null;
}

export type RebalancePlanResult =
  | (Extract<RebalanceQuoteResult, { ok: true }> & {
      bagChain: string;
      planSells: RebalancePlanSell[];
      planBuys: RebalancePlanBuy[];
      transaction: { to: string; data: string; value: string; chainId: number };
      approvals: { token: string; spender: string; amountRaw: string }[];
    })
  | Extract<RebalanceQuoteResult, { ok: false }>;

/** The live quote only (the R2 card). */
export async function quoteRebalance(...args: Parameters<typeof planRebalance>): Promise<RebalanceQuoteResult> {
  const plan = await planRebalance(...args);
  if (!plan.ok) return plan;
  const { bagChain: _c, planSells: _s, planBuys: _b, transaction: _t, approvals: _a, ...quote } = plan;
  return quote;
}

/** The quote plus the compiled transaction and the legs an intent records. Only rebalance-execution.ts hands the transaction to a wallet. */
export async function planRebalance(
  admin: SupabaseClient,
  client: PublicClient,
  priceProvider: PriceProvider,
  session: { userId: string; walletAddress: string },
  bagId: string,
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch; acceptedPriceImpactBps?: number }
): Promise<RebalancePlanResult> {
  if (!options.apiKey) return { ok: false, status: 503, error: 'Rebalancing is not configured on this deployment (LIFI_API_KEY).' };
  const maxPriceImpactBps = rebalancePriceImpactLimitBps(options.acceptedPriceImpactBps);
  if (maxPriceImpactBps === null) {
    return { ok: false, status: 400, error: `A price impact above ${MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS / 100}% cannot be accepted for a rebalance.` };
  }
  const loaded = await loadRebalancePreview(admin, client, priceProvider, session, bagId);
  if (!loaded.ok) return loaded;
  const { bag, recipe, holdings, symbols, preview } = loaded;
  if (bag.chain !== 'robinhood') return { ok: false, status: 422, error: 'Rebalancing runs on Robinhood Chain only for now.' };
  if (preview.status !== 'OK') return { ok: false, status: 409, error: `No rebalance can be planned right now (${preview.status}).` };
  if (!preview.requiresRebalance) return { ok: false, status: 409, error: 'Your position is within the strategy’s drift threshold; there is nothing to rebalance.' };

  const label = (address: string) => symbols[`${bag.chain}:${address.toLowerCase()}`] ?? address;
  const sellable = new Map((holdings ?? []).map((h) => [h.address.toLowerCase(), BigInt(h.sellableRaw)]));
  const sells = preview.orders.filter((o) => o.side === 'SELL' && o.quantityRaw !== null && BigInt(o.quantityRaw) > BigInt(0));
  for (const o of sells) {
    // The plan sells from what the wallet holds for this strategy; never more.
    const limit = sellable.get(o.asset.address.toLowerCase()) ?? BigInt(0);
    if (BigInt(o.quantityRaw as string) > limit) return { ok: false, status: 409, error: `The plan would sell more ${label(o.asset.address)} than your wallet holds for this strategy.` };
  }
  const buyOrders = preview.orders.filter((o) => o.side === 'BUY');
  if (sells.length === 0 || buyOrders.length === 0) return { ok: false, status: 409, error: 'The plan has nothing to sell or nothing to buy.' };
  const weights = weightsFromValues(buyOrders.map((o) => toProtocolPrice(o.value, NAV_VALUE_DECIMALS)));
  const buys = buyOrders.map((o, j) => ({ order: o, weightBps: weights[j] })).filter((b) => b.weightBps > 0);

  const slippageBps = Math.min(recipe.rebalanceRule?.maxSlippageBps ?? DEFAULT_COMPOSER_SLIPPAGE_BPS, MAX_REBALANCE_SLIPPAGE_BPS);
  let compiled;
  try {
    compiled = await buildComposerRebalance({
      chain: 'robinhood',
      sells: sells.map((o) => ({ address: o.asset.address, amountRaw: o.quantityRaw as string, symbol: label(o.asset.address) })),
      buys: buys.map((b) => ({ address: b.order.asset.address, weightBps: b.weightBps, symbol: label(b.order.asset.address) })),
      hubTokenAddress: ROBINHOOD_REWARD_TOKEN.address,
      signerAddress: session.walletAddress,
      slippageBps,
      maxPriceImpactBps,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    const notice = composerFallbackFrom(err);
    if (notice.reason === 'PRICE_IMPACT') {
      const measured = notice.priceImpactBps;
      const acceptable = measured !== null && measured <= MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS ? measured : null;
      const error =
        acceptable !== null
          ? `The price impact of this rebalance is ${(measured! / 100).toFixed(2)}%, above the ${maxPriceImpactBps / 100}% limit.`
          : `The price impact of this rebalance${measured !== null ? ` (${(measured / 100).toFixed(2)}%)` : ''} is above the ${MAX_ACCEPTABLE_REBALANCE_PRICE_IMPACT_BPS / 100}% maximum. Try again when liquidity is deeper.`;
      return { ok: false, status: 422, error, composerFallback: notice, acceptablePriceImpactBps: acceptable };
    }
    return { ok: false, status: 502, error: `No route for this rebalance right now: ${notice.message}` };
  }

  const produced = (node: string) => composerPortAmounts(compiled.outputs, `${node}.amountOut`);
  const buyLegs: RebalanceQuoteLeg[] = buys.map((b, j) => {
    // One buy: each sell swaps straight into it, so its output is the sum over the sell nodes.
    const nodes = compiled.shape === 'ONE_BUY' ? sells.map((_s, i) => rebalanceSellNodeId(i)) : [rebalanceBuyNodeId(j)];
    return {
      address: b.order.asset.address,
      symbol: label(b.order.asset.address),
      decimals: b.order.decimals,
      amountRaw: null,
      weightBps: b.weightBps,
      expectedOutRaw: sumOrNull(nodes.map((n) => produced(n).expected)),
      minOutRaw: sumOrNull(nodes.map((n) => produced(n).min)),
    };
  });
  const sellLegs = sells.map((o) => ({ address: o.asset.address, symbol: label(o.asset.address), decimals: o.decimals, amountRaw: o.quantityRaw, weightBps: null, expectedOutRaw: null, minOutRaw: null }));
  return {
    ok: true,
    bagChain: bag.chain,
    planSells: sells.map((o) => ({ chain: o.asset.chain, address: o.asset.address, decimals: o.decimals, symbol: label(o.asset.address), amountRaw: o.quantityRaw as string })),
    planBuys: buys.map((b, j) => ({
      chain: b.order.asset.chain,
      address: b.order.asset.address,
      decimals: b.order.decimals,
      symbol: label(b.order.asset.address),
      weightBps: b.weightBps,
      expectedOutRaw: buyLegs[j].expectedOutRaw,
      minOutRaw: buyLegs[j].minOutRaw,
    })),
    transaction: {
      to: compiled.transactionRequest.to,
      data: compiled.transactionRequest.data,
      value: compiled.transactionRequest.value,
      chainId: Number(compiled.transactionRequest.chainId),
    },
    approvals: compiled.approvals,
    targetVersion: preview.targetVersion,
    shape: compiled.shape,
    sells: sellLegs,
    buys: buyLegs,
    slippageBps,
    priceImpactBps: compiled.priceImpact?.impactBps ?? null,
    fees: compiled.fees.map((f) => ({ token: f.token, bps: f.bps, amount: f.amount ?? null })),
    approvalsNeeded: compiled.approvals.length,
  };
}
