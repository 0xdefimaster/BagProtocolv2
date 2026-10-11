import { NextRequest, NextResponse } from 'next/server';
import { getNavSummaries } from '@/lib/server/bag-nav-snapshots';
import { getBagSocialCounts } from '@/lib/server/bag-social-counts';
import { getBagVerification } from '@/lib/server/bag-verification';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { countRecentDraftBags, createBag, DRAFT_WINDOW_MS, getCurrentBagVersion, listBags, MAX_RECENT_DRAFTS } from '@/lib/server/bag-repo';
import { listAssets } from '@/lib/server/asset-repo';
import { loadRecipeAssets } from '@/lib/server/bag-asset-context';
import { validateBagText } from '@/lib/server/bag-text';
import { loadCreatorProfiles } from '@/lib/server/user-profile-repo';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const CREATE_RATE_LIMIT = { windowSeconds: 3600, maxRequests: 30 };
import {
  AssetAddressLookup,
  CreateBagApiRequest,
  mapBagRecordToApiResponse,
  mapBagRecordsToApiResponse,
  mapCreateBagRequestToRecipeInput,
} from '@/lib/mappers/bag-mapper';
import { BagStatus, ChainId, SUPPORTED_CHAINS } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// First non-deploy `/api/bags` route. Same split as every other route in
// this app: parse -> call repository -> map result to an HTTP response.
// All ownership/validation/state-machine logic lives in
// `lib/server/bag-repo.ts` (validateBasketRecipe, DUPLICATE_SLUG, etc.) —
// this file never re-implements any of it.
//
//   GET  /api/bags            public listing (Explore) -> ACTIVE bags only
//   GET  /api/bags?mine=1     caller's own bags, any status (requires session)
//   POST /api/bags            create a bag for the signed-in caller
// -----------------------------------------------------------------------------

function isBagStatus(value: unknown): value is BagStatus {
  return value === 'DRAFT' || value === 'ACTIVE' || value === 'ARCHIVED';
}

function isChainId(value: string | undefined): value is ChainId {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

/**
 * Phase 17 — resolves a create payload's composition symbols against the
 * VERIFIED asset registry so `mapCreateBagRequestToRecipeInput` can give
 * real `chain`/`address`/`decimals` instead of always falling back to
 * `__PENDING__`. Server-side and registry-sourced only — nothing here ever
 * reads chain/address off the request body per-asset, only the symbol.
 *
 * Production-hardening P0-3 — CHAIN-SAFE, no cross-chain fallback. Only
 * resolves a symbol against a VERIFIED asset on `bagChain` itself. An
 * earlier revision of this function had a second pass that filled any
 * symbol still unresolved from ANY other chain's registry entry — so a bag
 * created on `ethereum` whose composition included a symbol that only
 * existed as a VERIFIED asset on, say, `robinhood`, would silently resolve
 * to the Robinhood deployment's address while everything else on the
 * recipe stayed on Ethereum. `validateBasketRecipe()`'s `ASSET_CHAIN_MISMATCH`
 * check (lib/domain/basket-protocol/validation/validators.ts) already
 * rejects that specific shape at publish time today, so this was never
 * observed to actually corrupt a persisted recipe — but it's still the
 * wrong place to discover the problem: the creator gets a confusing
 * "asset is on X, but the recipe is on Y" error for a symbol they may not
 * even realize doesn't exist on their chosen chain, instead of a direct
 * "not available on this network". Removing the cross-chain pass makes an
 * unresolved symbol fall through to the SAME `__PENDING__` /
 * `INVALID_ADDRESS` path every genuinely-unregistered symbol already took
 * — one honest failure mode, not two.
 *
 * A symbol registered as VERIFIED on more than one chain (e.g. a stable-
 * coin deployed on both `ethereum` and `base`) still resolves correctly:
 * this only ever looks at the `bagChain` entry for it.
 */
async function buildAssetAddressLookup(
  admin: ReturnType<typeof supabaseAdmin>,
  composition: CreateBagApiRequest['composition'],
  bagChain: ChainId
): Promise<AssetAddressLookup> {
  const wantedSymbols = new Set(composition.map((pos) => pos.symbol.toUpperCase()));
  if (wantedSymbols.size === 0) return {};

  // Scoped to the bag's own chain up front — a VERIFIED asset on any OTHER
  // chain is never even fetched here, let alone used as a fallback.
  const verifiedOnChain = await listAssets(admin, { status: 'VERIFIED', chain: bagChain });

  const lookup: AssetAddressLookup = {};
  for (const asset of verifiedOnChain) {
    const key = asset.symbol.toUpperCase();
    if (wantedSymbols.has(key) && !lookup[key]) {
      lookup[key] = { chain: asset.chain, address: asset.address, decimals: asset.decimals };
    }
  }

  return lookup;
}

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const mine = searchParams.get('mine') === '1' || searchParams.get('mine') === 'true';
  const statusParam = searchParams.get('status');

  const admin = supabaseAdmin();

  let creatorId: string | undefined;
  if (mine) {
    const auth = await requireSession();
    if (!auth.ok) return auth.response;
    creatorId = auth.session.userId;
  }

  // A `status` filter is only honoured on the caller's OWN listing. The
  // public listing is ACTIVE-only — `?status=DRAFT` used to return every
  // creator's unpublished Bags (names, compositions, creator ids).
  const bags = await listBags(admin, {
    creatorId,
    status: mine ? (isBagStatus(statusParam) ? statusParam : undefined) : 'ACTIVE',
  });

  const versions = await Promise.all(bags.map((bag) => getCurrentBagVersion(admin, bag.id)));
  const versionsById = new Map(bags.map((bag, i) => [bag.id, versions[i]]));

  const [assetsByKey, creatorsById, navSummaries, socialCounts, verification] = await Promise.all([
    loadRecipeAssets(admin, versions),
    loadCreatorProfiles(admin, bags.map((b) => b.creatorId)),
    // TVL + 7D/30D/YTD from recorded NAV snapshots, one query for the whole
    // list. A failure (e.g. migration 0045 not applied) only hides them.
    getNavSummaries(admin, bags.map((b) => b.id)).catch(() => new Map()),
    getBagSocialCounts(admin, bags.map((b) => b.id)).catch(() => new Map()),
    // How current each Bag is against the chain (wallet reconciliation). A failure only hides it.
    getBagVerification(admin, bags.map((b) => b.id)).catch(() => new Map()),
  ]);
  return NextResponse.json(
    {
      bags: mapBagRecordsToApiResponse(bags, versionsById, creatorsById, assetsByKey, navSummaries, socialCounts).map((b) => {
        const v = verification.get(b.id);
        return v ? { ...b, verification: v } : b;
      }),
    },
    { status: 200 }
  );
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as CreateBagApiRequest | null;
  if (!body || typeof body.name !== 'string' || !body.name.trim() || !Array.isArray(body.composition)) {
    return NextResponse.json({ error: 'name and composition are required.' }, { status: 400 });
  }
  // Lineage is never accepted here: it decides who is paid the fork royalty. Refuse it explicitly rather than
  // silently ignoring it, so a client cannot believe it created a fork. Forks: POST /api/bags/:id/fork.
  if ('parentBagId' in body || 'rootBagId' in body) {
    return NextResponse.json({ error: 'parentBagId/rootBagId cannot be set here. To fork a Bag, use POST /api/bags/:id/fork.' }, { status: 400 });
  }
  const textIssue = validateBagText({ name: body.name, description: body.description, thesis: body.thesis });
  if (textIssue) return NextResponse.json({ error: textIssue }, { status: 400 });

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `bag-create:${auth.session.userId}`, CREATE_RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  // Drafts are free; cap undeployed ones per wallet so a bot can't flood the
  // table. Deploying (which costs the on-chain creation fee) frees the slot.
  const recentDrafts = await countRecentDraftBags(admin, auth.session.userId, new Date(Date.now() - DRAFT_WINDOW_MS).toISOString());
  if (recentDrafts >= MAX_RECENT_DRAFTS) {
    return NextResponse.json(
      { error: `You have ${recentDrafts} bags that were never deployed. Deploy one of them first, or try again tomorrow.`, code: 'TOO_MANY_DRAFTS' },
      { status: 429 }
    );
  }
  const bagChain: ChainId = isChainId(body.chain) ? body.chain : 'ethereum';
  const assetsByAddress = await buildAssetAddressLookup(admin, body.composition, bagChain);
  const input = mapCreateBagRequestToRecipeInput(body, auth.session.userId, assetsByAddress);
  const result = await createBag(admin, input);

  if (!result.ok) {
    switch (result.error) {
      case 'VALIDATION_FAILED':
        return NextResponse.json({ error: 'Recipe validation failed.', issues: result.issues }, { status: 422 });
      case 'DUPLICATE_SLUG':
        return NextResponse.json({ error: result.message }, { status: 409 });
      case 'DB_ERROR':
        return NextResponse.json({ error: result.message }, { status: 502 });
    }
  }

  const [assetsByKey, creators] = await Promise.all([
    loadRecipeAssets(admin, [result.version]),
    loadCreatorProfiles(admin, [result.bag.creatorId]),
  ]);
  const bag = mapBagRecordToApiResponse(result.bag, result.version, { assetsByKey, creator: creators.get(result.bag.creatorId) });
  return NextResponse.json({ bag }, { status: 201 });
}
