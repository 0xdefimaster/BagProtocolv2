import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { countRecentDraftBags, createForkBag, DRAFT_WINDOW_MS, getBagById, getCurrentBagVersion, isBagNameAvailable, MAX_RECENT_DRAFTS } from '@/lib/server/bag-repo';
import { mapBagRecordToApiResponse } from '@/lib/mappers/bag-mapper';
import { loadRecipeAssets } from '@/lib/server/bag-asset-context';
import { loadCreatorProfiles } from '@/lib/server/user-profile-repo';
import { validateBagText } from '@/lib/server/bag-text';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const FORK_RATE_LIMIT = { windowSeconds: 3600, maxRequests: 30 };

// -----------------------------------------------------------------------------
// Fork a Bag: copy the source bag's CURRENT recipe into a brand-new Bag
// owned by the caller, reusing the existing parent_bag_id/root_bag_id
// columns — no new fork table, per the plan.
//
//   1. load source bag (404 if missing)
//   2. visibility check — only ACTIVE bags are forkable by someone other
//      than the creator; a creator can fork their own DRAFT
//   3. new owner = the caller's session
//   4. lineage derived from the server-loaded source only (createForkBag ->
//      forkLineageOf): parent = source.id, root = source.rootBagId ?? source.id
//   5. copy the current version's recipe verbatim, except name/symbol,
//      which the caller may override
//   6. createForkBag() re-validates the copied recipe and writes a fresh v1
//      version for the new bag (a fork is a new lineage, not a shared
//      version history)
// -----------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `bag-fork:${auth.session.userId}`, FORK_RATE_LIMIT);
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
  const source = await getBagById(admin, id);
  if (!source) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  const isOwner = source.creatorId === auth.session.userId;
  if (source.status !== 'ACTIVE' && !isOwner) {
    return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  }

  const sourceVersion = await getCurrentBagVersion(admin, source.id);
  if (!sourceVersion) {
    return NextResponse.json({ error: 'Source bag has no composition to fork.' }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { name?: string; reason?: string };
  const textIssue = validateBagText({ name: body.name });
  if (textIssue) return NextResponse.json({ error: textIssue }, { status: 400 });
  const name = body.name?.trim() || (await defaultForkName(admin, source.name));
  const symbol =
    name
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 8)
      .toUpperCase() || 'BAG';

  const result = await createForkBag(admin, {
    slug: `${source.slug}-fork-${crypto.randomUUID().slice(0, 6)}`,
    creatorId: auth.session.userId,
    mutability: source.mutability,
    // DRAFT: a fork is a NEW Bag with its own creator-bound on-chain identity
    // (keccak256(abi.encode(forker's wallet, this new Bag's offChainRef))) —
    // it is not automatically deployed just because the source Bag is. See
    // lib/mappers/bag-mapper.ts's mapCreateBagRequestToRecipeInput().
    status: 'DRAFT',
    reason: body.reason?.trim() || `Forked from ${source.name}`,
    recipe: {
      name,
      symbol,
      description: sourceVersion.recipe.description,
      chain: sourceVersion.recipe.chain,
      // Forks copy the parent's strategy type — only one exists today, but
      // this makes the copy exact rather than silently re-defaulting.
      strategyType: sourceVersion.recipe.strategyType,
      assets: sourceVersion.recipe.assets,
      rebalanceRule: sourceVersion.recipe.rebalanceRule,
      minInvestment: sourceVersion.recipe.minInvestment,
      maxAssets: sourceVersion.recipe.maxAssets,
      minWeightBps: sourceVersion.recipe.minWeightBps,
      maxWeightBps: sourceVersion.recipe.maxWeightBps,
      mutability: source.mutability,
      // Deliberately NOT copied from the source — this is a new creator's
      // fork, not the original creator's bag. Starting at 0 avoids silently
      // charging the forker's depositors a fee the forker never chose. The
      // root creator's royalty is a share of THIS fee when the forker sets
      // one (lib/config/rewards.ts FORK_ROYALTY_FEE_SHARE_BPS): a fork kept
      // at 0% pays no royalty.
      performanceFeeBps: 0,
    },
  }, source, sourceVersion.version);

  if (!result.ok) {
    switch (result.error) {
      case 'VALIDATION_FAILED':
        return NextResponse.json({ error: 'Forked recipe failed validation.', issues: result.issues }, { status: 422 });
      case 'DUPLICATE_SLUG':
        return NextResponse.json({ error: result.message }, { status: 409 });
      case 'DUPLICATE_NAME':
        return NextResponse.json({ error: result.message, code: 'DUPLICATE_NAME' }, { status: 409 });
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

/**
 * Bag names are unique (migration 0058): the first of "X (Fork)", "X (Fork 2)", … that is free. Past the last
 * candidate the plain name is returned and the insert reports DUPLICATE_NAME, asking the forker for a name.
 */
async function defaultForkName(admin: ReturnType<typeof supabaseAdmin>, sourceName: string): Promise<string> {
  // Recipe names are at most 64 characters (validateBasketRecipe); " (Fork 20)" needs 10.
  const base = sourceName.trim().slice(0, 54);
  for (let i = 1; i <= 20; i++) {
    const candidate = i === 1 ? `${base} (Fork)` : `${base} (Fork ${i})`;
    if (await isBagNameAvailable(admin, candidate)) return candidate;
  }
  return `${base} (Fork)`;
}
