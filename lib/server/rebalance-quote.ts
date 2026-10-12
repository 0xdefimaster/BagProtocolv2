import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';
import { buildComposerRebalance, rebalanceBuyNodeId, rebalanceSellNodeId, type RebalanceShape } from '@/lib/blockchain/lifi-composer-adapter';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS, parseComposerFallback } from '@/lib/blockchain/lifi-purchase-quote';
import type { ComposerFallbackNotice } from '@/types/purchase-intent';
import { COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS } from '@/lib/server/strategy-policy';
import { loadRebalancePreview } from '@/lib/server/rebalance-preview';
import { toProtocolPrice } from '@/lib/domain/basket-protocol/pricing/price-precision';
import { NAV_VALUE_DECIMALS } from '@/lib/domain/basket-protocol/nav/nav';
import type { PriceProvider } from '@/lib/domain/basket-protocol/pricing';

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
  | { ok: false; status: number; error: string; composerFallback?: ComposerFallbackNotice };

/** Largest-remainder split of `values` into whole bps summing to exactly 10000; a value too small for 1 bp gets 0. */
export function weightsFromValues(values: bigint[]): number[] {
  const total = values.reduce((s, v) => s + v, BigInt(0));
  if (total <= BigInt(0)) throw new Error('Buy values must be positive.');
  const bps = BigInt(10000);
  const floors = values.map((v) => (v * bps) / total);
  let left = Number(bps - floors.reduce((s, f) => s + f, BigInt(0)));
  const order = values.map((v, i) => ({ i, rem: (v * bps) % total })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const out = floors.map(Number);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
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
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch }
): Promise<RebalancePlanResult> {
  if (!options.apiKey) return { ok: false, status: 503, error: 'Rebalancing is not configured on this deployment (LIFI_API_KEY).' };
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
      maxPriceImpactBps: COMPOSER_DEFAULT_MAX_PRICE_IMPACT_BPS,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notice = parseComposerFallback(message);
    if (notice.reason === 'PRICE_IMPACT') return { ok: false, status: 422, error: 'The price impact of this rebalance is above the limit.', composerFallback: notice };
    return { ok: false, status: 502, error: `No route for this rebalance right now: ${message}` };
  }

  const produced = (node: string) => compiled.producedResources[`${node}.amountOut`];
  const buyLegs: RebalanceQuoteLeg[] = buys.map((b, j) => {
    // One buy: each sell swaps straight into it, so its output is the sum over the sell nodes.
    const nodes = compiled.shape === 'ONE_BUY' ? sells.map((_s, i) => rebalanceSellNodeId(i)) : [rebalanceBuyNodeId(j)];
    return {
      address: b.order.asset.address,
      symbol: label(b.order.asset.address),
      decimals: b.order.decimals,
      amountRaw: null,
      weightBps: b.weightBps,
      expectedOutRaw: sumOrNull(nodes.map((n) => str(produced(n)?.simulated?.amountOut))),
      minOutRaw: sumOrNull(nodes.map((n) => str(produced(n)?.simulated?.amountOutMin))),
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
