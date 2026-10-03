import { TradableSymbol } from '@/types/domain';

export interface AssetDefinition {
  symbol: TradableSymbol;
  name: string;
  basePrice: number;
  /** Max fractional move applied per "tick" when simulating price drift (fallback only). */
  volatility: number;
  /** CoinGecko coin id, used to fetch real market prices client-side. */
  coingeckoId: string;
}

export const TRADABLE_ASSETS: AssetDefinition[] = [
  { symbol: 'BTC', name: 'Bitcoin', basePrice: 64000, volatility: 0.02, coingeckoId: 'bitcoin' },
  { symbol: 'ETH', name: 'Ethereum', basePrice: 3400, volatility: 0.025, coingeckoId: 'ethereum' },
  { symbol: 'SOL', name: 'Solana', basePrice: 165, volatility: 0.035, coingeckoId: 'solana' },
  { symbol: 'BNB', name: 'BNB', basePrice: 580, volatility: 0.02, coingeckoId: 'binancecoin' },
  { symbol: 'XRP', name: 'XRP', basePrice: 0.62, volatility: 0.03, coingeckoId: 'ripple' },
  { symbol: 'DOGE', name: 'Dogecoin', basePrice: 0.14, volatility: 0.05, coingeckoId: 'dogecoin' },
  { symbol: 'LINK', name: 'Chainlink', basePrice: 14.5, volatility: 0.03, coingeckoId: 'chainlink' },
  { symbol: 'AVAX', name: 'Avalanche', basePrice: 32, volatility: 0.04, coingeckoId: 'avalanche-2' },
];

export const STARTING_DEMO_BALANCE = 10_000;
