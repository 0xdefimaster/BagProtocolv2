import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { createRebalanceIntent, publicRebalanceIntent } from '@/lib/server/rebalance-execution';

// POST /api/bags/:id/rebalance-intent — R3: plans a rebalance of THIS investor's
// position back to the strategy's current version and records it as an intent
// (lib/server/rebalance-execution.ts). Returns the one Composer transaction and
// its exact-amount approvals for the wallet to sign; BAG never signs. Settled by
// POST /api/rebalance-intent/:intentId/verify.

export const maxDuration = 60;
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 5 };
const priceProvider = getDisplayPriceProvider();

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `rebalance-intent:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    const result = await createRebalanceIntent(admin, getChainPublicClient('robinhood'), priceProvider, auth.session, id, { apiKey: process.env.LIFI_API_KEY });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ intent: publicRebalanceIntent(result.intent) });
  } catch {
    return NextResponse.json({ error: 'Could not plan the rebalance right now.' }, { status: 500 });
  }
}
