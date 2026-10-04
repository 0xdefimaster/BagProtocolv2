import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getBagById } from '@/lib/server/bag-repo';
import { listAssets } from '@/lib/server/asset-repo';
import { paymentAssetsFor } from '@/lib/server/payment-assets';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { observeUserHoldings, sellableHoldingsForBag, valueUserPositions, assetKey } from '@/lib/server/position-valuation';
import { valuePosition } from '@/lib/domain/basket-protocol/accounting/position-value';
import { ZeroRedeemAmountError } from '@/lib/domain/basket-protocol/shares/shares';
import { InvalidRedeemFractionError, calculateRedeemAllocation } from '@/lib/domain/basket-protocol/redeem/allocation';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — authenticated: per-user, same convention as
// purchase-intent's own rate limit.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

// -----------------------------------------------------------------------------
// Phase 21 / A4 — Redeem Preview. Inherently per-user (it can only ever be
// about THIS depositor's own holdings — see redeem/allocation.ts's module
// doc), so both verbs require a session.
//
// A4 (docs/ACCOUNTING_V2_DESIGN.md §7): the position is valued from what the
// wallet holds, not from shares × NAV, and three numbers are kept apart:
//   strategyExposure   what BAG tracks for this strategy, at verified prices
//   observedWallet     what of it is still in the wallet
//   effectivePosition  the wallet's balance attributed to this strategy (what can be sold)
// Estimated proceeds (after price impact and fees) are a fourth number that
// only a real route quote can give — POST /api/bags/:id/redeem-intent returns
// it with the signable route. This route never calls LI.FI.
//
//   GET  /api/bags/:id/redeem-preview                              -> position value + verified output assets
//   POST /api/bags/:id/redeem-preview  { fractionBps, outputAssetId } -> what that fraction sells, and its position value
// -----------------------------------------------------------------------------

const priceProvider = getDisplayPriceProvider();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const admin = supabaseAdmin();

  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  const chainAssets = await listAssets(admin, { chain: bag.chain });
  const symbolByKey = new Map(chainAssets.map((a) => [assetKey(a.chain, a.address), a.symbol]));
  const outputAssets = paymentAssetsFor(chainAssets.filter((a) => a.status === 'VERIFIED'), bag.chain);
  const values = await valueUserPositions(admin, getChainPublicClient('robinhood'), priceProvider, auth.session, (c, a) => symbolByKey.get(assetKey(c, a)));
  const value = values.get(id) ?? null;

  return NextResponse.json({
    bag: { id: bag.id, name: bag.name, symbol: bag.symbol },
    position: value
      ? {
          strategyExposureQuote: value.strategyExposureQuote,
          observedWalletQuote: value.observedWalletQuote,
          effectivePositionQuote: value.effectivePositionQuote,
          hasDrift: value.hasDrift,
          hasUnreadable: value.hasUnreadable,
          blockNumber: value.blockNumber,
          quoteCurrency: 'USD',
          assets: value.assets,
        }
      : null,
    outputAssets: outputAssets.map((a) => ({ id: a.id, chain: a.chain, address: a.address, symbol: a.symbol, decimals: a.decimals, name: a.name })),
  });
}

interface RedeemPreviewRequestBody {
  fractionBps: number;
  outputAssetId: string;
}

function isRedeemPreviewRequestBody(value: unknown): value is RedeemPreviewRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.fractionBps === 'number' && typeof body.outputAssetId === 'string';
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-preview:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isRedeemPreviewRequestBody(body)) {
    return NextResponse.json({ error: 'Expected { fractionBps: number, outputAssetId: string }.' }, { status: 400 });
  }

  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  const chainAssets = await listAssets(admin, { chain: bag.chain });
  const outputAssets = paymentAssetsFor(chainAssets.filter((a) => a.status === 'VERIFIED'), bag.chain);
  const outputAsset = outputAssets.find((a) => a.id === body.outputAssetId);
  if (!outputAsset) return NextResponse.json({ error: 'Unknown or unverified output asset.' }, { status: 400 });

  const observed = await observeUserHoldings(admin, getChainPublicClient('robinhood'), auth.session);
  if (!observed.rows.some((r) => r.bagId === id)) return NextResponse.json({ error: 'You have no position in this Bag to sell.' }, { status: 409 });
  const sellable = sellableHoldingsForBag(observed, id);
  if (!sellable) return NextResponse.json({ error: 'Your wallet balances could not be read right now. Please try again shortly.' }, { status: 503 });

  let allocation;
  try {
    allocation = calculateRedeemAllocation({
      bagId: id,
      fractionBps: body.fractionBps,
      outputAsset: { chain: outputAsset.chain, address: outputAsset.address },
      outputDecimals: outputAsset.decimals,
      holdings: sellable,
    });
  } catch (err) {
    if (err instanceof InvalidRedeemFractionError) return NextResponse.json({ error: 'Choose how much of the position to sell (between 0.01% and 100%).' }, { status: 422 });
    if (err instanceof ZeroRedeemAmountError) return NextResponse.json({ error: 'Your wallet holds nothing of this position that can be sold.' }, { status: 422 });
    throw err;
  }

  // Every asset on the chain (not only payment assets): the allocation sells the Bag's own holdings.
  const symbolByKey = new Map(chainAssets.map((a) => [assetKey(a.chain, a.address), a.symbol]));
  // Position value of the slice being sold, at verified display prices — NOT what the sale will return.
  const prices = await Promise.all(
    allocation.map((a) =>
      priceProvider
        .getPrice(a.sourceAsset)
        .then((p) => p.price)
        .catch(() => null)
    )
  );
  const sliceValue = valuePosition(
    allocation.map((a, i) => ({
      chain: a.sourceAsset.chain,
      address: a.sourceAsset.address,
      decimals: a.sourceDecimals,
      trackedRaw: a.sellQuantityRaw,
      trackedAllStrategiesRaw: a.sellQuantityRaw,
      observedRaw: a.sellQuantityRaw,
      price: prices[i],
    }))
  );

  return NextResponse.json({
    preview: {
      outputSymbol: outputAsset.symbol,
      fractionBps: body.fractionBps,
      sliceValueQuote: sliceValue.effectivePositionQuote,
      quoteCurrency: 'USD',
      allocation: allocation.map((a) => ({
        symbol: symbolByKey.get(assetKey(a.sourceAsset.chain, a.sourceAsset.address)) ?? '?',
        sellQuantityRaw: a.sellQuantityRaw,
        decimals: a.sourceDecimals,
        isOutputAsset:
          a.sourceAsset.chain === outputAsset.chain && a.sourceAsset.address.toLowerCase() === outputAsset.address.toLowerCase(),
      })),
    },
  });
}
