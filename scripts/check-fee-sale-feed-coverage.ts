/**
 * READ-ONLY coverage report: which fee-bearing Bags can a non-creator sell under the fee-sale confidence policy
 * (lib/domain/basket-protocol/redeem/sale-price-confidence.ts)? Every Stock Token leg needs a Chainlink feed in
 * ROBINHOOD_CHAINLINK_FEEDS; crypto legs have no qualifying source and are refused.
 *
 *   npx tsx scripts/check-fee-sale-feed-coverage.ts                 # static: registry + configured feeds
 *   npx tsx scripts/check-fee-sale-feed-coverage.ts --probe         # also price each leg now (Robinhood API + Chainlink, read-only)
 *   npx tsx scripts/check-fee-sale-feed-coverage.ts --out=cov.json  # also write JSON
 *
 * Reads: Supabase (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, read only), ROBINHOOD_CHAINLINK_FEEDS, and
 * with --probe the same price sources the app uses. Never prints an env value, URL or key; feed addresses are public
 * on-chain contracts and are printed only as "configured". No transaction, no write.
 *
 * Limits (stated in the output): legs are the CURRENT version's recipe assets — holders may still hold assets of
 * earlier versions; FEED_CONFIGURED is necessary, not sufficient (the feed must be readable and agree at sale time).
 *
 * Exit: 0 when every fee-bearing Robinhood Bag is READY_IF_FEEDS_LIVE, 1 otherwise, 2 on setup errors.
 */
import './load-env';
import { writeFileSync } from 'node:fs';
import { ROBINHOOD_REWARD_TOKEN } from '../lib/config/robinhood-chain';
import { parseChainlinkFeeds } from '../lib/domain/basket-protocol/pricing/chainlink-feed-provider';
import { feeSaleFeedCoverage, type CoverageBag } from '../lib/domain/basket-protocol/redeem/fee-sale-feed-coverage';
import { salePriceDeviationLimit, salePricePolicyFromEnv } from '../lib/domain/basket-protocol/redeem/sale-price-confidence';
import { getCurrentBagVersion, listBags } from '../lib/server/bag-repo';
import { listAssets } from '../lib/server/asset-repo';
import { getPriceProvider } from '../lib/server/price-provider';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  if (!isSupabaseConfigured()) {
    console.error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): cannot read Bags.');
    process.exit(2);
  }
  let feeds: Record<string, string>;
  try {
    feeds = parseChainlinkFeeds(process.env.ROBINHOOD_CHAINLINK_FEEDS);
  } catch {
    console.error('ROBINHOOD_CHAINLINK_FEEDS is set but malformed (value not shown).');
    process.exit(2);
  }
  const admin = supabaseAdmin();
  const bags = await listBags(admin, { status: ['ACTIVE', 'ARCHIVED'], limit: 1000 });
  const input: CoverageBag[] = [];
  for (const b of bags) {
    const v = await getCurrentBagVersion(admin, b.id);
    const feeBps = b.performanceFeeBpsLocked ?? v?.recipe.performanceFeeBps ?? 0;
    input.push({ id: b.id, name: b.name, chain: b.chain, feeBps, assets: (v?.recipe.assets ?? []).map((a) => ({ address: a.address, symbol: a.symbol })) });
  }
  const registry = await listAssets(admin, { chain: 'robinhood' });
  const assetTypes = new Map(registry.map((a) => [a.address.toLowerCase(), a.assetType] as const));
  const report = feeSaleFeedCoverage({ bags: input, settlementTokenAddress: ROBINHOOD_REWARD_TOKEN.address, assetTypes, feeds });

  // Optional live probe: what the policy decides for each priced leg right now.
  const probe = new Map<string, string>();
  if (flag('probe')) {
    const provider = getPriceProvider();
    const policy = salePricePolicyFromEnv();
    const unique = new Set(report.flatMap((b) => b.legs.filter((l) => l.coverage !== 'NOT_PRICED').map((l) => l.address.toLowerCase())));
    for (const address of unique) {
      try {
        const d = salePriceDeviationLimit(await provider.getPrice({ chain: 'robinhood', address }), policy);
        probe.set(address, d.ok ? `${d.tier} ${d.maxDeviationBps}bps` : `REFUSED ${d.reason}`);
      } catch (e) {
        probe.set(address, `REFUSED ${(e as Error).name || 'PRICE_ERROR'}`);
      }
    }
  }

  console.log(`Fee-bearing Bags: ${report.length} · configured feeds: ${Object.keys(feeds).length}${flag('probe') ? ' · live probe: on' : ''}`);
  for (const b of report) {
    console.log(`\n${b.status.padEnd(20)} ${b.name} (${b.id}) · ${b.chain} · fee ${b.feeBps / 100}%`);
    for (const l of b.legs) {
      const live = probe.get(l.address.toLowerCase());
      console.log(`   ${l.symbol.padEnd(8)} ${l.coverage.padEnd(20)} ${l.address}${live ? `  now: ${live}` : ''}`);
    }
  }
  const counts = report.reduce<Record<string, number>>((m, b) => ((m[b.status] = (m[b.status] ?? 0) + 1), m), {});
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no fee-bearing Bags'}`);
  console.log('Limits: current-version recipe assets only (earlier-version holdings not seen); FEED_CONFIGURED is necessary, not sufficient. Read-only.');

  const out = arg('out');
  if (out) writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), configuredFeeds: Object.keys(feeds).length, probe: Object.fromEntries(probe), report }, null, 2));
  process.exit(report.every((b) => b.status !== 'FEE_SALE_REFUSED') ? 0 : 1);
}

main().catch((e) => {
  console.error((e as Error).message.split('\n')[0]);
  process.exit(2);
});
