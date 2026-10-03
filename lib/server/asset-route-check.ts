import { AssetIdentity, ChainId } from '@/types/basket-protocol';
import { quoteSwapStep } from '@/lib/blockchain/lifi-execution-adapter';
import { PAYMENT_TOKEN_BY_CHAIN } from './payment-assets';

// -----------------------------------------------------------------------------
// "Can a buyer actually get into this asset right now?" — probed with a
// small LI.FI quote from the chain's payment token (USDG / USDC) into the
// asset. Used by the Create page to warn about assets with no liquidity
// (e.g. a Stock Token no market maker is quoting yet), so a creator finds
// out before publishing a Bag nobody can buy.
//
// A warning signal only: liquidity changes, so this never blocks creating
// a Bag, and PROVIDER_ERROR (timeouts, rate limits) reports UNKNOWN rather
// than NO_ROUTE.
// -----------------------------------------------------------------------------

export type AssetRouteStatus = 'ROUTABLE' | 'NO_ROUTE' | 'UNKNOWN';

/** Payment tokens on every supported chain are 6-decimal stablecoins; 10 units is a realistic small leg. */
const PROBE_AMOUNT_RAW = '10000000';
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { status: AssetRouteStatus; expiresAt: number }>();

function cacheKey(asset: AssetIdentity): string {
  return `${asset.chain}:${asset.address.toLowerCase()}`;
}

export async function checkAssetRoute(
  asset: AssetIdentity,
  now: number = Date.now(),
  quote: typeof quoteSwapStep = quoteSwapStep
): Promise<AssetRouteStatus> {
  const payment = PAYMENT_TOKEN_BY_CHAIN[asset.chain as ChainId];
  if (!payment) return 'UNKNOWN';
  // The payment token itself is kept, never swapped.
  if (payment.address.toLowerCase() === asset.address.toLowerCase()) return 'ROUTABLE';

  const key = cacheKey(asset);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.status;

  const { quote: q, error } = await quote(
    { chain: asset.chain, address: payment.address },
    asset,
    asset.chain,
    asset.chain,
    PROBE_AMOUNT_RAW,
    undefined
  );
  const status: AssetRouteStatus = q ? 'ROUTABLE' : error && error.code !== 'PROVIDER_ERROR' ? 'NO_ROUTE' : 'UNKNOWN';
  // Transient failures aren't cached, so the next check retries.
  if (status !== 'UNKNOWN') cache.set(key, { status, expiresAt: now + CACHE_TTL_MS });
  return status;
}

/** Test-only. */
export function clearAssetRouteCache(): void {
  cache.clear();
}
