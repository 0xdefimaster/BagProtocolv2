import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { buyBoxForUser, listBoxesForUser } from '@/lib/server/box-repo';
import { BOX_CONFIG } from '@/lib/config/boxes';
import { getCurrentSeason } from '@/lib/server/season-repo';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { BoxTypeId } from '@/types/domain';

// Production-hardening P1-10 — per user.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// Phase 18 — server-enforced box purchase. Replaces
// lib/services/box-service.ts's buyBox() (localStorage) — see
// lib/server/box-repo.ts's module doc and supabase/MIGRATION.md's "known
// regression" section for why that path was already silently broken.
// -----------------------------------------------------------------------------

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const boxes = await listBoxesForUser(supabaseAdmin(), auth.session.userId);
  return NextResponse.json({ boxes });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `boxes-buy:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const boxType = body && typeof body.boxType === 'string' ? (body.boxType as BoxTypeId) : null;
  const clientRequestId = body && typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined;

  if (!boxType || !(boxType in BOX_CONFIG)) {
    return NextResponse.json({ ok: false, error: 'A valid boxType is required.' }, { status: 400 });
  }

  // Production-hardening P0-6 — buying a box SPENDS this season's BAG
  // Points; without a real active season there is nothing to spend them
  // against, so this is rejected explicitly rather than silently charged
  // to a stale/ended season id.
  const season = await getCurrentSeason(admin);
  if (!season) {
    return NextResponse.json({ ok: false, error: 'No active season right now.' }, { status: 400 });
  }
  const outcome = await buyBoxForUser(admin, auth.session.userId, season.id, boxType, clientRequestId);

  if (!outcome.ok) {
    const message = outcome.error === 'INSUFFICIENT_POINTS' ? 'Not enough BAG Points.' : outcome.error;
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, box: outcome.box });
}
