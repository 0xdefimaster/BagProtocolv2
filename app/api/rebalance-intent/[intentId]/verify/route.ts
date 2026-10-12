import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { publicRebalanceIntent, verifyRebalanceExecution } from '@/lib/server/rebalance-execution';

// POST /api/rebalance-intent/:intentId/verify { txHash? } — R3: records the
// wallet's transaction hash (once) and settles the rebalance from its receipt:
// the hash must be the exact transaction BAG built; what really left and arrived
// is booked (lib/server/rebalance-execution.ts). Poll until SUCCEEDED or FAILED.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

export async function POST(req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `rebalance-intent-verify:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const body = (await req.json().catch(() => ({}))) as { txHash?: unknown };
  const txHash = typeof body.txHash === 'string' ? body.txHash : undefined;
  try {
    const outcome = await verifyRebalanceExecution(admin, auth.session, intentId, txHash);
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ intent: publicRebalanceIntent(outcome.intent) });
  } catch {
    return NextResponse.json({ error: 'Could not check the rebalance right now.' }, { status: 503 });
  }
}
