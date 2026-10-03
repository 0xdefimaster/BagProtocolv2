// -----------------------------------------------------------------------------
// scripts/seed-bag-holdings.ts — development-only holdings bootstrap.
//
// Phase 7 explicitly has no mint/redeem yet (spec section 15), so there is
// no real event that produces a Bag's actual holdings. This script exists
// so local dev/demo environments can still see a non-empty NAV for an
// ACTIVE bag, WITHOUT opening a "client sends arbitrary quantities" write
// path anywhere (spec section 10: "Production'da client'ın BTC=1000000
// gönderip arbitrary holding oluşturmasına izin verme"):
//
//   - Quantities are derived deterministically from each recipe asset's
//     `weightBps` and a fixed notional ($10,000) — NOT read from any
//     request body, NOT arbitrary. This is a development bootstrap
//     convenience, explicitly not a rebalance or a real allocation.
//   - `setBagHoldings()` (lib/server/bag-holdings.ts) is called with the
//     BAG'S OWN creator id (read from the bag row itself, never supplied
//     by a caller) — so this script still exercises the real
//     ownership + verified-asset gate, it just authenticates "as" the
//     bag's actual owner because that's who a dev bootstrap legitimately
//     acts on behalf of.
//   - Bags with any unverified asset are skipped and reported, never
//     silently forced through (same "report, don't hide" policy
//     scripts/seed-bags.ts already established).
//
// Run with: npx tsx scripts/seed-bag-holdings.ts
// -----------------------------------------------------------------------------

import './load-env';
import { AssetIdentity } from '@/types/basket-protocol';
import { findUnverifiedIdentities } from '@/lib/domain/basket-protocol/validation/registry-validation';
import { getVerifiedIdentityKeys } from '@/lib/server/asset-repo';
import { getBagById, getCurrentBagVersion, listBags } from '@/lib/server/bag-repo';
import { setBagHoldings } from '@/lib/server/bag-holdings';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';

const NOTIONAL_USD = 10_000;
// Deterministic placeholder price per whole unit — NOT a real market price,
// purely so `quantityRaw` has a plausible, non-zero, non-arbitrary value to
// seed with. Real prices come from a PriceProvider (Phase 5) at NAV time,
// never from this script.
const ASSUMED_UNIT_PRICE_USD = 100;

async function main() {
  if (!isSupabaseConfigured()) {
    console.error('Supabase is not configured (see .env.example). Set it before running this script.');
    process.exitCode = 1;
    return;
  }

  const admin = supabaseAdmin();
  const activeBags = await listBags(admin, { status: 'ACTIVE' });

  console.log(`\nSeeding dev holdings for ${activeBags.length} ACTIVE bag(s).\n`);

  let seeded = 0;
  let skipped = 0;

  for (const bagSummary of activeBags) {
    const bag = await getBagById(admin, bagSummary.id);
    if (!bag) continue; // shouldn't happen, but stay defensive

    const version = await getCurrentBagVersion(admin, bag.id);
    if (!version) {
      console.log(`  SKIPPED  ${bag.name} — no current version.`);
      skipped++;
      continue;
    }

    const identities: AssetIdentity[] = version.recipe.assets.map((a) => ({ chain: a.chain, address: a.address }));
    const verified = await getVerifiedIdentityKeys(admin, identities);
    const unverified = findUnverifiedIdentities(identities, verified);
    if (unverified.length > 0) {
      console.log(`  SKIPPED  ${bag.name} — unverified asset(s): ${unverified.map((u) => `${u.chain}:${u.address}`).join(', ')}`);
      skipped++;
      continue;
    }

    const holdings = version.recipe.assets.map((asset) => {
      const targetUsd = (NOTIONAL_USD * asset.weightBps) / 10_000;
      const wholeUnits = targetUsd / ASSUMED_UNIT_PRICE_USD;
      const quantityRaw = BigInt(Math.round(wholeUnits * 10 ** asset.decimals)).toString();
      return { asset: { chain: asset.chain, address: asset.address }, quantityRaw, decimals: asset.decimals };
    });

    const result = await setBagHoldings(admin, bag.creatorId, bag.id, holdings);
    if (!result.ok) {
      console.log(`  FAILED   ${bag.name} — ${result.error}`);
      skipped++;
      continue;
    }

    console.log(`  OK       ${bag.name} — ${result.holdings.length} holding(s) seeded.`);
    seeded++;
  }

  console.log(`\nSeeded ${seeded}, skipped ${skipped}.\n`);
  if (skipped > 0 && seeded === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
