import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { isStrategyId } from '@/lib/server/strategy-api';
import { listLedgerEventsForUser, MAX_LEDGER_PAGE } from '@/lib/server/ledger-repo';

// GET /api/users/me/ledger[?strategyId=<uuid>&before=<seq>&limit=<1-100>]
// The signed-in user's own Accounting V2 ledger events, newest first
// (docs/ACCOUNTING_V2_DESIGN.md). Read-only; only ever this session's user.

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const params = new URL(req.url).searchParams;
  const strategyId = params.get('strategyId');
  const before = params.get('before');
  const limitRaw = params.get('limit');
  if (strategyId !== null && !isStrategyId(strategyId)) return NextResponse.json({ error: 'Invalid strategyId.' }, { status: 400 });
  if (before !== null && !/^[1-9]\d{0,18}$/.test(before)) return NextResponse.json({ error: 'Invalid before cursor.' }, { status: 400 });
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LEDGER_PAGE)) {
    return NextResponse.json({ error: `limit must be 1-${MAX_LEDGER_PAGE}.` }, { status: 400 });
  }

  const page = await listLedgerEventsForUser(supabaseAdmin(), auth.session.userId, {
    bagId: strategyId?.toLowerCase(),
    before: before ?? undefined,
    limit,
  });
  return NextResponse.json(page);
}
