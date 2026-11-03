/**
 * READ-ONLY release gate for PR #147's fee-sale confidence policy: can every fee-paying sale BAG currently allows be
 * priced under the policy (lib/domain/basket-protocol/redeem/sale-price-confidence.ts)?
 *
 *   npx tsx scripts/check-fee-sale-feed-coverage.ts                 # static: inventory + registry + configured feeds
 *   npx tsx scripts/check-fee-sale-feed-coverage.ts --probe         # also price every required leg NOW (read-only)
 *   npx tsx scripts/check-fee-sale-feed-coverage.ts --probe --out=cov.json
 *
 * Which legs: the real sale path's, not the current recipe's. A fee sale (seller ≠ creator, rate > 0) sells the
 * seller's own `bag_investor_holdings` rows, so every asset any fee-paying holder holds is required — including
 * assets of earlier versions. The current recipe's assets are required too (future buyers). Creator positions sell
 * through the free path and are reported, not gated. Details: lib/domain/basket-protocol/redeem/fee-sale-feed-coverage.ts.
 *
 * Exit codes:
 *   0  inventory complete; static coverage complete (or NO_FEE_BEARING_POSITIONS); with --probe every required leg VERIFIED_NOW
 *   1  a determinate gap: missing feed, crypto/unknown asset, unsupported chain, or a probe answer other than VERIFIED_NOW
 *   2  no determinate answer: Supabase/config error, incomplete inventory scan, or a probe that could not complete
 *
 * FEED_CONFIGURED is a configuration fact, not evidence a sale can happen; VERIFIED_NOW is a live read at one moment;
 * neither proves a positive-fee settlement works (docs/runbooks/POSITIVE_FEE_SALE.md).
 *
 * Reads Supabase (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) with SELECTs only, ROBINHOOD_CHAINLINK_FEEDS,
 * and with --probe the same price sources the app uses. Prints no env value, URL or key. No transaction, no write.
 */
import './load-env';
import { writeFileSync } from 'node:fs';
import { ROBINHOOD_REWARD_TOKEN } from '../lib/config/robinhood-chain';
import { parseChainlinkFeeds } from '../lib/domain/basket-protocol/pricing/chainlink-feed-provider';
import { salePricePolicyFromEnv, type SalePricePolicy } from '../lib/domain/basket-protocol/redeem/sale-price-confidence';
import { loadFeeSaleInventory, runFeeSaleCoverageGate } from '../lib/server/fee-sale-coverage-gate';
import { getPriceProvider } from '../lib/server/price-provider';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const fail = (msg: string): never => {
  console.error(`CONFIG_ERROR: ${msg}`);
  console.log('RESULT: INCOMPLETE (exit 2)');
  process.exit(2);
};

async function main() {
  if (!isSupabaseConfigured()) fail('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  let feeds: Record<string, string> = {};
  try {
    feeds = parseChainlinkFeeds(process.env.ROBINHOOD_CHAINLINK_FEEDS);
  } catch {
    fail('ROBINHOOD_CHAINLINK_FEEDS is set but malformed (value not shown).');
  }
  let probe: { getPrice: ReturnType<typeof getPriceProvider>['getPrice']; policy: SalePricePolicy } | undefined;
  if (flag('probe')) {
    try {
      const provider = getPriceProvider();
      probe = { getPrice: (a) => provider.getPrice(a), policy: salePricePolicyFromEnv() };
    } catch (e) {
      fail(`price provider or sale price policy could not be configured (${(e as Error).name}).`);
    }
  }

  const admin = supabaseAdmin();
  const run = await runFeeSaleCoverageGate({ loadInventory: () => loadFeeSaleInventory(admin), feeds, settlementTokenAddress: ROBINHOOD_REWARD_TOKEN.address, probe });

  if (!run.report) {
    console.log(`INVENTORY: INCOMPLETE — ${run.inventoryError}`);
    console.log('RESULT: INCOMPLETE (exit 2). No coverage is reported from a partial scan.');
    process.exit(2);
  }
  const r = run.report;
  console.log(
    `INVENTORY: complete · bags ${r.totals.bagsScanned} · holding rows ${r.totals.holdingRowsScanned} · fee-bearing bags ${r.totals.feeBearingBags} · ` +
      `fee-paying positions ${r.totals.feePositions} · creator positions (free path, not gated) ${r.totals.creatorPositions}`
  );
  console.log(`CONFIGURED FEEDS: ${Object.keys(feeds).length}`);

  console.log('\n== STATIC (configuration only: FEED_CONFIGURED does not prove a sale can happen) ==');
  for (const b of r.bags) {
    console.log(`\n${b.status.padEnd(20)} ${b.name} (${b.id}) · ${b.chain} · fee ${b.feeBps === null ? '?' : `${b.feeBps / 100}%`} (${b.feeSource}) · fee positions ${b.feePositions} · creator ${b.creatorPositions}${b.note ? ` · ${b.note}` : ''}`);
    for (const l of b.legs) {
      console.log(`   ${(l.symbol ?? '?').padEnd(8)} ${l.coverage.padEnd(20)} ${l.origin.padEnd(26)} holders ${String(l.feeHolders).padEnd(4)} ${l.address}`);
    }
  }
  console.log(`\nSTATIC RESULT: ${r.status}`);

  if (run.probe) {
    console.log('\n== LIVE PROBE (price router + policy, read now; VERIFIED_NOW is required for a pass) ==');
    if (run.probe.size === 0) console.log('   no priced legs to probe');
    for (const [k, o] of run.probe) console.log(`   ${o.status.padEnd(17)} ${k}  ${o.status === 'VERIFIED_NOW' ? o.detail : o.reason}`);
  } else {
    console.log('\nLIVE PROBE: not run (static coverage only; re-run with --probe for the release gate).');
  }

  const label = run.exitCode === 0 ? (r.status === 'NO_FEE_BEARING_POSITIONS' ? 'NO_FEE_BEARING_POSITIONS' : run.probe ? 'PASS' : 'STATIC_PASS') : run.exitCode === 1 ? 'GAPS' : 'INCOMPLETE';
  console.log(`\nRESULT: ${label} (exit ${run.exitCode}). Read-only. Feed coverage is not proof that a positive-fee settlement works.`);

  const out = arg('out');
  if (out) {
    writeFileSync(
      out,
      JSON.stringify({ checkedAt: new Date().toISOString(), exitCode: run.exitCode, result: label, configuredFeeds: Object.keys(feeds).length, report: r, probe: run.probe ? Object.fromEntries(run.probe) : null }, null, 2)
    );
  }
  process.exit(run.exitCode);
}

main().catch((e) => {
  console.error(`UNEXPECTED: ${(e as Error).name}`);
  console.log('RESULT: INCOMPLETE (exit 2)');
  process.exit(2);
});
