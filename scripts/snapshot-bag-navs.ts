import './load-env';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';
import { recordNavSnapshot } from '../lib/server/bag-nav-snapshots';

// Records one NAV snapshot for every ACTIVE Bag (bag_nav_snapshots, migration
// 0044) — the history behind the Performance chart and 7D/30D/YTD. Run it on a
// schedule (e.g. hourly). Bags with no shares or no price yet are skipped.
//
//   npx tsx scripts/snapshot-bag-navs.ts            (skips Bags snapshotted < 15 min ago)
//   npx tsx scripts/snapshot-bag-navs.ts --force    (always records)

async function main() {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  const admin = supabaseAdmin();
  const force = process.argv.includes('--force');
  const { data, error } = await admin.from('bags').select('id,name').eq('status', 'ACTIVE');
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const bag of (data ?? []) as { id: string; name: string }[]) {
    try {
      const outcome = await recordNavSnapshot(admin, bag.id, force ? { minIntervalMs: 0 } : {});
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      console.log(`${outcome.padEnd(9)} ${bag.name} (${bag.id})`);
    } catch (err) {
      counts.error = (counts.error ?? 0) + 1;
      console.log(`error     ${bag.name} (${bag.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · '));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
