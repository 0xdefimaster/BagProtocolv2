import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { recheckUnmatchedComposerSales } from '@/lib/server/redeem-execution';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// Re-checks this user's earlier sales of the Bag that ran on-chain but were refused as unmatched (a wallet batch,
// e.g. MetaMask over EIP-7702, before such batches were recognised) and books the ones whose transaction now
// verifies. Same verification as any sale; nothing is booked from the client's say-so. The sell dialog calls it
// before loading the position, so the position shown is the one after those sales.
//
//   POST /api/bags/:id/redeem-recheck -> { booked }
// -----------------------------------------------------------------------------

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-recheck:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }
  return NextResponse.json(await recheckUnmatchedComposerSales(admin, auth.session, id));
}
