export interface Asset {
  id: string;
  symbol: string;
  name: string;
  type: 'crypto' | 'stock';
  icon: string;
  price?: number;
  change24h?: number;
  /**
   * Phase 17 — present only for assets resolved from the on-chain asset
   * registry (`GET /api/assets`, backed by `lib/server/asset-repo.ts`),
   * never for the static demo lists below. `price`/`change24h` are
   * intentionally left undefined for these — the registry carries
   * identity, not pricing, and nothing here should ever invent a number
   * for a real Robinhood stock token.
   */
  chain?: string;
  address?: string;
  decimals?: number;
  /** Registry assets only — the token's logo as its source published it (see `AssetIcon`). */
  logoUrl?: string;
  /** Registry assets only — background liquidity check (0043); 'NO_ROUTE' assets are hidden in the picker by default. */
  routeStatus?: 'ROUTABLE' | 'NO_ROUTE';
}

export const cryptoAssets: Asset[] = [
  // Major Cryptocurrencies
  { id: 'btc', symbol: 'BTC', name: 'Bitcoin', type: 'crypto', icon: '₿', price: 42500, change24h: 2.5 },
  { id: 'eth', symbol: 'ETH', name: 'Ethereum', type: 'crypto', icon: 'Ξ', price: 2250, change24h: 1.8 },
  { id: 'sol', symbol: 'SOL', name: 'Solana', type: 'crypto', icon: '◎', price: 145, change24h: 5.2 },
  { id: 'doge', symbol: 'DOGE', name: 'Dogecoin', type: 'crypto', icon: '🐕', price: 0.12, change24h: -1.2 },
  { id: 'shib', symbol: 'SHIB', name: 'Shiba Inu', type: 'crypto', icon: '🐶', price: 0.000015, change24h: 3.4 },
  
  // Layer 2 & Scaling
  { id: 'arb', symbol: 'ARB', name: 'Arbitrum', type: 'crypto', icon: '⚡', price: 1.85, change24h: 4.1 },
  { id: 'op', symbol: 'OP', name: 'Optimism', type: 'crypto', icon: '🔴', price: 2.45, change24h: 2.8 },
  { id: 'matic', symbol: 'MATIC', name: 'Polygon', type: 'crypto', icon: '◆', price: 0.85, change24h: 1.5 },
  { id: 'stg', symbol: 'STG', name: 'Stargate', type: 'crypto', icon: '🌉', price: 0.45, change24h: -0.8 },
  
  // DeFi Tokens
  { id: 'uni', symbol: 'UNI', name: 'Uniswap', type: 'crypto', icon: '🦄', price: 8.50, change24h: 3.2 },
  { id: 'aave', symbol: 'AAVE', name: 'Aave', type: 'crypto', icon: '👻', price: 245, change24h: 2.1 },
  { id: 'curve', symbol: 'CRV', name: 'Curve', type: 'crypto', icon: '📈', price: 0.95, change24h: 1.3 },
  { id: 'mkr', symbol: 'MKR', name: 'Maker', type: 'crypto', icon: '🎯', price: 1850, change24h: 0.5 },
  { id: 'ldo', symbol: 'LDO', name: 'Lido', type: 'crypto', icon: '🔵', price: 2.35, change24h: 4.7 },
  
  // AI & Machine Learning Tokens
  { id: 'fet', symbol: 'FET', name: 'Fetch.ai', type: 'crypto', icon: '🤖', price: 0.35, change24h: 8.5 },
  { id: 'agix', symbol: 'AGIX', name: 'SingularityNET', type: 'crypto', icon: '🧠', price: 0.42, change24h: 6.2 },
  { id: 'agi', symbol: 'AGI', name: 'Artificial Intelligence', type: 'crypto', icon: '⚙️', price: 0.38, change24h: 7.1 },
  
  // RWA Tokens
  { id: 'ondo', symbol: 'ONDO', name: 'Ondo Finance', type: 'crypto', icon: '🏛️', price: 1.25, change24h: 2.3 },
  { id: 'gho', symbol: 'GHO', name: 'Aave GHO', type: 'crypto', icon: '💰', price: 1.0, change24h: 0.1 },
  { id: 'strk', symbol: 'STRK', name: 'StarkNet', type: 'crypto', icon: '⭐', price: 0.65, change24h: 5.8 },
  
  // Meme Coins
  { id: 'pepe', symbol: 'PEPE', name: 'Pepe', type: 'crypto', icon: '🐸', price: 0.00000625, change24h: 12.5 },
  { id: 'bonk', symbol: 'BONK', name: 'Bonk', type: 'crypto', icon: '🪙', price: 0.000085, change24h: -3.2 },
  { id: 'wif', symbol: 'WIF', name: 'dogwifhat', type: 'crypto', icon: '🎩', price: 2.15, change24h: 9.8 },
];

export const stockAssets: Asset[] = [
  // Mega Cap Tech
  { id: 'nvda', symbol: 'NVDA', name: 'NVIDIA', type: 'stock', icon: '🎮', price: 875.50, change24h: 3.2 },
  { id: 'msft', symbol: 'MSFT', name: 'Microsoft', type: 'stock', icon: '🪟', price: 445.80, change24h: 1.5 },
  { id: 'aapl', symbol: 'AAPL', name: 'Apple', type: 'stock', icon: '🍎', price: 228.50, change24h: 0.8 },
  { id: 'googl', symbol: 'GOOGL', name: 'Alphabet', type: 'stock', icon: '🔍', price: 178.25, change24h: 2.1 },
  { id: 'amzn', symbol: 'AMZN', name: 'Amazon', type: 'stock', icon: '📦', price: 188.45, change24h: 1.2 },
  
  // AI Leaders
  { id: 'tsla', symbol: 'TSLA', name: 'Tesla', type: 'stock', icon: '⚡', price: 245.30, change24h: 4.5 },
  { id: 'meta', symbol: 'META', name: 'Meta', type: 'stock', icon: '👁️', price: 512.80, change24h: 2.8 },
  { id: 'avgo', symbol: 'AVGO', name: 'Broadcom', type: 'stock', icon: '📡', price: 165.40, change24h: 1.9 },
  { id: 'amd', symbol: 'AMD', name: 'AMD', type: 'stock', icon: '🔴', price: 185.25, change24h: 2.3 },
  { id: 'qcom', symbol: 'QCOM', name: 'Qualcomm', type: 'stock', icon: '📱', price: 175.80, change24h: 1.1 },
  
  // Cloud & Infrastructure
  { id: 'crwd', symbol: 'CRWD', name: 'CrowdStrike', type: 'stock', icon: '🛡️', price: 385.20, change24h: 3.5 },
  { id: 'net', symbol: 'NET', name: 'Cloudflare', type: 'stock', icon: '☁️', price: 125.60, change24h: 2.2 },
  { id: 'okta', symbol: 'OKTA', name: 'Okta', type: 'stock', icon: '🔐', price: 165.40, change24h: 1.8 },
  { id: 'mongo', symbol: 'MDB', name: 'MongoDB', type: 'stock', icon: '🍃', price: 425.80, change24h: 2.6 },
  
  // Semiconductors
  { id: 'asml', symbol: 'ASML', name: 'ASML', type: 'stock', icon: '🔬', price: 825.50, change24h: 1.7 },
  { id: 'lrcx', symbol: 'LRCX', name: 'Lam Research', type: 'stock', icon: '⚙️', price: 845.25, change24h: 2.4 },
  { id: 'klac', symbol: 'KLAC', name: 'KLA', type: 'stock', icon: '🔍', price: 765.80, change24h: 1.9 },
  
  // AR/VR
  { id: 'nvda', symbol: 'NVDA', name: 'NVIDIA (VR)', type: 'stock', icon: '🥽', price: 875.50, change24h: 3.2 },
  
  // Payments & FinTech
  { id: 'pypl', symbol: 'PYPL', name: 'PayPal', type: 'stock', icon: '💳', price: 65.40, change24h: 0.5 },
  { id: 'sq', symbol: 'SQ', name: 'Square', type: 'stock', icon: '◼️', price: 185.25, change24h: 1.8 },
];

export const allAssets = [...cryptoAssets, ...stockAssets];

export function getAssetsByType(type: 'crypto' | 'stock'): Asset[] {
  return allAssets.filter(a => a.type === type);
}

/** Symbol/name substring match over an arbitrary asset list — used by `AssetSelector` so it can search whatever pool (static + registry-backed) it was given, not just the static `allAssets`. */
export function filterAssetsByQuery(assets: Asset[], query: string): Asset[] {
  const q = query.toLowerCase();
  return assets.filter(a => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
}

export function searchAssets(query: string): Asset[] {
  return filterAssetsByQuery(allAssets, query);
}
export function formatPrice(price: number): string {
  if (price >= 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(8)}`;
}

export function formatUSD(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: amount >= 100 ? 0 : 2,
  });
}