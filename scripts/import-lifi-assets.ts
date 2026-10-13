// -----------------------------------------------------------------------------
// scripts/import-lifi-assets.ts — LI.FI's own per-chain token list -> BAG
// Asset Registry (`assets` table), for the curated `LOCAL_COIN_CANDIDATES`
// symbol list (lib/domain/basket-protocol/registry/coingecko-import.ts).
// Same plan/apply shape and dry-run-by-default safety as
// import-robinhood-assets.ts.
//
//   getTokens() (one call per chain, LI.FI's FULL known list for it)
//        |
//        v
//   filtered locally to LOCAL_COIN_CANDIDATES symbols only
//        |
//        v
//   planLiFiImportForChain()   — pure diff against what's already registered
//        |
//        v
//   prints the plan
//        |
//        v
//   only writes anything if run with --apply
//
// Run with:
//   npx tsx scripts/import-lifi-assets.ts                    # dry run, ethereum (default)
//   npx tsx scripts/import-lifi-assets.ts --chain=base --apply
//   npx tsx scripts/import-lifi-assets.ts --chain=arbitrum
//   npx tsx scripts/import-lifi-assets.ts --chain=arbitrum --apply --deprecate-stale
//
// A symbol match alone is never enough (see ACCEPTED_NAMES in
// lifi-import.ts): the native gas token, LI.FI-flagged tokens, name
// mismatches, tiny market caps and symbols with more than one plausible
// contract are all skipped and printed with their reason.
//
// --deprecate-stale marks VERIFIED rows that no longer pass those checks
// (e.g. impostors let in by an earlier symbol-only run) as DEPRECATED, so
// they disappear from Create. Rows are never deleted.
//
// Supported --chain values: ethereum, base, arbitrum, robinhood. On
// robinhood only crypto tokens (WETH, USDG, ...) are imported; Stock Tokens
// stay with import-robinhood-assets.ts, which is Robinhood's own source.
//
// Tokenized stocks on ethereum / base / arbitrum (LI.FI's `rwa` tag, or a known
// issuer's naming: Backed "Backed …"/bNVDA, xStocks "… xStock"/NVDAx, Ondo
// "… (Ondo Tokenized)"/NVDAon; the dry run prints which one matched):
//   npx tsx scripts/import-lifi-assets.ts --stocks --chain=base                    # dry run: every LI.FI-verified stock
//   npx tsx scripts/import-lifi-assets.ts --stocks --chain=base --only=TSLAx,NVDAx --apply
// Read-only lookup when a stock does not show up (prints LI.FI's name,
// verification status and tags for every symbol/name containing the term):
//   npx tsx scripts/import-lifi-assets.ts --search=NVDA --chain=arbitrum
// --apply in stock mode requires --only: the owner names, from the dry run,
// exactly which stocks become selectable in Create. Nothing else is written,
// and --deprecate-stale is refused. A symbol two LI.FI-verified stocks claim
// is skipped as ambiguous. Robinhood Stock Tokens stay with
// import-robinhood-assets.ts.
//
// LIFI_API_KEY is optional (see lib/blockchain/lifi-config.ts) but raises
// the rate limit — set it in your shell env for a production run.
// Requires NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for --apply,
// same as every other importer script.
// -----------------------------------------------------------------------------

import './load-env';
import { listAssets, registerAsset, setAssetStatus, updateAssetLogoUrl } from '@/lib/server/asset-repo';
import { applyLogoUpdates } from '@/lib/domain/basket-protocol/registry/logo-url';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import {
  applyLiFiImportPlan,
  fetchLiFiStockCandidatesForChain,
  fetchLiFiTokenCandidatesForChain,
  LiFiImportTargetChain,
  LiFiStockImportChain,
  planLiFiImportForChain,
  searchLiFiTokens,
} from '@/lib/domain/basket-protocol/registry/lifi-import';

const SUPPORTED_CHAINS: LiFiImportTargetChain[] = ['ethereum', 'base', 'arbitrum', 'robinhood'];

function parseChainArg(): LiFiImportTargetChain {
  const arg = process.argv.find((a) => a.startsWith('--chain='));
  const chain = (arg ? arg.slice('--chain='.length) : 'ethereum') as LiFiImportTargetChain;
  if (!SUPPORTED_CHAINS.includes(chain)) {
    throw new Error(`Unsupported --chain "${chain}". Supported: ${SUPPORTED_CHAINS.join(', ')}.`);
  }
  return chain;
}

const STOCK_CHAINS: LiFiStockImportChain[] = ['ethereum', 'base', 'arbitrum'];

function parseOnlyArg(): string[] {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  return arg ? arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function importStocks(chain: LiFiImportTargetChain, apply: boolean) {
  if (!(STOCK_CHAINS as string[]).includes(chain)) {
    throw new Error(`--stocks supports ${STOCK_CHAINS.join(', ')}; Robinhood Stock Tokens come from import-robinhood-assets.ts.`);
  }
  if (process.argv.includes('--deprecate-stale')) throw new Error('--deprecate-stale is not available with --stocks.');
  const only = parseOnlyArg();
  if (apply && only.length === 0) {
    throw new Error('--stocks --apply needs --only=SYM1,SYM2: name, from the dry run, exactly which stocks to register.');
  }

  console.log(`Fetching LI.FI's tokenized stocks on "${chain}"...`);
  const { candidates, skipped, fetchError } = await fetchLiFiStockCandidatesForChain(chain as LiFiStockImportChain, { only });
  if (fetchError) {
    console.error(`  Failed to fetch from LI.FI: ${fetchError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nLI.FI-verified stocks${only.length > 0 ? ' (requested)' : ''}: ${candidates.length}`);
  for (const c of candidates) {
    const cap = c.marketCapUSD === null ? 'mcap —' : `mcap $${Math.round(c.marketCapUSD).toLocaleString('en-US')}`;
    console.log(`  ${c.symbol.padEnd(10)} ${c.address}  dec ${String(c.decimals).padEnd(2)}  ${cap.padEnd(22)} price ${c.priceUSD ?? '—'}  [${c.signal}] ${c.name}`);
  }
  const notRequested = skipped.filter((s) => s.reason === 'NOT_REQUESTED').length;
  const rejected = skipped.filter((s) => s.reason !== 'NOT_REQUESTED');
  if (rejected.length > 0) {
    console.log(`\nSkipped (${rejected.length}):`);
    for (const s of rejected) console.log(`  ${s.symbol.padEnd(10)} ${s.reason.padEnd(18)} ${s.address}  ${s.name}`);
  }
  if (notRequested > 0) console.log(`\n${notRequested} other LI.FI-verified stock(s) not in --only.`);

  let existing: Awaited<ReturnType<typeof listAssets>> = [];
  if (isSupabaseConfigured()) existing = await listAssets(supabaseAdmin(), { chain, limit: 1000 });
  else console.log('  Supabase not configured — planning against an empty existing-registry set.');
  // No curated symbols: stock mode never marks an existing row stale.
  const plan = planLiFiImportForChain(candidates, existing, []);
  console.log(`\nPlan: toRegister ${plan.toRegister.length}, alreadyRegistered ${plan.alreadyRegistered.length}`);
  for (const c of plan.toRegister) console.log(`  + ${c.symbol.padEnd(10)} ${c.address}  ${c.name}`);

  if (!apply) {
    console.log('\nDry run only — re-run with --only=SYM1,SYM2 --apply to register the stocks you choose.');
    return;
  }
  if (!isSupabaseConfigured()) {
    console.error('\n--apply requires Supabase env vars to be set (see .env.example). Aborting.');
    process.exitCode = 1;
    return;
  }
  const result = await applyLiFiImportPlan((input) => registerAsset(supabaseAdmin(), input), plan);
  console.log(`\nRegistered: ${result.registered.length}`);
  for (const f of result.failed) {
    console.log(`  Failed ${f.input.symbol} ${f.input.address}: ${f.error}`);
    process.exitCode = 1;
  }
}

async function searchTokens(chain: LiFiImportTargetChain, term: string) {
  if (process.argv.includes('--apply')) throw new Error('--search is read-only; it cannot be combined with --apply.');
  console.log(`Searching LI.FI's token list on "${chain}" for "${term}"...`);
  const { matches, fetchError } = await searchLiFiTokens(chain, term);
  if (fetchError) {
    console.error(`  Failed to fetch from LI.FI: ${fetchError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nMatches: ${matches.length}`);
  for (const t of matches) {
    console.log(`  ${String(t.symbol).padEnd(12)} ${t.address}  ${String(t.verificationStatus ?? '—').padEnd(10)} tags [${(t.tags ?? []).join(',')}]  ${t.name}`);
  }
  console.log('\nRead-only — nothing was written.');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const deprecateStale = process.argv.includes('--deprecate-stale');
  const chain = parseChainArg();
  const searchArg = process.argv.find((a) => a.startsWith('--search='));
  if (searchArg) return searchTokens(chain, searchArg.slice('--search='.length));
  if (process.argv.includes('--stocks')) return importStocks(chain, apply);

  console.log(`Fetching LI.FI's known token list for chain "${chain}"...`);
  const { candidates, skipped, fetchError } = await fetchLiFiTokenCandidatesForChain(chain);
  if (fetchError) {
    console.error(`  Failed to fetch from LI.FI: ${fetchError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${candidates.length} of our curated candidates found on LI.FI for this chain.`);
  if (skipped.length > 0) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) {
      console.log(`  ${s.symbol.padEnd(8)} ${s.reason.padEnd(16)} ${s.address}  ${s.name}`);
    }
  }

  let existing: Awaited<ReturnType<typeof listAssets>> = [];
  if (isSupabaseConfigured()) {
    existing = await listAssets(supabaseAdmin(), { chain, limit: 1000 });
  } else {
    console.log('  Supabase not configured — planning against an empty existing-registry set.');
  }

  const plan = planLiFiImportForChain(candidates, existing);

  console.log('\nPlan:');
  console.log(`  toRegister:        ${plan.toRegister.length}`);
  console.log(`  alreadyRegistered: ${plan.alreadyRegistered.length}`);
  console.log(`  logoUpdates:       ${plan.logoUpdates.length}`);
  console.log(`  toReverify:        ${plan.toReverify.length}`);
  console.log(`  staleVerified:     ${plan.staleVerified.length}${plan.staleVerified.length > 0 ? ' (VERIFIED but no longer accepted — see --deprecate-stale)' : ''}`);

  if (plan.toRegister.length > 0) {
    console.log('\nWould register:');
    for (const a of plan.toRegister) {
      console.log(`  ${a.symbol.padEnd(8)} ${a.assetType.padEnd(6)} ${a.address}  ${a.name}`);
    }
  }

  if (plan.toReverify.length > 0) {
    console.log('\nDEPRECATED rows that pass again (set back to VERIFIED on --apply):');
    for (const a of plan.toReverify) {
      console.log(`  ${a.symbol.padEnd(8)} ${a.address}  ${a.name}`);
    }
  }

  if (plan.staleVerified.length > 0) {
    console.log('\nStale VERIFIED rows:');
    for (const a of plan.staleVerified) {
      console.log(`  ${a.symbol.padEnd(8)} ${a.address}  ${a.name}`);
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
  const result = await applyLiFiImportPlan((input) => registerAsset(admin, input), plan);

  console.log(`\nRegistered: ${result.registered.length}`);
  if (result.failed.length > 0) {
    console.log(`Failed: ${result.failed.length}`);
    for (const f of result.failed) {
      console.log(`  ${f.input.symbol} ${f.input.address}: ${f.error}`);
    }
    process.exitCode = 1;
  }

  let reverified = 0;
  for (const a of plan.toReverify) {
    try {
      await setAssetStatus(admin, a.id, 'VERIFIED');
      reverified++;
    } catch (err) {
      console.log(`  Failed to re-verify ${a.symbol} ${a.address}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  if (plan.toReverify.length > 0) console.log(`Re-verified: ${reverified}`);

  const logoResult = await applyLogoUpdates((id, logoUrl) => updateAssetLogoUrl(admin, id, logoUrl), plan.logoUpdates);
  console.log(`Logos synced: ${logoResult.updated.length}`);
  for (const f of logoResult.failed) {
    console.log(`  Logo sync failed ${f.update.asset.symbol}: ${f.error}`);
    process.exitCode = 1;
  }

  if (deprecateStale && plan.staleVerified.length > 0) {
    let deprecated = 0;
    for (const a of plan.staleVerified) {
      try {
        await setAssetStatus(admin, a.id, 'DEPRECATED');
        deprecated++;
      } catch (err) {
        console.log(`  Failed to deprecate ${a.symbol} ${a.address}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
    console.log(`Deprecated: ${deprecated}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
