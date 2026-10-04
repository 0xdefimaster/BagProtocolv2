import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getBagById } from '@/lib/server/bag-repo';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getInvestorPosition } from '@/lib/server/bag-investor-position-repo';
import { getInvestorHoldings } from '@/lib/server/bag-investor-holdings-repo';
import { listAssets } from '@/lib/server/asset-repo';
import { paymentAssetsFor } from '@/lib/server/payment-assets';
import { getPriceProvider } from '@/lib/server/price-provider';
import { getRedeemQuote, InsufficientSharesError, ZeroRedeemAmountError, ZeroShareSupplyError } from '@/lib/domain/basket-protocol/shares/shares';
import { InsufficientPositionError, calculateRedeemAllocation } from '@/lib/domain/basket-protocol/redeem/allocation';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — authenticated: per-user, same convention as
// purchase-intent's own rate limit.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

// -----------------------------------------------------------------------------
// Phase 21 — Redeem Preview. Exit-side counterpart to
// .../purchase-preview/route.ts, with one structural difference that
// matters: a deposit preview is the same for anyone (any amount, any
// input asset — no session required). A redemption preview is inherently
// per-user (it can only ever be about THIS depositor's own position/
// holdings — see redeem/allocation.ts's module doc), so unlike
// purchase-preview, BOTH verbs here require a session.
//
// Deliberately does NOT call LI.FI (no wallet-bound quote, no `?quotes=
// true` equivalent) — that only happens once a redemption is actually
// committed via POST /api/bags/:id/redeem-intent (lib/server/
// redeem-execution.ts), which locks a real, signable route. This route is
// for the "how many shares, redeem into what, how much would that be"
// question a user asks BEFORE committing to anything wallet-bound.
//
//   GET  /api/bags/:id/redeem-preview                                    -> this depositor's position + verified output assets
//   POST /api/bags/:id/redeem-preview  { sharesToRedeemRaw, outputAssetId } -> RedeemQuote + allocation breakdown
// -----------------------------------------------------------------------------

const priceProvider = getPriceProvider();

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

  const [position, holdings, outputAssets] = await Promise.all([
    getInvestorPosition(admin, auth.session.userId, id),
    getInvestorHoldings(admin, auth.session.userId, id),
    listAssets(admin, { status: 'VERIFIED', chain: bag.chain }).then((assets) => paymentAssetsFor(assets, bag.chain)),
  ]);

  return NextResponse.json({
    bag: { id: bag.id, name: bag.name, symbol: bag.symbol },
    position: { sharesRaw: position.sharesRaw, shareDecimals: position.shareDecimals, costBasisQuote: position.costBasisQuote },
    // This depositor's own per-asset composition — what a redemption would
    // actually sell (see redeem/allocation.ts's module doc), shown so the
    // UI can explain WHY the payout isn't simply "shares × NAV" the same
    // way a pooled fund's would be.
    holdings: holdings.map((h) => ({ chain: h.chain, address: h.address, decimals: h.decimals, quantityRaw: h.quantityRaw })),
    outputAssets: outputAssets.map((a) => ({ id: a.id, chain: a.chain, address: a.address, symbol: a.symbol, decimals: a.decimals, name: a.name })),
  });
}

interface RedeemPreviewRequestBody {
  sharesToRedeemRaw: string;
  outputAssetId: string;
}

function isRedeemPreviewRequestBody(value: unknown): value is RedeemPreviewRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.sharesToRedeemRaw === 'string' && typeof body.outputAssetId === 'string';
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
    return NextResponse.json({ error: 'Expected { sharesToRedeemRaw: string, outputAssetId: string }.' }, { status: 400 });
  }

  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  const chainAssets = await listAssets(admin, { chain: bag.chain });
  const outputAssets = paymentAssetsFor(chainAssets.filter((a) => a.status === 'VERIFIED'), bag.chain);
  const outputAsset = outputAssets.find((a) => a.id === body.outputAssetId);
  if (!outputAsset) return NextResponse.json({ error: 'Unknown or unverified output asset.' }, { status: 400 });

  const [navOutcome, shareSupply, position, holdings] = await Promise.all([
    getBagNavSafe(admin, id, priceProvider),
    getShareSupply(admin, id),
    getInvestorPosition(admin, auth.session.userId, id),
    getInvestorHoldings(admin, auth.session.userId, id),
  ]);

  if (!navOutcome.ok) {
    return NextResponse.json({ error: 'Live pricing is temporarily unavailable. Please try again shortly.', reason: navOutcome.reason }, { status: 503 });
  }

  let redeemQuote;
  try {
    redeemQuote = getRedeemQuote(navOutcome.nav, shareSupply, body.sharesToRedeemRaw);
  } catch (err) {
    if (err instanceof ZeroRedeemAmountError) return NextResponse.json({ error: 'Enter a share amount greater than zero.' }, { status: 422 });
    if (err instanceof ZeroShareSupplyError) return NextResponse.json({ error: 'This Bag has no outstanding shares to redeem.' }, { status: 409 });
    if (err instanceof InsufficientSharesError) {
      return NextResponse.json({ error: `Cannot redeem ${err.requestedRaw} raw shares — only ${err.availableRaw} are outstanding.` }, { status: 422 });
    }
    throw err;
  }

  let allocation;
  try {
    allocation = calculateRedeemAllocation({
      bagId: id,
      sharesRaw: position.sharesRaw,
      sharesToRedeemRaw: body.sharesToRedeemRaw,
      outputAsset: { chain: outputAsset.chain, address: outputAsset.address },
      outputDecimals: outputAsset.decimals,
      holdings: holdings.map((h) => ({ chain: h.chain, address: h.address, decimals: h.decimals, quantityRaw: h.quantityRaw })),
    });
  } catch (err) {
    if (err instanceof InsufficientPositionError) {
      return NextResponse.json({ error: `Cannot redeem ${err.requestedRaw} raw shares — this position only holds ${err.ownedRaw}.` }, { status: 422 });
    }
    if (err instanceof ZeroRedeemAmountError) return NextResponse.json({ error: 'Enter a share amount greater than zero.' }, { status: 422 });
    throw err;
  }

  // Every asset on the chain (not only payment assets): the allocation sells the Bag's own holdings.
  const symbolByKey = new Map(chainAssets.map((a) => [`${a.chain}:${a.address.toLowerCase()}`, a.symbol]));

  return NextResponse.json({
    preview: {
      outputSymbol: outputAsset.symbol,
      redeemQuote: {
        sharesRaw: redeemQuote.sharesRaw,
        shareDecimals: redeemQuote.shareDecimals,
        sharePrice: redeemQuote.sharePrice,
        grossValue: redeemQuote.grossValue,
      },
      allocation: allocation.map((a) => ({
        symbol: symbolByKey.get(`${a.sourceAsset.chain}:${a.sourceAsset.address.toLowerCase()}`) ?? '?',
        sellQuantityRaw: a.sellQuantityRaw,
        decimals: a.sourceDecimals,
        isOutputAsset:
          a.sourceAsset.chain === outputAsset.chain && a.sourceAsset.address.toLowerCase() === outputAsset.address.toLowerCase(),
      })),
    },
  });
}
