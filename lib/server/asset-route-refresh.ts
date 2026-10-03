import { SupabaseClient } from '@supabase/supabase-js';
import { CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { listAssets, updateAssetRouteStatus } from './asset-repo';
import { AssetRouteStatus, checkAssetRoute } from './asset-route-check';

// -----------------------------------------------------------------------------
// Background liquidity refresh for the asset registry (0043). Picks the
// VERIFIED assets checked longest ago (never-checked first), probes each
// with the same small LI.FI quote the Create page uses (asset-route-check.ts)
// and stores ROUTABLE / NO_ROUTE. A transient provider error (UNKNOWN) leaves
// the stored status alone so the next run retries it.
//
// Bounded per run (`limit`, small concurrency) so one serverless invocation
// stays well inside its time budget; a full pass over the registry takes a
// few scheduled runs.
// -----------------------------------------------------------------------------

export interface RefreshAssetRoutesOptions {
  chain?: ChainId;
  limit?: number;
  concurrency?: number;
  /** Skip assets checked more recently than this. */
  staleAfterMs?: number;
}

export interface RefreshAssetRoutesResult {
  checked: number;
  routable: number;
  noRoute: number;
  unknown: number;
}

const DEFAULTS = { limit: 40, concurrency: 5, staleAfterMs: 6 * 60 * 60 * 1000 };

export function pickAssetsToCheck(assets: CanonicalAsset[], now: number, limit: number, staleAfterMs: number): CanonicalAsset[] {
  return assets
    .filter((a) => !a.routeCheckedAt || now - new Date(a.routeCheckedAt).getTime() > staleAfterMs)
    .sort((a, b) => (a.routeCheckedAt ? new Date(a.routeCheckedAt).getTime() : 0) - (b.routeCheckedAt ? new Date(b.routeCheckedAt).getTime() : 0))
    .slice(0, limit);
}

export async function refreshAssetRouteStatuses(
  admin: SupabaseClient,
  options: RefreshAssetRoutesOptions = {},
  probe: (asset: { chain: ChainId; address: string }) => Promise<AssetRouteStatus> = (a) => checkAssetRoute(a)
): Promise<RefreshAssetRoutesResult> {
  const limit = options.limit ?? DEFAULTS.limit;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const staleAfterMs = options.staleAfterMs ?? DEFAULTS.staleAfterMs;

  const assets = await listAssets(admin, { status: 'VERIFIED', chain: options.chain });
  const queue = pickAssetsToCheck(assets, Date.now(), limit, staleAfterMs);
  const result: RefreshAssetRoutesResult = { checked: 0, routable: 0, noRoute: 0, unknown: 0 };

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const asset = queue[next++];
      const status = await probe({ chain: asset.chain, address: asset.address });
      result.checked++;
      if (status === 'UNKNOWN') {
        result.unknown++;
        continue;
      }
      await updateAssetRouteStatus(admin, asset.id, status);
      if (status === 'ROUTABLE') result.routable++;
      else result.noRoute++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}
