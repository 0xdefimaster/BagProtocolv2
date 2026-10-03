// -----------------------------------------------------------------------------
// scripts/seed-bags.ts — mock Bag -> persisted BagRecord migration.
//
//   mock Bag (lib/mock-data.ts)
//        |
//        v
//   buildRecipeFromBag()        (lib/domain/basket-protocol/recipe.ts)
//        |
//        v
//   validateBasketRecipe()      (lib/domain/basket-protocol/validation)
//        |
//        v
//   createBag()                 (lib/server/bag-repo.ts — validates again,
//        |                       atomically inserts bags + bag_versions v1)
//        v
//   persisted BagRecord + BagVersionRecord
//
// This does NOT silently skip bags that fail validation — every bag is
// reported as PERSISTED or FAILED, with the exact validation issues, and
// the script exits non-zero if anything failed. It also does not fabricate
// data to force bags through: mock assets (lib/create-assets-data.ts) have
// no on-chain chain/address/decimals, and `buildRecipeFromBag()` fills that
// gap with a `__PENDING__` placeholder address per asset (see recipe.ts) —
// which `validateBasketRecipe()` correctly rejects as INVALID_ADDRESS. So,
// as written today, EVERY mock bag is expected to fail with INVALID_ADDRESS
// unless real addresses are supplied via `ASSET_ADDRESS_MAP` below.
//
// That's not a bug in this script — it's an accurate reflection of the
// Phase 1 audit finding: the mock asset catalog (NVDA, MSFT, TSLA, ARB, OP,
// MKR, LDO, ONDO, GHO, ...) mixes real equities (which have no on-chain
// address at all) with tokens whose real mainnet addresses aren't verified
// anywhere in this codebase. Hardcoding guessed contract addresses for a
// protocol meant to eventually execute real trades would be actively
// dangerous, so this script does not do that. `ASSET_ADDRESS_MAP` is left
// empty and pluggable: once a real, verified address list exists (Phase 4+
// chain integration), populate it and every eligible bag will seed cleanly
// with no other change to this script.
//
// Run with: npx tsx scripts/seed-bags.ts
// Requires the same env vars as any other server-side Supabase call
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — see .env.example).
// -----------------------------------------------------------------------------

import './load-env';
import { mockBags, mockUserBags } from '@/lib/mock-data';
import { Bag } from '@/types';
import { ChainId } from '@/types/basket-protocol';
import { buildRecipeFromBag } from '@/lib/domain/basket-protocol/recipe';
import { validateBasketRecipe } from '@/lib/domain/basket-protocol/validation';
import { createBag } from '@/lib/server/bag-repo';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';

// Populate with verified { SYMBOL: { address, decimals } } entries when a
// real, checked deployment list exists. Deliberately empty for now — see
// the file header for why this script refuses to guess.
const ASSET_ADDRESS_MAP: Partial<Record<string, { address: string; decimals: number }>> = {};

const SEED_CHAIN: ChainId = 'ethereum';

function slugify(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base}-${suffix}`;
}

interface SeedOutcome {
  mockBagId: string;
  name: string;
  status: 'PERSISTED' | 'VALIDATION_FAILED' | 'DB_ERROR' | 'SKIPPED_DUPLICATE';
  bagId?: string;
  slug?: string;
  issues?: string[];
}

async function ensureCreatorUserId(
  admin: ReturnType<typeof supabaseAdmin>,
  walletAddress: string,
  displayName: string
): Promise<string> {
  // Mock creators are display-only objects (`CreatorProfile` in
  // types/index.ts), not real `users` rows — but `bags.creator_id`
  // references `users(id)` not null, so seeding needs a real row to point
  // at. Upsert on the existing unique `wallet_address` column rather than
  // inventing a second identity system, per spec section 4 ("use the
  // existing user system, don't create a new creator identity system").
  const { data, error } = await admin
    .from('users')
    .upsert({ wallet_address: walletAddress, display_name: displayName }, { onConflict: 'wallet_address' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to ensure creator user for ${walletAddress}: ${error.message}`);
  return data.id as string;
}

async function seedOne(admin: ReturnType<typeof supabaseAdmin>, bag: Bag, seenSlugs: Set<string>): Promise<SeedOutcome> {
  const recipe = buildRecipeFromBag({ bag, chain: SEED_CHAIN, mutability: 'MUTABLE', assetsByAddress: ASSET_ADDRESS_MAP });

  const validation = validateBasketRecipe(recipe);
  const errors = validation.issues.filter((i) => i.severity === 'ERROR');
  if (errors.length > 0) {
    return {
      mockBagId: bag.id,
      name: bag.name,
      status: 'VALIDATION_FAILED',
      issues: errors.map((i) => `${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`),
    };
  }

  let slug = slugify(bag.name, bag.id);
  while (seenSlugs.has(slug)) slug = `${slug}-dup`;
  seenSlugs.add(slug);

  const creatorId = await ensureCreatorUserId(admin, bag.creator.address, bag.creator.name);

  const { id, bagId, version, createdAt, ...recipeInput } = recipe;
  const result = await createBag(admin, {
    slug,
    creatorId,
    mutability: recipe.mutability,
    status: 'ACTIVE', // mock bags represent already-published, "real" bags in the UI today
    recipe: recipeInput,
    reason: 'Migrated from lib/mock-data.ts',
  });

  if (!result.ok) {
    if (result.error === 'DUPLICATE_SLUG') {
      return { mockBagId: bag.id, name: bag.name, status: 'SKIPPED_DUPLICATE', slug };
    }
    if (result.error === 'VALIDATION_FAILED') {
      return {
        mockBagId: bag.id,
        name: bag.name,
        status: 'VALIDATION_FAILED',
        issues: result.issues.filter((i) => i.severity === 'ERROR').map((i) => `${i.code}: ${i.message}`),
      };
    }
    return { mockBagId: bag.id, name: bag.name, status: 'DB_ERROR', issues: [result.message] };
  }

  return { mockBagId: bag.id, name: bag.name, status: 'PERSISTED', bagId: result.bag.id, slug: result.bag.slug };
}

async function main() {
  if (!isSupabaseConfigured()) {
    console.error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    console.error('Set them (see .env.example) before running this script.');
    process.exitCode = 1;
    return;
  }

  const admin = supabaseAdmin();

  // De-dupe by id — mockUserBags reuses mockBags[0]/[1] by reference plus
  // one bag with a fresh id ('4'), so seed each distinct mock bag once.
  const byId = new Map<string, Bag>();
  for (const bag of [...mockBags, ...mockUserBags]) byId.set(bag.id, bag);

  const seenSlugs = new Set<string>();
  const outcomes: SeedOutcome[] = [];
  for (const bag of byId.values()) {
    outcomes.push(await seedOne(admin, bag, seenSlugs));
  }

  const persisted = outcomes.filter((o) => o.status === 'PERSISTED');
  const failed = outcomes.filter((o) => o.status !== 'PERSISTED');

  console.log(`\nSeeded ${persisted.length}/${outcomes.length} mock bags.\n`);

  for (const o of outcomes) {
    if (o.status === 'PERSISTED') {
      console.log(`  OK       ${o.name} (mock id ${o.mockBagId}) -> bags.id=${o.bagId} slug=${o.slug}`);
    } else {
      console.log(`  ${o.status.padEnd(19)} ${o.name} (mock id ${o.mockBagId})`);
      for (const issue of o.issues ?? []) console.log(`             - ${issue}`);
    }
  }

  if (failed.length > 0) {
    console.log(
      `\n${failed.length} bag(s) were NOT persisted — see issues above. This is expected while ` +
        `ASSET_ADDRESS_MAP in this script is empty (see the file header comment); it is not a script bug.`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
