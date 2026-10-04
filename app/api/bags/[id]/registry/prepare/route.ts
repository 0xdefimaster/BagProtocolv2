import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { prepareStrategyRegistration } from '@/lib/server/strategy-registration';
import { registrationFailureResponse } from '../_shared';

// POST /api/bags/[id]/registry/prepare — the next StrategyRegistry transaction for the creator's wallet to sign
// (register / registerFork / publishVersions). The server only builds it; it never signs.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `registry-prepare:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const result = await prepareStrategyRegistration(admin, { userId: auth.session.userId, walletAddress: auth.session.walletAddress }, id);
  if (!result.ok) return registrationFailureResponse(result);
  const { ok: _ok, ...payload } = result;
  void _ok;
  return NextResponse.json(payload);
}
