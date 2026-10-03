import { AssetIdentity, CanonicalAsset } from '@/types/basket-protocol';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { isFractionallyTradable, RobinhoodStockApi } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';
import { getRobinhoodStockApi } from '@/lib/server/price-provider';

// -----------------------------------------------------------------------------
// Purchase-time validation of Robinhood Stock Tokens against the LIVE
// Robinhood registry (/rhj/assets), on top of the database registry check.
// For every recipe asset the database records as a Robinhood `stock` asset:
//   - the live registry must still list that exact contract ACTIVE on chain
//     4663 (a delisted / redeployed token is never silently treated as crypto)
//   - its tradingCapabilities must allow fractional trading in some session
// A registry that cannot be reached blocks the purchase (fail closed).
// -----------------------------------------------------------------------------

export type StockTokenGuardResult =
  | { ok: true }
  | { ok: false; kind: 'REGISTRY_UNAVAILABLE'; message: string }
  | { ok: false; kind: 'NOT_TRADABLE'; details: string[] };

export async function checkStockTokensForPurchase(
  recipeAssets: AssetIdentity[],
  dbAssets: CanonicalAsset[],
  api: RobinhoodStockApi = getRobinhoodStockApi()
): Promise<StockTokenGuardResult> {
  const stockKeys = new Set(dbAssets.filter((a) => a.chain === 'robinhood' && a.assetType === 'stock').map((a) => assetIdentityKey(a)));
  const stocks = recipeAssets.filter((a) => stockKeys.has(assetIdentityKey(a)));
  if (stocks.length === 0) return { ok: true };
  const details: string[] = [];
  for (const asset of stocks) {
    let token;
    try {
      token = await api.tokenByAddress(asset.address);
    } catch {
      return { ok: false, kind: 'REGISTRY_UNAVAILABLE', message: 'The Robinhood Stock Token registry is unreachable; Stock Token purchases are paused.' };
    }
    if (!token) details.push(`${asset.address} is no longer an active Robinhood Stock Token on Robinhood Chain.`);
    else if (!isFractionallyTradable(token)) details.push(`${token.symbol} is not currently tradable (Robinhood trading capabilities).`);
  }
  return details.length ? { ok: false, kind: 'NOT_TRADABLE', details } : { ok: true };
}
