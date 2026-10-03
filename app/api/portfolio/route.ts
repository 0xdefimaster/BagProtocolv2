import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getPortfolio, listTrades } from '@/lib/server/trading-repo';

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const admin = supabaseAdmin();
    const [portfolio, trades] = await Promise.all([
      getPortfolio(admin, auth.session.userId),
      listTrades(admin, auth.session.userId),
    ]);
    return NextResponse.json({ portfolio, trades });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
