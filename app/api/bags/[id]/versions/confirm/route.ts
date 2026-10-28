import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { confirmBagVersionUpdate } from '@/lib/server/bag-versioning';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { resolveVersionBody, versionFailureResponse } from '../_shared';

// POST /api/bags/[id]/versions/confirm — see lib/server/bag-versioning.ts. The
// server never signs: this verifies the creator-signed transaction on-chain, then records the version atomically.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `version-confirm:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const resolved = await resolveVersionBody(admin, id, await req.json().catch(() => null));
  if (!resolved.ok) return resolved.response;
  const { body } = resolved;

  const session = { userId: auth.session.userId, walletAddress: auth.session.walletAddress };
  const result = await confirmBagVersionUpdate(admin, session, id, body.recipe, body.txHash, body.reason);
  if (result.ok) {
    const { ok: _ok, ...payload } = result;
    void _ok;
    return NextResponse.json(payload, { status: 200 });
  }
  return versionFailureResponse(result);
}
