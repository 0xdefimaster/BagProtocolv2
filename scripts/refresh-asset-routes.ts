import './load-env';
import { isSupabaseConfigured, supabaseAdmin } from '../lib/supabase/server';
import { refreshAssetRouteStatuses } from '../lib/server/asset-route-refresh';
import { ChainId, SUPPORTED_CHAINS } from '../types/basket-protocol';

// -----------------------------------------------------------------------------
// One-off full liquidity pass over the asset registry (0043), instead of
// waiting for the scheduled /api/cron/refresh-asset-routes runs.
//
// USAGE
//   npx tsx scripts/refresh-asset-routes.ts            # every chain
//   npx tsx scripts/refresh-asset-routes.ts robinhood  # one chain
//
// Needs Supabase (service role) and outbound access to LI.FI. Re-checks every
// asset regardless of when it was last checked.
// -----------------------------------------------------------------------------

async function main() {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  const arg = process.argv[2];
  if (arg && !(SUPPORTED_CHAINS as readonly string[]).includes(arg)) {
    throw new Error(`Unknown chain "${arg}". Use one of: ${SUPPORTED_CHAINS.join(', ')}`);
  }
  console.log(`Checking liquidity for every VERIFIED asset${arg ? ` on ${arg}` : ''}…`);
  const result = await refreshAssetRouteStatuses(supabaseAdmin(), {
    chain: arg as ChainId | undefined,
    limit: 100_000,
    staleAfterMs: 0,
    concurrency: 5,
  });
  console.log(`Done: ${result.checked} checked — ${result.routable} routable, ${result.noRoute} without a route, ${result.unknown} unknown (retry later).`);
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
