import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/server/require-cron-secret';
import { snapshotActiveBags } from '@/lib/server/nav-snapshot-sweep';

// -----------------------------------------------------------------------------
// GET|POST /api/cron/snapshot-bag-navs — the 5-minute NAV pass
// (lib/server/nav-snapshot-sweep.ts): keeps TVL, returns and the leaderboard
// current for every live Bag. Scheduled by netlify/functions/snapshot-bag-navs.mts;
// CRON_SECRET auth (fails closed).
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    return NextResponse.json(await snapshotActiveBags(supabaseAdmin()));
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
