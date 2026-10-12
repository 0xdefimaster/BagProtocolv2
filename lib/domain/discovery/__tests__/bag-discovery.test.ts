import { describe, expect, it } from 'vitest';
import { assessRisk, availableCategories, bagCategories, discoverBags, type DiscoveryFilter } from '@/lib/domain/discovery/bag-discovery';
import { isSettlementStablecoin } from '@/lib/domain/discovery/stablecoin';
import type { Bag, BagPosition } from '@/types';

const stock = (symbol: string, weight: number): BagPosition => ({ symbol, weight, assetType: 'stock' });
const coin = (symbol: string, weight: number): BagPosition => ({ symbol, weight, assetType: 'crypto' });
const usdg = (weight: number): BagPosition => ({ symbol: 'USDG', weight, assetType: 'crypto', stable: true });

function bag(id: string, composition: BagPosition[], o: Partial<Bag> = {}): Bag {
  return {
    id,
    name: `Bag ${id}`,
    creator: { name: `creator-${id}`, avatar: '', address: '0x', followers: 0, forks: 0 },
    description: '',
    thesis: '',
    tvl: 0,
    followers: 0,
    forks: 0,
    performance7d: 0,
    performance30d: 0,
    performanceYtd: 0,
    chains: ['robinhood'],
    composition,
    rules: { rebalanceFrequency: '', slippage: 0, minInvestment: 0 },
    social: { followers: 0, forks: 0 },
    performance: { returnsYTD: 0 },
    updateLog: [],
    ...o,
  };
}

describe('isSettlementStablecoin', () => {
  it('only the pinned Robinhood USDG, by address, any case', () => {
    expect(isSettlementStablecoin('robinhood', '0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168')).toBe(true);
    expect(isSettlementStablecoin('base', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')).toBe(false);
    expect(isSettlementStablecoin('robinhood', '0x' + '1'.repeat(40))).toBe(false);
  });
});

describe('assessRisk', () => {
  it('low when mostly in the stablecoin', () => {
    expect(assessRisk([usdg(70), stock('AAPL', 30)])).toEqual({ level: 'Low', reasons: ['70% in stablecoins', '30% in stock tokens', 'Largest position 30%'] });
  });

  it('high on crypto share, one large position, or meme coins', () => {
    expect(assessRisk([coin('ETH', 35), coin('SOL', 30), stock('AAPL', 35)])?.level).toBe('High');
    expect(assessRisk([stock('NVDA', 65), stock('AAPL', 35)])?.level).toBe('High');
    expect(assessRisk([coin('DOGE', 20), stock('AAPL', 40), stock('MSFT', 40)])?.level).toBe('High');
  });

  it('medium otherwise; an asset without a registry type counts as crypto', () => {
    expect(assessRisk([stock('AAPL', 40), stock('MSFT', 30), coin('ETH', 30)])?.level).toBe('Medium');
    expect(assessRisk([{ symbol: 'XYZ', weight: 60 }, stock('AAPL', 40)])?.level).toBe('High');
  });

  it('null for an empty composition; bad weights count as zero', () => {
    expect(assessRisk([])).toBeNull();
    expect(assessRisk([stock('AAPL', Number.NaN), usdg(100)])?.level).toBe('Low');
  });
});

describe('categories', () => {
  it('a Bag is listed under categories holding at least 20% of it', () => {
    expect(bagCategories([stock('AAPL', 70), usdg(20), coin('ETH', 10)])).toEqual(['Stocks', 'Stable']);
  });

  it('available categories, most common first', () => {
    const bags = [bag('a', [stock('AAPL', 100)]), bag('b', [stock('AAPL', 50), usdg(50)]), bag('c', [coin('ETH', 100)])];
    expect(availableCategories(bags)).toEqual(['Stocks', 'Crypto', 'Stable']);
  });
});

describe('discoverBags', () => {
  const base: DiscoveryFilter = { query: '', category: 'All', risk: 'Any', sort: 'newest', watchlist: new Set() };
  const a = bag('a', [stock('AAPL', 50), stock('MSFT', 50)], { tvl: 100, holders: 3 });
  const b = bag('b', [usdg(80), coin('ETH', 20)], { tvl: 500, holders: 1, performanceRecorded: { '7D': null, '30D': 4, YTD: null } as Bag['performanceRecorded'] });
  const c = bag('c', [coin('ETH', 100)], { tvl: Number.NaN, performanceRecorded: { '7D': null, '30D': -2, YTD: null } as Bag['performanceRecorded'] });
  const all = [a, b, c];
  const ids = (bags: Bag[]) => bags.map((x) => x.id);

  it('newest keeps the API order', () => {
    expect(ids(discoverBags(all, base))).toEqual(['a', 'b', 'c']);
  });

  it('search matches name, creator or asset symbol', () => {
    expect(ids(discoverBags(all, { ...base, query: 'msft' }))).toEqual(['a']);
    expect(ids(discoverBags(all, { ...base, query: 'CREATOR-B' }))).toEqual(['b']);
    expect(ids(discoverBags(all, { ...base, query: 'eth' }))).toEqual(['b', 'c']);
  });

  it('category, risk and watchlist filters', () => {
    expect(ids(discoverBags(all, { ...base, category: 'Stocks' }))).toEqual(['a']);
    expect(ids(discoverBags(all, { ...base, risk: 'Low' }))).toEqual(['b']);
    expect(ids(discoverBags(all, { ...base, risk: 'High' }))).toEqual(['c']);
    expect(ids(discoverBags(all, { ...base, category: 'Watchlist', watchlist: new Set(['c', 'a']) }))).toEqual(['a', 'c']);
  });

  it('sorts highest first, missing values last', () => {
    expect(ids(discoverBags(all, { ...base, sort: 'tvl' }))).toEqual(['b', 'a', 'c']);
    expect(ids(discoverBags(all, { ...base, sort: 'return30d' }))).toEqual(['b', 'c', 'a']);
    expect(ids(discoverBags(all, { ...base, sort: 'holders' }))).toEqual(['a', 'b', 'c']);
  });

  it('tolerates partial API rows', () => {
    const partial = { id: 'p', name: 'Partial' } as Bag;
    expect(ids(discoverBags([partial], { ...base, query: 'part' }))).toEqual(['p']);
    expect(availableCategories([partial])).toEqual([]);
  });
});
