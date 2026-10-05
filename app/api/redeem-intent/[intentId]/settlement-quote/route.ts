import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { quoteSettlement } from '@/lib/server/redeem-settlement-attestation';
import { settlementErrorResponse } from '@/lib/server/redeem-settlement-errors';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// Phase 1 of the settlement attestation (lib/server/redeem-settlement-attestation.ts): quote, price-quality check,
// plan. Signs nothing. POST /api/redeem-intent/:intentId/settlement-quote → { plan, feeAtMinimumRaw }
export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const { intentId } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `redeem-intent-settlement-quote:${auth.session.userId}:${intentId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  try {
    return NextResponse.json(await quoteSettlement(admin, auth.session.userId, intentId));
  } catch (err) {
    return settlementErrorResponse(err);
  }
}
