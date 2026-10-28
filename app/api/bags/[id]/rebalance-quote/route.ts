import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { quoteRebalance } from '@/lib/server/rebalance-quote';

// POST /api/bags/:id/rebalance-quote — R2: a real LI.FI Composer route for
// rebalancing THIS investor's position back to the strategy's current version
// (lib/server/rebalance-quote.ts). Returns what would be sold, what would
// arrive (expected and enforced minimum), price impact and fees. No
// transaction is returned: signing comes with the recorded, verifiable intent.

export const maxDuration = 60;
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };
const priceProvider = getDisplayPriceProvider();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `rebalance-quote:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const accepted = await acceptedImpact(req);
  if (accepted === 'BAD') return NextResponse.json({ error: 'acceptedPriceImpactBps must be a number of basis points.' }, { status: 400 });

  try {
    const result = await quoteRebalance(admin, getChainPublicClient('robinhood'), priceProvider, auth.session, id, { apiKey: process.env.LIFI_API_KEY, acceptedPriceImpactBps: accepted });
    if (!result.ok) {
      return NextResponse.json(failureBody(result), { status: result.status });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** `acceptedPriceImpactBps` from the body, when the investor accepted a measured impact (validated in planRebalance). */
async function acceptedImpact(req: NextRequest): Promise<number | undefined | 'BAD'> {
  const body = (await req.json().catch(() => ({}))) as { acceptedPriceImpactBps?: unknown };
  if (body?.acceptedPriceImpactBps === undefined || body.acceptedPriceImpactBps === null) return undefined;
  return typeof body.acceptedPriceImpactBps === 'number' ? body.acceptedPriceImpactBps : 'BAD';
}

function failureBody(r: { error: string; composerFallback?: unknown; acceptablePriceImpactBps?: number | null }) {
  return {
    error: r.error,
    ...(r.composerFallback ? { composerFallback: r.composerFallback } : {}),
    ...(r.acceptablePriceImpactBps !== undefined ? { acceptablePriceImpactBps: r.acceptablePriceImpactBps } : {}),
  };
}
