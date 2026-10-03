// -----------------------------------------------------------------------------
// scripts/import-robinhood-assets.ts — Robinhood Stock Token registry -> BAG
// Asset Registry (`assets` table), replacing the need for a hand-maintained
// static NVDA/AAPL/MSFT list.
//
//   GET https://api.robinhood.com/rhj/assets   (live, per docs.robinhood.com)
//        |
//        v
//   planRobinhoodImport()   — pure diff against what's already registered
//        |
//        v
//   prints the plan (new / already-registered / possibly-delisted / skipped)
//        |
//        v
//   only writes anything if run with --apply
//
// Default is a DRY RUN. Nothing is written to Supabase unless you pass
// --apply, same "review before you touch prod data" spirit as
// `seed-bags.ts` reporting PERSISTED/FAILED per bag instead of silently
// skipping failures.
//
// Run with:
//   npx tsx scripts/import-robinhood-assets.ts                        # dry run, robinhood (default)
//   npx tsx scripts/import-robinhood-assets.ts --apply                 # actually registers, robinhood
//   npx tsx scripts/import-robinhood-assets.ts --chain=arbitrum        # dry run, arbitrum
//   npx tsx scripts/import-robinhood-assets.ts --chain=arbitrum --apply
//
// --chain selects which chain id's `deployments[]` entry to register each
// asset under — see ROBINHOOD_TRACKED_CHAIN_IDS in robinhood-import.ts for
// which chains are supported and why (same live feed either way, just a
// different deployment picked out of the same response).
//
// Requires the same env vars as any other server-side Supabase call
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — see .env.example)
// when run with --apply. Not required for a dry run beyond network access
// to api.robinhood.com.
//
// Before running --apply for the first time: `chain` has a database-level
// `check (chain in (...))` constraint on the `assets` table (and three
// others) that does not yet include 'robinhood', and `assets` has no
// `current_multiplier` column yet — see supabase/migrations/
// 0002_add_robinhood_chain.sql and 0003_add_asset_current_multiplier.sql.
// Both migrations must be applied to your Supabase project first, or every
// insert here will fail.
// -----------------------------------------------------------------------------

import './load-env';
import { listAssets, registerAsset, updateAssetMultiplier, updateAssetLogoUrl } from '@/lib/server/asset-repo';
import { applyLogoUpdates } from '@/lib/domain/basket-protocol/registry/logo-url';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import {
  applyMultiplierUpdates,
  applyRobinhoodImportPlan,
  fetchRobinhoodAssets,
  planRobinhoodImportForChain,
  ROBINHOOD_TRACKED_CHAIN_IDS,
} from '@/lib/domain/basket-protocol/registry/robinhood-import';
import { ChainId } from '@/types/basket-protocol';
import { reconcileCorporateActions, RobinhoodStockApi } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';

function parseChainArg(): ChainId {
  const arg = process.argv.find((a) => a.startsWith('--chain='));
  const chain = (arg ? arg.slice('--chain='.length) : 'robinhood') as ChainId;
  if (!(chain in ROBINHOOD_TRACKED_CHAIN_IDS)) {
    throw new Error(
      `Unsupported --chain "${chain}". Supported: ${Object.keys(ROBINHOOD_TRACKED_CHAIN_IDS).join(', ')} ` +
        '(see ROBINHOOD_TRACKED_CHAIN_IDS in robinhood-import.ts).'
    );
  }
  return chain;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const chain = parseChainArg();

  console.log(`Fetching live Robinhood Stock Token registry (targeting chain "${chain}")...`);
  const remote = await fetchRobinhoodAssets();
  console.log(`  ${remote.length} assets on the feed.`);

  let existing: Awaited<ReturnType<typeof listAssets>> = [];
  if (isSupabaseConfigured()) {
    existing = await listAssets(supabaseAdmin(), { chain, limit: 1000 });
  } else {
    console.log('  Supabase not configured — planning against an empty existing-registry set.');
  }

  const plan = planRobinhoodImportForChain(remote, existing, chain);

  console.log('\nPlan:');
  console.log(`  toRegister:        ${plan.toRegister.length}`);
  console.log(`  alreadyRegistered: ${plan.alreadyRegistered.length}`);
  console.log(`  multiplierUpdates: ${plan.multiplierUpdates.length}`);
  console.log(`  logoUpdates:       ${plan.logoUpdates.length}`);
  console.log(`  possiblyDelisted:  ${plan.possiblyDelisted.length} (review manually — not auto-touched)`);
  console.log(`  skipped:           ${plan.skipped.length}`);

  if (plan.toRegister.length > 0) {
    console.log('\nWould register:');
    for (const a of plan.toRegister) {
      console.log(`  ${a.symbol.padEnd(8)} ${a.address}  ${a.name}`);
    }
  }
  if (plan.multiplierUpdates.length > 0) {
    console.log('\nMultiplier changed on the remote feed (split/reverse-split):');
    for (const u of plan.multiplierUpdates) {
      console.log(`  ${u.asset.symbol.padEnd(8)} ${u.previousMultiplier ?? '(none)'} -> ${u.newMultiplier}`);
    }
  }
  if (plan.possiblyDelisted.length > 0) {
    console.log('\nCurrently VERIFIED but not on the active feed anymore (needs a human look):');
    for (const a of plan.possiblyDelisted) {
      console.log(`  ${a.symbol.padEnd(8)} ${a.address}  ${a.name}`);
    }
  }

  if (chain === 'robinhood') await printCorporateActions(existing);

  if (!apply) {
    console.log('\nDry run only — re-run with --apply to write toRegister to the registry.');
    return;
  }

  if (!isSupabaseConfigured()) {
    console.error('\n--apply requires Supabase env vars to be set (see .env.example). Aborting.');
    process.exitCode = 1;
    return;
  }

  const admin = supabaseAdmin();
  const result = await applyRobinhoodImportPlan((input) => registerAsset(admin, input), plan);

  console.log(`\nRegistered: ${result.registered.length}`);
  if (result.failed.length > 0) {
    console.log(`Failed: ${result.failed.length}`);
    for (const f of result.failed) {
      console.log(`  ${f.input.symbol} ${f.input.address}: ${f.error}`);
    }
    process.exitCode = 1;
  }

  const multiplierResult = await applyMultiplierUpdates(
    (id, currentMultiplier) => updateAssetMultiplier(admin, id, currentMultiplier),
    plan
  );
  console.log(`Multipliers synced: ${multiplierResult.updated.length}`);
  if (multiplierResult.failed.length > 0) {
    console.log(`Multiplier sync failed: ${multiplierResult.failed.length}`);
    for (const f of multiplierResult.failed) {
      console.log(`  ${f.update.asset.symbol}: ${f.error}`);
    }
    process.exitCode = 1;
  }

  const logoResult = await applyLogoUpdates((id, logoUrl) => updateAssetLogoUrl(admin, id, logoUrl), plan.logoUpdates);
  console.log(`Logos synced: ${logoResult.updated.length}`);
  for (const f of logoResult.failed) {
    console.log(`  Logo sync failed ${f.update.asset.symbol}: ${f.error}`);
    process.exitCode = 1;
  }
}

/** Corporate actions vs registry vs locally stored multipliers (read-only report). */
async function printCorporateActions(existing: Awaited<ReturnType<typeof listAssets>>) {
  const api = new RobinhoodStockApi();
  try {
    const [actions, tokens] = await Promise.all([api.corporateActions(), api.allTokens()]);
    const local = Object.fromEntries(existing.map((a) => [a.address.toLowerCase(), a.currentMultiplier]));
    const r = reconcileCorporateActions(actions, tokens, local);
    console.log(`\nCorporate actions: ${actions.length} (${r.matched.length} for registry Stock Tokens)`);
    for (const p of r.pendingMultiplierChanges) {
      console.log(`  PENDING multiplier ${p.token.symbol}: ${p.token.currentMultiplier} -> ${p.pendingMultiplier}${p.effectiveTime ? ` on ${p.effectiveTime}` : ''}`);
    }
    for (const d of r.multiplierDrift) console.log(`  DRIFT ${d.address}: local ${d.local} vs registry ${d.registry} (re-run with --apply)`);
    for (const m of r.identityMismatch) console.log(`  IDENTITY MISMATCH ${m.tokenSymbol} ${m.contractAddress} (${m.type}) — not a registry contract, ignored`);
  } catch (err) {
    console.log(`\nCorporate actions: unavailable (${(err as Error).message})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
