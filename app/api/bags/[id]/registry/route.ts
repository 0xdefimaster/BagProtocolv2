import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getRegistrationStatus } from '@/lib/server/strategy-registration';

// GET /api/bags/[id]/registry — the Bag's StrategyRegistry status as BAG verified it (per version), and whether
// the signed-in viewer is its creator (who alone can register it). A DRAFT or ARCHIVED Bag is visible only to its creator.

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  const session = await getSession();
  const admin = supabaseAdmin();
  const status = await getRegistrationStatus(admin, id.toLowerCase(), session?.userId ?? null);
  if (!status) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  const { data: bag } = await admin.from('bags').select('status').eq('id', id.toLowerCase()).maybeSingle<{ status: string }>();
  if (bag?.status !== 'ACTIVE' && !status.viewerIsCreator) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  return NextResponse.json(status);
}
