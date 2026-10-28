import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { recoverBagVersions } from '@/lib/server/bag-version-recovery';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { versionFailureResponse } from '../_shared';

// POST /api/bags/[id]/versions/recover { txHash? } — records versions the chain already has but this database does
// not, each only after its transaction is found and verified on chain (lib/server/bag-version-recovery.ts).
// Creator only. Works from any browser or device: the recipe comes from the server's pending proposal.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `version-recover:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const body = (await req.json().catch(() => ({}))) as { txHash?: unknown };
  if (body.txHash !== undefined && typeof body.txHash !== 'string') {
    return NextResponse.json({ error: 'txHash must be a string.', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const txHash = typeof body.txHash === 'string' && body.txHash.trim() ? body.txHash.trim() : undefined;

  const result = await recoverBagVersions(admin, { userId: auth.session.userId, walletAddress: auth.session.walletAddress }, id, { txHash });
  if (!result.ok) return versionFailureResponse(result);
  const { ok: _ok, ...payload } = result;
  void _ok;
  return NextResponse.json(payload, { status: 200 });
}
