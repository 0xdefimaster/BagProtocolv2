import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { listAllLedgerEventsForPosition } from '@/lib/server/ledger-repo';
import { redemptionPaysFee } from '@/lib/server/fee-redemption-lock';
import { computePositionPnl } from '@/lib/domain/basket-protocol/accounting/position-pnl';
import { feeBasisFromPositionPnl } from '@/lib/domain/basket-protocol/redeem/performance-fee-b0';
import { formatDec, parseDec } from '@/lib/domain/basket-protocol/accounting/decimal';
import { listAssets } from '@/lib/server/asset-repo';
import { redeemOutputAssetsFor } from '@/lib/server/payment-assets';
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
  // A sale that pays a performance fee settles in the settlement token only; a free one into any verified token.
  const paysFee = redemptionPaysFee(bag, await getCurrentBagVersion(admin, id), auth.session.userId);
  const outputAssets = redeemOutputAssetsFor(chainAssets.filter((a) => a.status === 'VERIFIED'), bag.chain, { paysFee });
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
  const version = await getCurrentBagVersion(admin, id);
  const outputAssets = redeemOutputAssetsFor(chainAssets.filter((a) => a.status === 'VERIFIED'), bag.chain, {
    paysFee: redemptionPaysFee(bag, version, auth.session.userId),
  });
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

  // B0 (docs/FEE_ECONOMICS_DESIGN.md): the performance fee this sale pays, ESTIMATED from the slice's value at
  // display prices. The exact fee is set when the wallet signs, on the guaranteed minimum proceeds — never more than
  // the rate × the gain actually realized (above earlier losses).
  let performanceFee: {
    rateBps: number;
    basisAvailable: boolean;
    consumedBasisQuote: string | null;
    lossCarryQuote: string | null;
    estimatedFeeQuote: string | null;
  } | null = null;
  if (redemptionPaysFee(bag, version, auth.session.userId)) {
    const rateBps = bag.performanceFeeBpsLocked ?? version?.recipe.performanceFeeBps ?? 0;
    const basis = feeBasisFromPositionPnl(
      computePositionPnl(await listAllLedgerEventsForPosition(admin, auth.session.userId, id)),
      allocation.map((a) => ({ chain: a.sourceAsset.chain, address: a.sourceAsset.address, quantityRaw: a.sellQuantityRaw }))
    );
    if (!basis.ok) {
      performanceFee = { rateBps, basisAvailable: false, consumedBasisQuote: null, lossCarryQuote: null, estimatedFeeQuote: null };
    } else {
      const slice = sliceValue.effectivePositionQuote === null ? null : parseDec(sliceValue.effectivePositionQuote);
      const gain = slice === null ? null : slice - basis.consumedBasisQuote - basis.lossCarryQuote;
      performanceFee = {
        rateBps,
        basisAvailable: true,
        consumedBasisQuote: formatDec(basis.consumedBasisQuote),
        lossCarryQuote: formatDec(basis.lossCarryQuote),
        estimatedFeeQuote: gain === null ? null : formatDec(gain > BigInt(0) ? (gain * BigInt(rateBps)) / BigInt(10000) : BigInt(0)),
      };
    }
  }

  return NextResponse.json({
    preview: {
      outputSymbol: outputAsset.symbol,
      fractionBps: body.fractionBps,
      sliceValueQuote: sliceValue.effectivePositionQuote,
      performanceFee,
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
