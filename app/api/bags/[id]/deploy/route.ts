import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagDeploymentState } from '@/lib/server/deploy-bag';

// -----------------------------------------------------------------------------
// GET /api/bags/[id]/deploy — owner-only read of the authoritative deployment
// state (Bag status + the (bag, chain) deployment row). This is what the UI
// reads after a refresh or after confirm. There is intentionally NO write
// handler on this path any more: deployment is only
//   POST …/deploy/prepare  →  (user's wallet signs)  →  POST …/deploy/confirm
// (the previous single-step POST that had the server send the transaction was
// removed together with the server-side signing key it needed).
// -----------------------------------------------------------------------------

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const result = await getBagDeploymentState(
    supabaseAdmin(),
    { userId: auth.session.userId, walletAddress: auth.session.walletAddress },
    id
  );

  if (result.ok) {
    return NextResponse.json({ bagStatus: result.bagStatus, chain: result.chain, deployment: result.deployment }, { status: 200 });
  }
  return result.error === 'BAG_NOT_FOUND'
    ? NextResponse.json({ error: 'Bag not found.' }, { status: 404 })
    : NextResponse.json({ error: 'You do not have permission to view this bag.' }, { status: 403 });
}
