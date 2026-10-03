// -----------------------------------------------------------------------------
// scripts/import-coingecko-assets.ts — cryptocurrency counterpart to
// scripts/import-robinhood-assets.ts. Same dry-run-by-default / --apply
// convention, same reasoning: review the diff before anything touches
// Supabase.
//
// Requires 0020_add_asset_type.sql to be applied first (see that file) —
// every insert here sets asset_type='crypto', which the column-level
// `check` constraint didn't allow before that migration.
//
// Run with:
//   npx tsx scripts/import-coingecko-assets.ts --chain=ethereum              # dry run
//   npx tsx scripts/import-coingecko-assets.ts --chain=base --apply          # actually registers
//   npx tsx scripts/import-coingecko-assets.ts --chain=arbitrum --apply
//
// COINGECKO_API_KEY (see .env.example, already used by
// lib/domain/basket-protocol/pricing/coingecko-provider.ts) is optional but
// strongly recommended here — without one, this makes 40+ throttled
// requests against CoinGecko's public rate limit and takes a while.
// Requires Supabase env vars (NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY) only for --apply, same as the Robinhood
// importer.
// -----------------------------------------------------------------------------

import './load-env';
import { listAssets, registerAsset } from '@/lib/server/asset-repo';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import {
  applyCoinImportPlan,
  CoinTargetChain,
  fetchCoinCandidatesForChain,
  planCoinImportForChain,
} from '@/lib/domain/basket-protocol/registry/coingecko-import';

const SUPPORTED_CHAINS: CoinTargetChain[] = ['ethereum', 'base', 'arbitrum'];

function parseChainArg(): CoinTargetChain {
  const arg = process.argv.find((a) => a.startsWith('--chain='));
  const chain = arg ? arg.slice('--chain='.length) : undefined;
  if (!chain || !(SUPPORTED_CHAINS as string[]).includes(chain)) {
    throw new Error(
      `Usage: npx tsx scripts/import-coingecko-assets.ts --chain=<${SUPPORTED_CHAINS.join('|')}> [--apply]`
    );
  }
  return chain as CoinTargetChain;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const chain = parseChainArg();
  const apiKey = process.env.COINGECKO_API_KEY || undefined;

  console.log(
    `Resolving ${chain} deployments for the local coin list via CoinGecko` +
      (apiKey ? '' : ' (no COINGECKO_API_KEY set — this will be slow, throttled to respect the free tier)') +
      '...'
  );

  const candidateResult = await fetchCoinCandidatesForChain(chain, { apiKey });
  console.log(`  ${candidateResult.candidates.length} resolved, ${candidateResult.skipped.length} skipped.`);

  let existing: Awaited<ReturnType<typeof listAssets>> = [];
  if (isSupabaseConfigured()) {
    existing = await listAssets(supabaseAdmin(), { chain, assetType: 'crypto', limit: 1000 });
  } else {
    console.log('  Supabase not configured — planning against an empty existing-registry set.');
  }

  const plan = planCoinImportForChain(candidateResult, existing);

  console.log('\nPlan:');
  console.log(`  toRegister:        ${plan.toRegister.length}`);
  console.log(`  alreadyRegistered: ${plan.alreadyRegistered.length}`);
  console.log(`  skipped:           ${plan.skipped.length}`);

  if (plan.toRegister.length > 0) {
    console.log('\nWould register:');
    for (const a of plan.toRegister) {
      console.log(`  ${a.symbol.padEnd(8)} ${a.address}  ${a.name}`);
    }
  }
  if (plan.skipped.length > 0) {
    console.log('\nSkipped (review):');
    for (const s of plan.skipped) {
      console.log(`  ${s.symbol.padEnd(8)} ${s.reason}${s.detail ? ` — ${s.detail}` : ''}`);
    }
  }

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
  const result = await applyCoinImportPlan((input) => registerAsset(admin, input), plan);

  console.log(`\nRegistered: ${result.registered.length}`);
  if (result.failed.length > 0) {
    console.log(`Failed: ${result.failed.length}`);
    for (const f of result.failed) {
      console.log(`  ${f.input.symbol} ${f.input.address}: ${f.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
