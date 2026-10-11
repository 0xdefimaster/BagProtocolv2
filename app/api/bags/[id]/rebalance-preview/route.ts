import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth/require-session';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { loadRebalancePreview } from '@/lib/server/rebalance-preview';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// -----------------------------------------------------------------------------
// GET /api/bags/:id/rebalance-preview — R1, read-only. How far THIS investor's
// position has drifted from the strategy's current version, and what a
// rebalance back to it would trade (lib/server/rebalance-preview.ts over
// lib/domain/basket-protocol/rebalance/position-rebalance.ts). Holdings are
// what the wallet holds attributed to the strategy, at one block; prices are
// BAG's verified display prices. No quote, no route, no transaction.
// -----------------------------------------------------------------------------

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };
const priceProvider = getDisplayPriceProvider();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `rebalance-preview:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  const loaded = await loadRebalancePreview(admin, getChainPublicClient('robinhood'), priceProvider, auth.session, id);
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const { bag, blockNumber, symbols, preview } = loaded;
  return NextResponse.json({ bag: { id: bag.id, name: bag.name, symbol: bag.symbol }, blockNumber, symbols, preview });
}
