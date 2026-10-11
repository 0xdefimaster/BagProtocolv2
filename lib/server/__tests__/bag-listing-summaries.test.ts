import { describe, expect, it } from 'vitest';
import { getNavSummaries } from '../bag-nav-snapshots';
import { getBagSocialCounts } from '../bag-social-counts';
import { bagReturns, formatReturn } from '@/lib/format';

describe('getNavSummaries', () => {
  it('maps the RPC rows to TVL and returns; Bags without a snapshot are left out', async () => {
    const admin = {
      rpc: async (name: string, args: { p_bag_ids: string[] }) => {
        expect(name).toBe('bag_nav_summaries');
        expect(args.p_bag_ids).toEqual(['a', 'b']);
        return {
          data: [
            { bag_id: 'a', latest_at: '2026-10-01T00:00:00Z', gross_nav: '1.48', nav_per_share: '1.10', nav_per_share_7d: '1.00', nav_per_share_30d: null, nav_per_share_ytd: '1.21' },
            { bag_id: 'b', latest_at: null, gross_nav: null, nav_per_share: null, nav_per_share_7d: null, nav_per_share_30d: null, nav_per_share_ytd: null },
          ],
          error: null,
        };
      },
    } as never;
    const out = await getNavSummaries(admin, ['a', 'b']);
    expect(out.has('b')).toBe(false);
    const a = out.get('a')!;
    expect(a.tvl).toBe(1.48);
    expect(a.performance['7D']).toBeCloseTo(10, 9);
    expect(a.performance['30D']).toBeNull();
    expect(a.performance.YTD).toBeCloseTo(((1.1 - 1.21) / 1.21) * 100, 9);
  });
});

describe('getBagSocialCounts', () => {
  it('counts child Bags as forks, and wallets that still hold some of the Bag as holders (once each)', async () => {
    const admin = {
      from: (table: string) => ({
        select: () => ({
          in: (_col: string, ids: string[]) => {
            expect(ids).toEqual(['a', 'b']);
            if (table === 'bags') return Promise.resolve({ data: [{ parent_bag_id: 'a' }, { parent_bag_id: 'a' }], error: null });
            expect(table).toBe('bag_investor_holdings');
            return Promise.resolve({
              data: [
                // u1 holds two assets of a: one holder.
                { bag_id: 'a', user_id: 'u1', quantity_raw: '5' },
                { bag_id: 'a', user_id: 'u1', quantity_raw: '7' },
                // u2 moved everything out (reconciled to 0): not a holder.
                { bag_id: 'a', user_id: 'u2', quantity_raw: '0' },
                { bag_id: 'b', user_id: 'u1', quantity_raw: '1' },
                { bag_id: 'b', user_id: 'u3', quantity_raw: '100000000000000000000000' },
                { bag_id: 'b', user_id: 'u4', quantity_raw: 'garbage' },
              ],
              error: null,
            });
          },
        }),
      }),
    } as never;
    const out = await getBagSocialCounts(admin, ['a', 'b']);
    expect(out.get('a')).toEqual({ forks: 2, holders: 1 });
    expect(out.get('b')).toEqual({ forks: 0, holders: 2 });
  });
});

describe('bagReturns', () => {
  it('uses recorded history when present, demo figures otherwise, and no made-up zeros for a live Bag', () => {
    const base = { performance7d: 0, performance30d: 0, performanceYtd: 0 };
    expect(bagReturns({ ...base, performanceRecorded: { '7D': 1.5, '30D': null, YTD: -2 } })).toEqual({ d7: 1.5, d30: null, ytd: -2 });
    expect(bagReturns({ performance7d: 3, performance30d: 4, performanceYtd: 5 })).toEqual({ d7: 3, d30: 4, ytd: 5 });
    expect(bagReturns(base)).toEqual({ d7: null, d30: null, ytd: null });
    expect(formatReturn(null)).toBe('—');
    expect(formatReturn(1.234)).toBe('+1.2%');
    expect(formatReturn(-0.44)).toBe('-0.4%');
  });
});

describe('display price provider', () => {
  it('keeps the money-path spread limit strict and only widens it for display', async () => {
    const { DISPLAY_MAX_SPREAD_BPS } = await import('@/lib/server/price-provider');
    const { DEFAULT_MAX_SPREAD_BPS } = await import('@/lib/domain/basket-protocol/pricing/robinhood-stock-api');
    expect(DEFAULT_MAX_SPREAD_BPS).toBe(500);
    // An overnight stock-token spread like 821 bps must not blank a Bag's TVL…
    expect(DISPLAY_MAX_SPREAD_BPS).toBeGreaterThan(821);
    // …but display stays bounded.
    expect(DISPLAY_MAX_SPREAD_BPS).toBeLessThanOrEqual(2500);
  });
});
