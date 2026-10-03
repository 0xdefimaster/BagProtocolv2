import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById } from '@/lib/server/bag-repo';
import { InvalidCursorError, MAX_EXECUTIONS_PAGE, loadExecutionHistory } from '@/lib/server/execution-receipts';

// GET /api/bags/:id/executions — the signed-in user's own execution receipts
// (purchases and redeems) for this Bag, newest first (types/execution-receipt.ts).
// Never another user's executions. A non-public Bag is visible to its creator,
// or to a user who has executions in it; otherwise 404 (existence not confirmed).
// Paginated: `?limit=` (1–50, default 50) and `?cursor=` (opaque, from the previous
// page's nextCursor). Becomes the MCP get_execution_history() tool.

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });

  const search = req.nextUrl.searchParams;
  const limitParam = search.get('limit');
  const limit = limitParam === null ? MAX_EXECUTIONS_PAGE : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXECUTIONS_PAGE) {
    return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_EXECUTIONS_PAGE}.` }, { status: 400 });
  }

  try {
    const history = await loadExecutionHistory(admin, bag.id, auth.session.userId, { cursor: search.get('cursor'), limit });
    const visible = bag.status === 'ACTIVE' || bag.creatorId === auth.session.userId || history.executions.length > 0;
    if (!visible) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    return NextResponse.json(history);
  } catch (err) {
    if (err instanceof InvalidCursorError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
