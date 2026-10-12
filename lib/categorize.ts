import { allAssets } from '@/lib/create-assets-data';
import { BagPosition } from '@/types';

export type AssetCategory = 'Crypto' | 'AI' | 'DeFi' | 'Stocks' | 'RWA' | 'Meme' | 'Stable';

// Rough categorization by asset id — good enough for a "diversification score"
// visualization without needing a real sector-classification service.
const CATEGORY_BY_ID: Record<string, AssetCategory> = {
  // AI
  fet: 'AI', agix: 'AI', agi: 'AI', nvda: 'AI', amd: 'AI', avgo: 'AI', qcom: 'AI',
  crwd: 'AI', net: 'AI', okta: 'AI', mongo: 'AI', asml: 'AI', lrcx: 'AI', klac: 'AI',
  meta: 'AI', googl: 'AI', msft: 'AI', tsla: 'AI',
  // DeFi
  uni: 'DeFi', aave: 'DeFi', curve: 'DeFi', mkr: 'DeFi', ldo: 'DeFi', gho: 'DeFi',
  ondo: 'RWA', strk: 'DeFi',
  // Meme
  doge: 'Meme', shib: 'Meme', pepe: 'Meme', bonk: 'Meme', wif: 'Meme',
  // Stocks (non-AI-classified)
  aapl: 'Stocks', amzn: 'Stocks', pypl: 'Stocks', sq: 'Stocks',
};

export function categoryForSymbol(symbol: string): AssetCategory {
  const asset = allAssets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
  if (!asset) return 'Crypto';
  return CATEGORY_BY_ID[asset.id] ?? (asset.type === 'stock' ? 'Stocks' : 'Crypto');
}

/**
 * Prefers the registry's own `assetType` (set on positions the API could
 * resolve) over the static demo list: a real Robinhood Stock Token like
 * PFE or IBRX isn't in that list and used to fall through to 'Crypto'.
 * The sector map above still refines known symbols (e.g. KLAC -> AI).
 * The chain's pinned settlement stablecoin (`stable`, set by the API) is 'Stable'.
 */
export function categoryForPosition(pos: Pick<BagPosition, 'symbol' | 'assetType' | 'stable'>): AssetCategory {
  if (pos.stable) return 'Stable';
  if (!pos.assetType) return categoryForSymbol(pos.symbol);
  const sector = CATEGORY_BY_ID[pos.symbol.toLowerCase()];
  if (pos.assetType === 'stock') return sector && sector !== 'Meme' && sector !== 'DeFi' ? sector : 'Stocks';
  return sector && sector !== 'Stocks' ? sector : 'Crypto';
}

export interface CategoryBreakdown {
  category: AssetCategory;
  weight: number;
}

export function getCategoryBreakdown(composition: BagPosition[]): CategoryBreakdown[] {
  const totals = new Map<AssetCategory, number>();
  composition.forEach((pos) => {
    const cat = categoryForPosition(pos);
    totals.set(cat, (totals.get(cat) || 0) + pos.weight);
  });
  return Array.from(totals.entries())
    .map(([category, weight]) => ({ category, weight }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * A 0-100 diversification score derived from the (inverse) Herfindahl-Hirschman
 * Index across category weights — evenly split categories score high,
 * a single-category bag scores low.
 */
export function getDiversificationScore(composition: BagPosition[]): number {
  const breakdown = getCategoryBreakdown(composition);
  if (breakdown.length === 0) return 0;
  const hhi = breakdown.reduce((sum, c) => sum + Math.pow(c.weight / 100, 2), 0);
  const maxHhi = 1; // fully concentrated in one category
  const minHhi = 1 / breakdown.length; // as spread out as possible given the category count
  // Normalize so a single category = low score, evenly spread = high score,
  // then blend in a bonus for simply having more distinct categories.
  const evenness = maxHhi > minHhi ? 1 - (hhi - minHhi) / (maxHhi - minHhi) : 0;
  const breadthBonus = Math.min(breakdown.length, 5) * 4; // up to +20 for variety
  const score = evenness * 80 + breadthBonus;
  return Math.round(Math.max(0, Math.min(100, score)));
}

export const CATEGORY_COLORS: Record<AssetCategory, string> = {
  Crypto: '#00D084',
  AI: '#8B5CF6',
  DeFi: '#F59E0B',
  Stocks: '#3B82F6',
  RWA: '#EC4899',
  Meme: '#EF4444',
  Stable: '#94A3B8',
};
