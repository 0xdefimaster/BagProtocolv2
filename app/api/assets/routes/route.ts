import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { listAssets } from '@/lib/server/asset-repo';
import { AssetRouteStatus, checkAssetRoute } from '@/lib/server/asset-route-check';
import { ChainId, SUPPORTED_CHAINS } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Liquidity check for the Create page's asset warnings.
//
//   GET /api/assets/routes?chain=robinhood&addresses=0xabc,0xdef
//     -> { routes: { "0xabc": "ROUTABLE", "0xdef": "NO_ROUTE" } }
//
// Only VERIFIED registry assets on that chain are probed, so this public
// route can't be used to make LI.FI quote arbitrary tokens; anything else
// comes back UNKNOWN. Results are cached server-side (asset-route-check.ts).
// -----------------------------------------------------------------------------

const MAX_ADDRESSES = 25;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isChainId(value: string | null): value is ChainId {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const chain = searchParams.get('chain');
  if (!isChainId(chain)) return NextResponse.json({ error: 'valid chain is required' }, { status: 400 });

  const addresses = Array.from(
    new Set((searchParams.get('addresses') ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean))
  );
  if (addresses.length === 0) return NextResponse.json({ error: 'addresses is required' }, { status: 400 });
  if (addresses.length > MAX_ADDRESSES) return NextResponse.json({ error: `at most ${MAX_ADDRESSES} addresses` }, { status: 400 });
  if (!addresses.every((a) => ADDRESS_RE.test(a))) return NextResponse.json({ error: 'invalid address' }, { status: 400 });

  const routes: Record<string, AssetRouteStatus> = Object.fromEntries(addresses.map((a) => [a, 'UNKNOWN' as const]));
  if (!isSupabaseConfigured()) return NextResponse.json({ routes }, { status: 200 });

  const verified = new Set(
    (await listAssets(supabaseAdmin(), { status: 'VERIFIED', chain })).map((a) => a.address.toLowerCase())
  );

  await Promise.all(
    addresses
      .filter((a) => verified.has(a))
      .map(async (address) => {
        routes[address] = await checkAssetRoute({ chain, address });
      })
  );

  return NextResponse.json({ routes }, { status: 200 });
}
