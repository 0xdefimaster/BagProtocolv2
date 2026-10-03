import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/server/require-cron-secret';
import { refreshAssetRouteStatuses } from '@/lib/server/asset-route-refresh';

// -----------------------------------------------------------------------------
// GET|POST /api/cron/refresh-asset-routes — refreshes the stored liquidity
// status of up to 40 registry assets per call (lib/server/asset-route-
// refresh.ts), oldest-checked first. Scheduled by
// netlify/functions/refresh-asset-routes.mts; same CRON_SECRET auth as the
// other cron routes. For a one-off full pass, run
// scripts/refresh-asset-routes.ts instead.
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    return NextResponse.json(await refreshAssetRouteStatuses(supabaseAdmin()));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
