import { Asset } from '@/lib/create-assets-data';
import { CanonicalAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 17 — Create Basket's client-side bridge from the on-chain asset
// registry (`GET /api/assets`, Phase 16 data via `lib/server/asset-repo.ts`)
// to the UI's existing `Asset` shape (`lib/create-assets-data.ts`). Kept as
// its own module rather than inlined in `AssetSelector`/the create page so
// both can share one mapping + one fetch, and so a future asset picker
// (e.g. a rebalance/edit flow) can reuse it too.
// -----------------------------------------------------------------------------

const STOCK_TOKEN_ICON = '📈';
const CRYPTO_TOKEN_ICON = '🪙';

/**
 * `id` uses `chain:address` (not `symbol`) — the registry's own identity
 * key (`unique(chain, address)` in `supabase/schema.sql`) — so two VERIFIED
 * assets that happen to share a symbol on different chains never collide
 * in the UI's selection state the way two static demo entries with the
 * same `id` would.
 *
 * `type`/`icon` come from `asset.assetType` (0020_add_asset_type.sql) —
 * previously hardcoded to `'stock'` here, back when the registry only ever
 * held Robinhood Stock Tokens. Now that `coingecko-import.ts` also writes
 * crypto assets into the same table, that hardcoding would have shown
 * every imported coin under the "Stocks" filter tab
 * (components/create/AssetSelector.tsx) — this is the fix for that.
 */
export function canonicalAssetToUiAsset(asset: CanonicalAsset): Asset {
  return {
    id: `${asset.chain}:${asset.address}`,
    symbol: asset.symbol,
    name: asset.name,
    type: asset.assetType,
    icon: asset.assetType === 'crypto' ? CRYPTO_TOKEN_ICON : STOCK_TOKEN_ICON,
    chain: asset.chain,
    address: asset.address,
    decimals: asset.decimals,
    logoUrl: asset.logoUrl,
    routeStatus: asset.routeStatus,
    // No `price`/`change24h` — see the `Asset.chain` doc comment on why
    // these are never fabricated for a registry-backed asset.
  };
}

/**
 * Fetches VERIFIED registry assets for one chain (defaults to
 * `'robinhood'`, historically the only chain any importer populated —
 * `coingecko-import.ts` now also populates ethereum/base/arbitrum) and
 * optionally one `assetType`, mapping the result to `Asset[]`. Never
 * throws — a network failure, a non-2xx response, or Supabase not being
 * configured on this deployment (`GET /api/assets` itself already handles
 * that last case by returning an empty list) all resolve to `[]`.
 *
 * Production-hardening P0-2: this is now the ONLY asset source the create
 * flow uses — an empty result means "no verified assets on this chain
 * yet", never a signal to fall back to the static demo catalog
 * (`cryptoAssets`/`stockAssets`, lib/create-assets-data.ts). Those static
 * lists carry fabricated prices (e.g. a hardcoded `price: 42500` for BTC)
 * and include assets — BTC chief among them — that have NO real ERC-20
 * deployment on any of this app's supported chains at all (see
 * coingecko-import.ts's own doc on why BTC/SOL/DOGE are correctly SKIPPED
 * by the importer, never faked as a "wrapped" stand-in). Showing them as
 * selectable in a real bag-creation flow only pushes that failure to a
 * confusing, late `INVALID_ADDRESS`/`ASSET_CHAIN_MISMATCH` at publish
 * time instead of an honest "not available on this network" up front.
 */
export async function fetchRegistryAssetsForChain(
  chain: string = 'robinhood',
  assetType?: 'crypto' | 'stock'
): Promise<Asset[]> {
  try {
    const params = new URLSearchParams({ chain });
    if (assetType) params.set('assetType', assetType);
    const res = await fetch(`/api/assets?${params.toString()}`);
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const assets = (data as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) return [];
    return (assets as CanonicalAsset[]).map(canonicalAssetToUiAsset);
  } catch {
    return [];
  }
}
