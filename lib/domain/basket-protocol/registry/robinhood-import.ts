import { AssetIdentity, CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { assetIdentityKey, normalizeAssetIdentity } from '../asset-identity';
import { RegisterAssetInput, RegisterAssetResult } from '@/lib/server/asset-repo';
import { LogoUpdate, planLogoUpdates, sanitizeLogoUrl } from './logo-url';

// Phase 16 — `MultiplierUpdate`/`RobinhoodImportPlan.multiplierUpdates`/
// `applyMultiplierUpdates()` below close the gap this module's own Phase
// 15 comments used to flag: `alreadyRegistered` only ever meant "still
// present at this (chain, address)", never "still has the multiplier we
// last recorded". A Stock Token split/reverse-split changes
// `currentMultiplier` on the remote feed without touching the contract
// address, so it always landed in `alreadyRegistered` and the stale
// number sat in the registry until someone noticed. This is intentionally
// the smallest fix that closes it — one extra diff bucket alongside the
// existing four, reusing `updateAssetMultiplier()` (asset-repo.ts) the
// same way `applyRobinhoodImportPlan()` already reuses `registerAsset()`
// — not a rewrite of the plan/apply architecture itself.

// -----------------------------------------------------------------------------
// Imports Robinhood Stock Tokens (docs.robinhood.com/chain/stock-token-apis)
// into the BAG Asset Registry (`lib/server/asset-repo.ts`).
//
//               GET https://api.robinhood.com/rhj/assets
//                              |
//                              v
//               filter: deployment.chainId === 4663 (Robinhood Chain)
//                       && status === ASSET_STATUS_ACTIVE
//                              |
//                              v
//                    planRobinhoodImport()   <-- pure, no I/O, no writes
//                              |
//                              v
//                    RobinhoodImportPlan  { toRegister, alreadyRegistered,
//                                            possiblyDelisted, skipped }
//                              |
//                              v (only if the caller decides to)
//                    applyRobinhoodImportPlan(admin, plan)
//
// Two things this deliberately does NOT do:
//
// 1. It never hardcodes contract addresses. `GET /rhj/assets` is
//    documented as "generated live from the on-chain asset registry"
//    (docs.robinhood.com/chain/contracts) — Robinhood can add, delist, or
//    (rarely) redeploy a Stock Token at any time, and a hand-copied address
//    list would silently go stale. This module always reads live.
//
// 2. It never calls `registerAsset()` on its own. Planning (read-only) and
//    applying (write) are separate functions so a caller — the admin
//    script in `scripts/import-robinhood-assets.ts`, or a future
//    admin-only API route — can review the diff before anything touches
//    the database. `asset-repo.ts`'s security-boundary comment already
//    establishes that every registry write must come from an
//    admin/service-role path; this module doesn't change that, it's just
//    another producer of `RegisterAssetInput`s for that same trust
//    boundary.
// -----------------------------------------------------------------------------

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_ASSETS_URL = 'https://api.robinhood.com/rhj/assets';

/**
 * Chain ids this importer will register a Stock Token deployment under,
 * beyond Robinhood Chain itself. Robinhood's Stock Tokens were originally
 * issued on Arbitrum One (chain id 42161) before Robinhood Chain's mainnet
 * launch, and the live `/rhj/assets` feed's `deployments[]` can still list
 * an Arbitrum One entry alongside (or instead of) a Robinhood Chain one for
 * a given asset — this is REAL data from Robinhood's own registry, not a
 * guess. Ethereum and Base are deliberately absent: nothing found as of
 * writing indicates Robinhood issues Stock Tokens on either. If that
 * changes, add the chain id here — `mapRobinhoodAssetsForChain()` below
 * already works for any chain id actually present in the live feed, this
 * map just controls which ones `scripts/import-robinhood-assets.ts`
 * accepts as a `--chain` argument.
 */
export const ROBINHOOD_TRACKED_CHAIN_IDS: Partial<Record<ChainId, number>> = {
  robinhood: ROBINHOOD_CHAIN_ID,
  arbitrum: 42161,
};
const ACTIVE_STATUS = 'ASSET_STATUS_ACTIVE';
const FETCH_TIMEOUT_MS = 10_000;

// ----------------------------- Raw API shapes --------------------------------
// Mirrors the actual response of GET /rhj/assets. Kept intentionally
// loose/optional on fields this module doesn't use (isin,
// tradingCapabilities, pendingMultiplier, ...) so an additive API change
// upstream doesn't break parsing here.

export interface RobinhoodDeployment {
  contractAddress: string;
  chainId: number;
  networkName?: string;
}

export interface RobinhoodAsset {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  deployments: RobinhoodDeployment[];
  currentMultiplier: string;
  status: string;
  tokenDecimals: number;
  [key: string]: unknown;
}

interface RobinhoodAssetsResponse {
  assets: RobinhoodAsset[];
}

export class RobinhoodFetchError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RobinhoodFetchError';
  }
}

/**
 * Fetches the live Stock Token registry. Throws `RobinhoodFetchError` on
 * any failure (network, timeout, non-200, unexpected shape) rather than
 * returning null/empty — unlike `lib/market/price-feed.ts`'s
 * `fetchLivePrices()`, which silently falls back for a best-effort UI
 * price tick, a registry import is an explicit admin action: a caller
 * silently treating "the fetch failed" the same as "there are zero active
 * Stock Tokens right now" is exactly the kind of failure that should be
 * loud, not swallowed.
 */
export async function fetchRobinhoodAssets(
  fetchImpl: typeof fetch = fetch,
  url: string = ROBINHOOD_ASSETS_URL
): Promise<RobinhoodAsset[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
  } catch (err) {
    throw new RobinhoodFetchError(`Failed to reach ${url}`, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new RobinhoodFetchError(`${url} responded ${res.status} ${res.statusText}`);
  }

  let data: RobinhoodAssetsResponse;
  try {
    data = (await res.json()) as RobinhoodAssetsResponse;
  } catch (err) {
    throw new RobinhoodFetchError('Response was not valid JSON', err);
  }

  if (!Array.isArray(data?.assets)) {
    throw new RobinhoodFetchError('Response did not contain an `assets` array — API shape may have changed');
  }

  return data.assets;
}

/** The deployment on Robinhood Chain specifically, if this asset has one. An asset can list deployments on other chains too — only chainId 4663 is canonical for BAG's `chain: 'robinhood'`. */
export function robinhoodChainDeployment(asset: RobinhoodAsset): RobinhoodDeployment | undefined {
  return asset.deployments?.find((d) => d.chainId === ROBINHOOD_CHAIN_ID);
}

export interface SkippedAsset {
  tokenSymbol: string;
  reason: 'NO_ROBINHOOD_DEPLOYMENT' | 'NOT_ACTIVE' | 'MISSING_DECIMALS';
}

/** The deployment on `chainId` specifically, if this asset has one — generalizes `robinhoodChainDeployment()` to any chain id actually present in the live feed's `deployments[]`. */
export function deploymentForChainId(asset: RobinhoodAsset, chainId: number): RobinhoodDeployment | undefined {
  return asset.deployments?.find((d) => d.chainId === chainId);
}

/**
 * Maps active, remote assets deployed on `targetChain` to
 * `RegisterAssetInput`s. Pure and side-effect free — does not check what's
 * already in the registry (see `planRobinhoodImportForChain()` for the diff
 * against existing `CanonicalAsset`s). `targetChain` must be a key of
 * `ROBINHOOD_TRACKED_CHAIN_IDS` — this is what lets the exact same live
 * feed back both `chain: 'robinhood'` and `chain: 'arbitrum'` Stock Token
 * registrations without two separate fetchers.
 */
export function mapRobinhoodAssetsForChain(
  remote: RobinhoodAsset[],
  targetChain: ChainId
): {
  candidates: RegisterAssetInput[];
  skipped: SkippedAsset[];
} {
  const targetChainId = ROBINHOOD_TRACKED_CHAIN_IDS[targetChain];
  if (targetChainId === undefined) {
    throw new Error(
      `"${targetChain}" is not in ROBINHOOD_TRACKED_CHAIN_IDS — add it there first (see that map's doc comment).`
    );
  }

  const candidates: RegisterAssetInput[] = [];
  const skipped: SkippedAsset[] = [];

  for (const asset of remote) {
    if (asset.status !== ACTIVE_STATUS) {
      skipped.push({ tokenSymbol: asset.tokenSymbol, reason: 'NOT_ACTIVE' });
      continue;
    }
    const deployment = deploymentForChainId(asset, targetChainId);
    if (!deployment) {
      skipped.push({ tokenSymbol: asset.tokenSymbol, reason: 'NO_ROBINHOOD_DEPLOYMENT' });
      continue;
    }
    if (typeof asset.tokenDecimals !== 'number') {
      skipped.push({ tokenSymbol: asset.tokenSymbol, reason: 'MISSING_DECIMALS' });
      continue;
    }

    candidates.push({
      chain: targetChain,
      address: deployment.contractAddress,
      // Canonical symbol per docs.robinhood.com/chain/stock-token-apis:
      // no "x" prefix (e.g. "NVDA", not "xNVDA"). Any display-layer prefix
      // convention belongs in the UI, not in the registry's canonical
      // symbol.
      symbol: asset.tokenSymbol,
      decimals: asset.tokenDecimals,
      name: asset.tokenName,
      assetType: 'stock',
      // Passed through as-received (decimal string) — see
      // `CanonicalAsset.currentMultiplier`'s doc comment for why this is
      // never parsed to a JS number here.
      currentMultiplier: asset.currentMultiplier,
      // The feed's `logoUrl` is Robinhood's Stock Token mark (the same
      // feather for every token) — the icon wallets and Jumper show for these
      // tokens. The picker pairs it with the ticker and company name, so it
      // still reads as a specific stock.
      logoUrl: sanitizeLogoUrl(asset.logoUrl),
    });
  }

  return { candidates, skipped };
}

/** @deprecated Back-compat wrapper — equivalent to `mapRobinhoodAssetsForChain(remote, 'robinhood')`. Kept so existing callers/tests importing `mapRobinhoodAssets` are unaffected by the multi-chain generalization above. */
export function mapRobinhoodAssets(remote: RobinhoodAsset[]): {
  candidates: RegisterAssetInput[];
  skipped: SkippedAsset[];
} {
  return mapRobinhoodAssetsForChain(remote, 'robinhood');
}

export interface RobinhoodImportPlan {
  /** Not yet in the registry at this (chain, address) — safe to `registerAsset()`. */
  toRegister: RegisterAssetInput[];
  /** Already registered and still active on the remote feed — no action needed. */
  alreadyRegistered: CanonicalAsset[];
  /**
   * Currently VERIFIED in the registry, but no longer present as an
   * active Robinhood-Chain deployment on the remote feed. This is a
   * signal for a human to review (delisting, corporate action, symbol
   * change), never auto-applied — `applyRobinhoodImportPlan()` does not
   * touch these.
   */
  possiblyDelisted: CanonicalAsset[];
  /** Remote assets that couldn't be mapped, and why. */
  skipped: SkippedAsset[];
  /**
   * Phase 16 — subset of `alreadyRegistered` whose remote
   * `currentMultiplier` no longer matches what's stored locally. Decimal
   * strings compared as exact strings, never parsed to a JS number
   * (same rule as everywhere else this field appears) — so `"1"` vs
   * `"1.0"` would (correctly, if narrowly) still be flagged; the remote
   * feed is expected to be stable about formatting, and a false-positive
   * update here is a harmless idempotent no-op, never a data-loss risk.
   */
  multiplierUpdates: MultiplierUpdate[];
  /** Already-registered assets whose feed `logoUrl` is new or changed. */
  logoUpdates: LogoUpdate[];
}

export interface MultiplierUpdate {
  asset: CanonicalAsset;
  previousMultiplier: string | undefined;
  newMultiplier: string;
}

/**
 * Pure diff between the live remote feed and the current registry state —
 * no I/O. Identity is `(chain, address)`, never `symbol` (per
 * `asset-identity.ts`), so a Robinhood Stock Token that changes symbol on
 * a corporate action but keeps the same contract is correctly treated as
 * "already registered", not as a new asset plus a delisting.
 */
export function planRobinhoodImportForChain(
  remote: RobinhoodAsset[],
  existingRobinhoodAssets: CanonicalAsset[],
  targetChain: ChainId
): RobinhoodImportPlan {
  const { candidates, skipped } = mapRobinhoodAssetsForChain(remote, targetChain);

  const remoteKeys = new Set(
    candidates.map((c) => assetIdentityKey({ chain: c.chain, address: c.address }))
  );
  const existingByKey = new Map(
    existingRobinhoodAssets.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a])
  );

  const toRegister = candidates.filter(
    (c) => !existingByKey.has(assetIdentityKey({ chain: c.chain, address: c.address }))
  );
  const alreadyRegistered = existingRobinhoodAssets.filter((a) =>
    remoteKeys.has(assetIdentityKey({ chain: a.chain, address: a.address }))
  );
  // Stock rows only: crypto on the same chain (WETH, USDG — lifi-import.ts)
  // is never on Robinhood's Stock Token feed, so it is not "delisted".
  const possiblyDelisted = existingRobinhoodAssets.filter(
    (a) =>
      a.status === 'VERIFIED' &&
      a.assetType !== 'crypto' &&
      !remoteKeys.has(assetIdentityKey({ chain: a.chain, address: a.address }))
  );

  const candidatesByKey = new Map(
    candidates.map((c) => [assetIdentityKey({ chain: c.chain, address: c.address }), c])
  );
  const multiplierUpdates: MultiplierUpdate[] = [];
  for (const existing of alreadyRegistered) {
    const remote = candidatesByKey.get(assetIdentityKey({ chain: existing.chain, address: existing.address }));
    if (remote && remote.currentMultiplier !== undefined && remote.currentMultiplier !== existing.currentMultiplier) {
      multiplierUpdates.push({
        asset: existing,
        previousMultiplier: existing.currentMultiplier,
        newMultiplier: remote.currentMultiplier,
      });
    }
  }

  const logoUpdates = planLogoUpdates(
    alreadyRegistered,
    new Map(candidates.map((c) => [assetIdentityKey({ chain: c.chain, address: c.address }), c.logoUrl])),
    (a) => assetIdentityKey({ chain: a.chain, address: a.address })
  );

  return { toRegister, alreadyRegistered, possiblyDelisted, skipped, multiplierUpdates, logoUpdates };
}

/** @deprecated Back-compat wrapper — equivalent to `planRobinhoodImportForChain(remote, existingRobinhoodAssets, 'robinhood')`. Kept so existing callers/tests are unaffected by the multi-chain generalization above. */
export function planRobinhoodImport(
  remote: RobinhoodAsset[],
  existingRobinhoodAssets: CanonicalAsset[]
): RobinhoodImportPlan {
  return planRobinhoodImportForChain(remote, existingRobinhoodAssets, 'robinhood');
}

export interface ApplyRobinhoodImportResult {
  registered: CanonicalAsset[];
  failed: { input: RegisterAssetInput; error: string }[];
}

/**
 * Writes `plan.toRegister` to the registry via `registerAsset()` — the
 * one function in this module that touches the database, so it's the one
 * that inherits `asset-repo.ts`'s security boundary: only call this from
 * an admin/service-role code path (the seed-style CLI script in
 * `scripts/import-robinhood-assets.ts`, or a future admin-only route),
 * never from anything a normal user request can reach directly.
 *
 * Registers `VERIFIED` (the `registerAsset()` default) — running this IS
 * the registry vouching for the asset, same as every other call site.
 * Continues past individual failures (e.g. a duplicate that slipped in
 * between planning and applying) rather than aborting the whole batch;
 * every outcome is reported back for the caller to act on.
 */
export async function applyRobinhoodImportPlan(
  registerAssetFn: (input: RegisterAssetInput) => Promise<RegisterAssetResult>,
  plan: RobinhoodImportPlan
): Promise<ApplyRobinhoodImportResult> {
  const registered: CanonicalAsset[] = [];
  const failed: { input: RegisterAssetInput; error: string }[] = [];

  for (const input of plan.toRegister) {
    const result = await registerAssetFn(input);
    if (result.ok) {
      registered.push(result.asset);
    } else {
      failed.push({ input, error: result.message });
    }
  }

  return { registered, failed };
}

export interface ApplyMultiplierUpdatesResult {
  updated: CanonicalAsset[];
  failed: { update: MultiplierUpdate; error: string }[];
}

/**
 * Phase 16 — applies `plan.multiplierUpdates` via `updateAssetMultiplier()`
 * (asset-repo.ts). Deliberately a SEPARATE function from
 * `applyRobinhoodImportPlan()` above rather than folded into it: a
 * multiplier sync is a metadata correction on an asset the registry
 * already vouches for, not a registration decision, so a caller can
 * choose to run one without the other (e.g. auto-sync multipliers on a
 * schedule, while still requiring a human to review `plan.toRegister`
 * before any NEW asset is registered). Continues past individual
 * failures, same convention as `applyRobinhoodImportPlan()`. Idempotent —
 * see `MultiplierUpdate`'s doc comment.
 */
export async function applyMultiplierUpdates(
  updateFn: (id: string, currentMultiplier: string) => Promise<CanonicalAsset>,
  plan: RobinhoodImportPlan
): Promise<ApplyMultiplierUpdatesResult> {
  const updated: CanonicalAsset[] = [];
  const failed: { update: MultiplierUpdate; error: string }[] = [];

  for (const update of plan.multiplierUpdates) {
    try {
      updated.push(await updateFn(update.asset.id, update.newMultiplier));
    } catch (err) {
      failed.push({ update, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  return { updated, failed };
}

/** Convenience re-export so callers importing this module don't also need `asset-identity.ts` just to key a `CanonicalAsset` the same way this module does internally. */
export function robinhoodAssetKey(identity: AssetIdentity): string {
  return assetIdentityKey(normalizeAssetIdentity(identity));
}
