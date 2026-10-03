import { BasketRecipe, RecipeAsset } from '@/types/basket-protocol';
import { assetIdentityKey } from './asset-identity';

// -----------------------------------------------------------------------------
// Strategy Diff: what changed between two versions of a Bag's recipe — assets
// added, removed or re-weighted, and the strategy settings that changed. Pure
// and deterministic, so the Bag page, the API and (later) agents all read the
// same answer. Assets are matched by identity (chain + address), never by
// symbol.
// -----------------------------------------------------------------------------

export type AssetChangeKind = 'ADDED' | 'REMOVED' | 'REWEIGHTED' | 'UNCHANGED';

export interface AssetWeightChange {
  identityKey: string;
  chain: RecipeAsset['chain'];
  address: string;
  symbol: string;
  /** Null when the asset is not in that version. */
  fromBps: number | null;
  toBps: number | null;
  /** toBps − fromBps, counting a missing side as 0. */
  deltaBps: number;
  kind: AssetChangeKind;
}

export interface SettingChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

export interface StrategyDiff {
  assets: AssetWeightChange[];
  settings: SettingChange[];
  /** True when nothing in `assets` or `settings` changed. */
  unchanged: boolean;
}

type DiffableRecipe = Pick<BasketRecipe, 'assets'> &
  Partial<Pick<BasketRecipe, 'performanceFeeBps' | 'unroutablePolicy' | 'rebalanceRule' | 'minWeightBps' | 'maxWeightBps' | 'maxAssets' | 'minInvestment' | 'mutability'>>;

const pct = (bps: number | undefined) => (bps === undefined ? '—' : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`);
const plain = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));

const SETTINGS: { field: string; label: string; read: (r: DiffableRecipe) => string }[] = [
  { field: 'performanceFeeBps', label: 'Performance fee', read: (r) => pct(r.performanceFeeBps ?? 0) },
  { field: 'unroutablePolicy', label: 'Unroutable asset policy', read: (r) => plain(r.unroutablePolicy) },
  { field: 'rebalanceRule.frequency', label: 'Rebalance frequency', read: (r) => plain(r.rebalanceRule?.frequency) },
  { field: 'rebalanceRule.driftThresholdBps', label: 'Rebalance drift threshold', read: (r) => pct(r.rebalanceRule?.driftThresholdBps) },
  { field: 'rebalanceRule.maxSlippageBps', label: 'Max slippage per rebalance trade', read: (r) => pct(r.rebalanceRule?.maxSlippageBps) },
  { field: 'minWeightBps', label: 'Min weight per asset', read: (r) => pct(r.minWeightBps) },
  { field: 'maxWeightBps', label: 'Max weight per asset', read: (r) => pct(r.maxWeightBps) },
  { field: 'maxAssets', label: 'Max assets', read: (r) => plain(r.maxAssets) },
  { field: 'minInvestment', label: 'Min investment', read: (r) => plain(r.minInvestment) },
  { field: 'mutability', label: 'Mutability', read: (r) => plain(r.mutability) },
];

const ORDER: Record<AssetChangeKind, number> = { ADDED: 0, REWEIGHTED: 1, REMOVED: 2, UNCHANGED: 3 };

/**
 * Diff `previous` → `next`. With `previous` null (the first version) every
 * asset is ADDED and no settings are reported.
 */
export function diffRecipes(previous: DiffableRecipe | null, next: DiffableRecipe): StrategyDiff {
  const before = new Map((previous?.assets ?? []).map((a) => [assetIdentityKey(a), a] as const));
  const after = new Map(next.assets.map((a) => [assetIdentityKey(a), a] as const));
  const keys = new Set([...before.keys(), ...after.keys()]);

  const assets: AssetWeightChange[] = Array.from(keys).map((key) => {
    const from = before.get(key) ?? null;
    const to = after.get(key) ?? null;
    const ref = (to ?? from)!;
    const fromBps = from ? from.weightBps : null;
    const toBps = to ? to.weightBps : null;
    const kind: AssetChangeKind = !from ? 'ADDED' : !to ? 'REMOVED' : fromBps !== toBps ? 'REWEIGHTED' : 'UNCHANGED';
    return { identityKey: key, chain: ref.chain, address: ref.address, symbol: ref.symbol, fromBps, toBps, deltaBps: (toBps ?? 0) - (fromBps ?? 0), kind };
  });
  assets.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || Math.abs(b.deltaBps) - Math.abs(a.deltaBps) || a.symbol.localeCompare(b.symbol));

  const settings: SettingChange[] = previous
    ? SETTINGS.map((s) => ({ field: s.field, label: s.label, from: s.read(previous), to: s.read(next) })).filter((c) => c.from !== c.to)
    : [];

  return { assets, settings, unchanged: assets.every((a) => a.kind === 'UNCHANGED') && settings.length === 0 };
}
