import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById } from '@/lib/server/bag-repo';
import { loadExecutionHistory } from '@/lib/server/execution-receipts';

// GET /api/bags/:id/executions — the signed-in user's own execution receipts
// (purchases and redeems) for this Bag, newest first (types/execution-receipt.ts).
// Never another user's executions. A non-public Bag is visible to its creator,
// or to a user who has executions in it; otherwise 404 (existence not confirmed).
// Becomes the MCP get_execution_history() tool.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  try {
    const history = await loadExecutionHistory(admin, bag.id, auth.session.userId);
    const visible = bag.status === 'ACTIVE' || bag.creatorId === auth.session.userId || history.executions.length > 0;
    if (!visible) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    return NextResponse.json(history);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
