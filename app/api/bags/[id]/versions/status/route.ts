import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagVersionStatus } from '@/lib/server/bag-version-recovery';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { versionFailureResponse } from '../_shared';

// GET /api/bags/[id]/versions/status — the creator's view of where the database and the chain stand
// (lib/server/bag-version-recovery.ts). Read-only; creator only.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 30 };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `version-status:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const result = await getBagVersionStatus(admin, { userId: auth.session.userId, walletAddress: auth.session.walletAddress }, id);
  if (!result.ok) return versionFailureResponse(result);
  const { ok: _ok, ...payload } = result;
  void _ok;
  return NextResponse.json(payload, { status: 200 });
}
