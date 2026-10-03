import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById, getCurrentBagVersion } from '@/lib/server/bag-repo';
import { paymentAssetsFor } from '@/lib/server/payment-assets';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getVerifiedIdentityKeys, listAssets } from '@/lib/server/asset-repo';
import { getPriceProvider } from '@/lib/server/price-provider';
import { computePurchasePreview, PREVIEW_DISCLAIMER } from '@/lib/server/purchase-preview';
import { validateRecipeAssetsAgainstRegistry } from '@/lib/domain/basket-protocol/validation/registry-validation';
import { recipeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import { AssetIdentity, DEFAULT_UNROUTABLE_POLICY } from '@/types/basket-protocol';
import { liFiExecutionAdapter } from '@/lib/blockchain/lifi-execution-adapter';
import { ExecutionResult } from '@/lib/blockchain/execution-adapter';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Production-hardening P1-10 — this POST is unauthenticated by design (spec:
// no wallet needed to preview) and fans out to a REAL LI.FI quote per SWAP
// leg (liFiExecutionAdapter above) — exactly the "expensive, public,
// abusable" combination item 10 calls out. IP-based, since there is no
// session to key on.
// 40: the purchase modal makes two calls per change (plain preview, then quotes).
const IP_RATE_LIMIT = { windowSeconds: 60, maxRequests: 40 };

// -----------------------------------------------------------------------------
// Phase 12 — Purchase Preview. Same split as app/api/bags/route.ts: parse ->
// call repository/domain -> map to a response. All the actual math lives
// in lib/server/purchase-preview.ts (which itself only wires existing
// Phase 6/9/10 domain functions together) — this file's only job is I/O:
// look up the Bag + its current recipe, fetch NAV, resolve the input asset
// against the Asset Registry, and never trust client-provided identity for
// any of it (spec section 25 — bagId comes from the URL, not the body;
// inputAsset is resolved from the registry by id, not accepted raw).
//
//   GET  /api/bags/:id/purchase-preview   verified input assets + bag basics
//   POST /api/bags/:id/purchase-preview   { inputAssetId, amount } -> preview
//
// Phase 13 — before computing a preview, POST also verifies every OUTPUT
// asset in the Bag's current recipe (xNVDA, xMSFT, ... — the assets the
// deposit would eventually be swapped INTO) against the Asset Registry,
// reusing `validateRecipeAssetsAgainstRegistry()` +
// `getVerifiedIdentityKeys()` verbatim — the exact same functions
// `lib/server/bag-repo.ts` already runs at publish time — rather than
// re-implementing the check here. Input-asset verification already
// existed (the GET/POST asset list below only ever offers VERIFIED
// assets); this closes the other half: a Bag published before an asset
// was deregistered, or whose recipe references something that was never
// verified, must never reach a point where a future execution layer is
// asked to route into it.
//
// Phase 14 — `POST .../purchase-preview?quotes=true` additionally quotes
// the computed `executionPlan` against LI.FI (`liFiExecutionAdapter`,
// lib/blockchain/lifi-execution-adapter.ts) and attaches the result as
// `preview.quotes`. Deliberately NOT a separate `/purchase-quote` route
// (spec section 17 explicitly warns against needless duplication): the
// quote is additional data about the exact same `executionPlan` this
// route already computes, not a different pipeline, so it rides on the
// existing response shape behind an opt-in query flag. The flag exists so
// every EXISTING caller of this route (any earlier Phase 12/13 client,
// tests) keeps getting the same response it always has, with zero latency
// or behavior change, unless it explicitly asks for live quotes. A quote
// failure (LI.FI down, no route, etc.) never fails the whole preview
// request — `preview.quotes` is simply `null` and `preview.quotesError`
// carries the typed reason (see `mapLiFiError()`), because the
// allocation/share preview above is still valid and useful on its own.
// -----------------------------------------------------------------------------

const priceProvider = getPriceProvider();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const { id } = await params;
  const admin = supabaseAdmin();

  const bag = await getBagById(admin, id);
  if (!bag) {
    return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  }
  if (bag.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'This Bag is not live yet — it must be deployed on-chain before it can take investments.' }, { status: 409 });
  }

  // Only VERIFIED registry assets are ever offered as an input — never a
  // hardcoded native-equity ticker list (spec section 6) — and only the
  // stablecoins/WETH on the Bag's own chain (see payment-assets.ts).
  const inputAssets = paymentAssetsFor(await listAssets(admin, { status: 'VERIFIED', chain: bag.chain }), bag.chain);

  return NextResponse.json({
    bag: { id: bag.id, name: bag.name, symbol: bag.symbol, status: bag.status },
    inputAssets: inputAssets.map((a) => ({
      id: a.id,
      chain: a.chain,
      address: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      name: a.name,
    })),
    disclaimer: PREVIEW_DISCLAIMER,
  });
}

interface PurchasePreviewRequestBody {
  inputAssetId: string;
  /** Human decimal string, e.g. "100" — never scaled/raw. */
  amount: string;
}

function isPurchasePreviewRequestBody(value: unknown): value is PurchasePreviewRequestBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.inputAssetId === 'string' && typeof body.amount === 'string';
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const { id } = await params;
  const admin = supabaseAdmin();

  const limit = await checkRateLimit(admin, `purchase-preview:ip:${getClientIp(req)}`, IP_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isPurchasePreviewRequestBody(body)) {
    return NextResponse.json({ error: 'Expected { inputAssetId: string, amount: string }.' }, { status: 400 });
  }

  const bag = await getBagById(admin, id);
  if (!bag) {
    return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  }
  if (bag.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'This Bag is not live yet — it must be deployed on-chain before it can take investments.' }, { status: 409 });
  }
  const version = await getCurrentBagVersion(admin, id);
  if (!version) {
    return NextResponse.json({ error: 'This Bag has no published recipe yet.' }, { status: 409 });
  }

  // Every OUTPUT asset in the recipe must still be a VERIFIED registry
  // asset — reusing the exact same check `bag-repo.ts` runs at publish
  // time (see this file's module doc), not a re-implementation. Fails
  // closed: a Bag whose composition references anything unverified (e.g.
  // deregistered since publish) never reaches a computed preview, exactly
  // so a future execution layer is never asked to route USDC into an
  // unsupported/fake token.
  const outputIdentityKeys = await getVerifiedIdentityKeys(admin, version.recipe.assets.map(recipeAssetIdentity));
  const registryIssues = validateRecipeAssetsAgainstRegistry(version.recipe, {
    verifiedIdentityKeys: outputIdentityKeys,
    severity: 'ERROR',
  });
  if (registryIssues.length > 0) {
    return NextResponse.json(
      {
        error: 'This Bag references one or more assets that are no longer verified in the registry.',
        details: registryIssues.map((issue) => issue.message),
      },
      { status: 409 }
    );
  }

  // Resolve the input asset by registry id — the client picks from the
  // GET response's `inputAssets`, it never supplies chain/address/decimals
  // directly (spec section 25: client-provided identity is never trusted).
  const inputAssets = await listAssets(admin, { status: 'VERIFIED' });
  const inputAsset = paymentAssetsFor(inputAssets, bag.chain).find((a) => a.id === body.inputAssetId);
  if (!inputAsset) {
    return NextResponse.json({ error: 'Unknown or unverified input asset.' }, { status: 400 });
  }

  const [navOutcome, shareSupply] = await Promise.all([
    getBagNavSafe(admin, id, priceProvider),
    getShareSupply(admin, id),
  ]);

  // Real-price fail-closed guard (Phase 18): a missing/stale/invalid price
  // for ANY holding never falls back to a stale or estimated NAV — the
  // whole preview fails with a clean, typed error instead.
  if (!navOutcome.ok) {
    return NextResponse.json(
      { error: 'Live pricing is temporarily unavailable. Please try again shortly.', reason: navOutcome.reason },
      { status: 503 }
    );
  }
  const nav = navOutcome.nav;

  const identity: AssetIdentity = { chain: inputAsset.chain, address: inputAsset.address };
  const outcome = computePurchasePreview({
    recipe: version.recipe,
    inputAsset: identity,
    inputSymbol: inputAsset.symbol,
    inputDecimals: inputAsset.decimals,
    amount: body.amount,
    nav,
    shareSupply,
  });

  if (!outcome.ok) {
    const messageByKind: Record<string, string> = {
      INVALID_AMOUNT: 'Enter a valid amount.',
      ZERO_AMOUNT: 'Deposit amount must be greater than zero.',
      INVALID_RECIPE: 'This Bag has an invalid composition.',
      NAV_UNAVAILABLE: 'NAV is currently unavailable.',
    };
    if (outcome.error.kind === 'BELOW_MIN_INVESTMENT') messageByKind.BELOW_MIN_INVESTMENT = outcome.error.message;
    return NextResponse.json({ error: messageByKind[outcome.error.kind] ?? 'Unable to calculate allocation.' }, { status: 422 });
  }

  // Phase 14 — opt-in live quote (see module doc above). Never thrown out
  // of this handler: a LI.FI failure degrades to `quotes: null` +
  // `quotesError`, it never turns a valid allocation preview into a 500.
  const wantsQuotes = req.nextUrl.searchParams.get('quotes') === 'true';
  let quotes: ExecutionResult | null = null;
  let quotesError: string | null = null;
  if (wantsQuotes) {
    try {
      quotes = await liFiExecutionAdapter.quoteExecutionPlan(outcome.executionPlan);
    } catch (err) {
      quotesError = err instanceof Error ? err.message : 'Unable to fetch live quotes.';
    }
  }

  // The creator's unroutable-asset policy, so the purchase UI can tell the
  // buyer what happens to a leg with no route (the purchase itself applies
  // it server-side — lib/server/purchase-execution.ts).
  const unroutablePolicy = version.recipe.unroutablePolicy ?? DEFAULT_UNROUTABLE_POLICY;
  return NextResponse.json({ preview: { ...outcome, quotes, quotesError, unroutablePolicy } });
}
