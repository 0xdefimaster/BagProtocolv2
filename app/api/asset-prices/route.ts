import { NextRequest, NextResponse } from 'next/server';
import { isBagChain } from '@/lib/config/chains';
import { getBagAssetService } from '@/lib/server/bag-asset-service';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// Each unknown address is a LI.FI lookup, so an unthrottled public caller
// could burn the API key's quota with random addresses.
const PUBLIC_RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

// -----------------------------------------------------------------------------
// Unified asset + indicative price data for the frontend, for every chain.
//
//   GET /api/asset-prices?assets=robinhood:0xabc…,arbitrum:0xdef…
//
// Returns { assets: BagAsset[], errors: { "<chain>:<address>": code } }.
// The browser never calls LI.FI, Robinhood or an RPC provider directly: all of
// it happens here, behind the server-side caches. Prices are INDICATIVE; a
// purchase's amounts come from execution quotes.
// -----------------------------------------------------------------------------

const MAX_ASSETS = 25;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: NextRequest) {
  if (isSupabaseConfigured()) {
    const limit = await checkRateLimit(supabaseAdmin(), `asset-prices:ip:${getClientIp(req)}`, PUBLIC_RATE_LIMIT);
    if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }
  const raw = new URL(req.url).searchParams.get('assets') ?? '';
  const keys = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)));
  if (keys.length === 0) return NextResponse.json({ error: 'assets is required (chain:address,…)' }, { status: 400 });
  if (keys.length > MAX_ASSETS) return NextResponse.json({ error: `at most ${MAX_ASSETS} assets` }, { status: 400 });
  const identities = [];
  for (const key of keys) {
    const [chain, address, extra] = key.split(':');
    if (extra !== undefined || !chain || !isBagChain(chain) || !address || !ADDRESS_RE.test(address)) {
      return NextResponse.json({ error: `invalid asset "${key}"` }, { status: 400 });
    }
    identities.push({ key, identity: { chain, address } });
  }

  const service = getBagAssetService();
  const results = await Promise.all(identities.map(async ({ key, identity }) => ({ key, result: await service.resolve(identity) })));
  const assets = results.flatMap((r) => (r.result.ok ? [r.result.asset] : []));
  const errors = Object.fromEntries(results.flatMap((r) => (r.result.ok ? [] : [[r.key, r.result.error]])));
  return NextResponse.json({ assets, errors }, { status: 200, headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=15' } });
}
