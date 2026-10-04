import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { isStrategyId } from '@/lib/server/strategy-api';
import { listAllLedgerEventsForPosition } from '@/lib/server/ledger-repo';
import { computePositionPnl } from '@/lib/domain/basket-protocol/accounting/position-pnl';

// GET /api/users/me/positions/:strategyId/pnl — the signed-in user's cost basis
// (average cost per asset), realized P&L from proceeds actually received, the
// high-water mark and fee base per exit, and fees actually charged, computed
// from their ledger events alone (Accounting V2 / A3). Unknown numbers are
// null, never estimated. Amounts are decimal strings in the quote currency.

export async function GET(_req: NextRequest, ctx: { params: Promise<{ strategyId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const { strategyId } = await ctx.params;
  if (!isStrategyId(strategyId)) return NextResponse.json({ error: 'Strategy not found.' }, { status: 404 });

  const events = await listAllLedgerEventsForPosition(supabaseAdmin(), auth.session.userId, strategyId.toLowerCase());
  if (events.length === 0) return NextResponse.json({ error: 'No position in this strategy.' }, { status: 404 });

  return NextResponse.json({
    strategyId: strategyId.toLowerCase(),
    method: { costBasis: 'AVERAGE_COST_PER_ASSET', realized: 'VERIFIED_PROCEEDS_ONLY', feeBase: 'ABOVE_REALIZED_HIGH_WATER_MARK' },
    ...computePositionPnl(events),
  });
}
