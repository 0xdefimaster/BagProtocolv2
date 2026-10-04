import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';

// GET /api/users/me/reconciliation — the signed-in user's recent reconciliation
// records (Accounting V2 / A2): where the wallet holds less than BAG tracks,
// how the shortfall was allocated across their strategies, and whether it is
// still being watched (DRIFT), was booked (CONFIRMED_OUTFLOW) or went away
// (RESOLVED). Reasons are only as certain as BAG knows them (UNKNOWN_OUTFLOW
// until classified).

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin()
    .from('reconciliation_records')
    .select('id, chain, address, block_number, observed_raw, tracked_total_raw, shortfall_raw, allocation, status, reason, created_at, resolved_at')
    .eq('user_id', auth.session.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const records = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id,
    chain: r.chain,
    address: r.address,
    blockNumber: String(r.block_number),
    observedRaw: String(r.observed_raw),
    trackedRaw: String(r.tracked_total_raw),
    shortfallRaw: String(r.shortfall_raw),
    allocation: r.allocation,
    status: r.status,
    reason: r.reason,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
  return NextResponse.json({ records });
}
