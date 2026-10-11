import { describe, expect, it } from 'vitest';
import type { Bag } from '@/types';
import { rankBags, rankCreators } from '../rank';

const bag = (id: string, o: Partial<Bag> & { creatorAddress?: string; d30?: number | null }): Bag =>
  ({
    id,
    name: id,
    tvl: 0,
    forks: 0,
    followers: 0,
    performance7d: 0,
    performance30d: 0,
    performanceYtd: 0,
    chains: ['robinhood'],
    composition: [],
    creator: { name: o.creatorAddress ?? 'c', avatar: '', address: o.creatorAddress ?? '0xc', followers: 0, forks: 0 },
    performanceRecorded: { '7D': null, '30D': o.d30 ?? null, YTD: null },
    ...o,
  }) as unknown as Bag;

describe('leaderboard rankings', () => {
  it('ranks Bags by TVL, ties by name', () => {
    const r = rankBags([bag('b', { tvl: 5 }), bag('a', { tvl: 5 }), bag('c', { tvl: 9 })], 'tvl');
    expect(r.map((x) => [x.rank, x.bag.id])).toEqual([
      [1, 'c'],
      [2, 'a'],
      [3, 'b'],
    ]);
  });

  it('leaves Bags without a recorded return out of the return ranking, never as zero', () => {
    const r = rankBags([bag('up', { d30: 4.2 }), bag('none', { d30: null }), bag('down', { d30: -1 })], 'return30d');
    expect(r.map((x) => [x.bag.id, x.value])).toEqual([
      ['up', 4.2],
      ['down', -1],
    ]);
  });

  it('ranks holders and forks; a Bag without a holder count is left out', () => {
    expect(rankBags([bag('x', { holders: 3 }), bag('y', {})], 'holders').map((x) => x.bag.id)).toEqual(['x']);
    expect(rankBags([bag('x', { forks: 1 }), bag('y', { forks: 4 })], 'forks').map((x) => x.bag.id)).toEqual(['y', 'x']);
  });

  it('aggregates creators across their Bags (address case-insensitive) and ranks them by TVL', () => {
    const r = rankCreators([
      bag('a1', { creatorAddress: '0xAA', tvl: 10, holders: 2, forks: 1, d30: 3 }),
      bag('a2', { creatorAddress: '0xaa', tvl: 5, holders: 1, d30: 7 }),
      bag('b1', { creatorAddress: '0xbb', tvl: 12, holders: 9 }),
    ]);
    expect(r).toEqual([
      expect.objectContaining({ rank: 1, address: '0xAA', bags: 2, tvl: 15, holders: 3, forks: 1, best30d: 7 }),
      expect.objectContaining({ rank: 2, address: '0xbb', bags: 1, tvl: 12, holders: 9, best30d: null }),
    ]);
  });
});
