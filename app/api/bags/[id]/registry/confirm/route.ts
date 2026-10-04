import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { confirmStrategyRegistration } from '@/lib/server/strategy-registration';
import { registrationFailureResponse } from '../_shared';

// POST /api/bags/[id]/registry/confirm { txHash } — verifies the creator-signed StrategyRegistry transaction on-chain
// and records what it shows. Nothing is recorded unless every check holds.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `registry-confirm:${auth.session.userId}:${id}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const body = (await req.json().catch(() => null)) as { txHash?: unknown } | null;
  if (!body || typeof body.txHash !== 'string') return NextResponse.json({ error: 'Body must be { txHash }.', code: 'BAD_REQUEST' }, { status: 400 });

  const result = await confirmStrategyRegistration(admin, { userId: auth.session.userId, walletAddress: auth.session.walletAddress }, id, body.txHash);
  if (!result.ok) return registrationFailureResponse(result);
  const { ok: _ok, ...payload } = result;
  void _ok;
  return NextResponse.json(payload);
}
