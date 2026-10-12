import { describe, expect, it } from 'vitest';
import { buildVersionTimeline, versionPerformance } from '../bag-version-timeline';
import { BagVersionRecord, BasketRecipe, RecipeAsset } from '@/types/basket-protocol';
import type { CreatorProfile, NavSnapshotPoint } from '@/types';

const NVDA = '0x00000000000000000000000000000000000000a1';
const AMD = '0x00000000000000000000000000000000000000a2';
const asset = (symbol: string, address: string, weightBps: number): RecipeAsset => ({ chain: 'robinhood', address, symbol, decimals: 18, weightBps });

function version(n: number, createdAt: string, assets: RecipeAsset[], reason = ''): BagVersionRecord {
  return {
    id: `v${n}`,
    bagId: 'bag',
    version: n,
    compositionHash: `h${n}`,
    recipe: { assets, performanceFeeBps: 0 } as unknown as BasketRecipe,
    createdBy: 'alice',
    reason,
    createdAt,
  };
}

const snap = (capturedAt: string, priceIndex: string): NavSnapshotPoint => ({ capturedAt, grossNav: '0', navPerShare: null, priceIndex });

const snapshots = [
  snap('2026-09-01T00:00:00Z', '1.00'),
  snap('2026-09-05T00:00:00Z', '1.10'),
  snap('2026-09-10T00:00:00Z', '1.21'),
  snap('2026-09-20T00:00:00Z', '1.331'),
];

describe('versionPerformance', () => {
  it('measures the price index from the first snapshot in the live period to the last one before the next version', () => {
    const p = versionPerformance(snapshots, '2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z');
    expect(p).toMatchObject({ fromIndex: '1.00', toIndex: '1.10' });
    expect(p!.returnPct).toBeCloseTo(10, 6);
  });

  it('runs to the latest snapshot for the live version', () => {
    expect(versionPerformance(snapshots, '2026-09-08T00:00:00Z', null)!.returnPct).toBeCloseTo(10, 6);
  });

  it('is null when no snapshot covers the period — never estimated', () => {
    expect(versionPerformance(snapshots, '2026-09-25T00:00:00Z', null)).toBeNull();
    expect(versionPerformance([], '2026-09-01T00:00:00Z', null)).toBeNull();
    expect(versionPerformance(snapshots, '2026-09-02T00:00:00Z', '2026-09-04T00:00:00Z')).toBeNull();
  });
});

describe('buildVersionTimeline', () => {
  it('newest first, each with author, reason, diff from the previous version and its live-period performance', () => {
    const versions = [
      version(2, '2026-09-08T00:00:00Z', [asset('NVDA', NVDA, 5000), asset('AMD', AMD, 5000)], 'Reduced single-asset concentration'),
      version(1, '2026-09-01T00:00:00Z', [asset('NVDA', NVDA, 10000)], 'Initial creation'),
    ];
    const creators = new Map<string, CreatorProfile>([['alice', { id: 'alice', name: 'Alice', avatar: '', address: '0xalice', followers: 0 } as CreatorProfile]]);
    const t = buildVersionTimeline(versions, 'v2', snapshots, creators);

    expect(t.map((e) => e.version)).toEqual([2, 1]);
    expect(t[0]).toMatchObject({ isCurrent: true, reason: 'Reduced single-asset concentration', createdBy: { name: 'Alice', address: '0xalice' } });
    expect(t[0].diff.assets.find((a) => a.symbol === 'NVDA')).toMatchObject({ kind: 'REWEIGHTED', fromBps: 10000, toBps: 5000 });
    expect(t[0].diff.assets.find((a) => a.symbol === 'AMD')).toMatchObject({ kind: 'ADDED' });
    expect(t[1].isCurrent).toBe(false);
    expect(t[1].diff.assets.every((a) => a.kind === 'ADDED')).toBe(true);
    expect(t[1].performance!.returnPct).toBeCloseTo(10, 6);
    expect(t[0].performance!.returnPct).toBeCloseTo(10, 6);
  });

  it('an unknown author is shown without a name rather than failing', () => {
    const t = buildVersionTimeline([version(1, '2026-09-01T00:00:00Z', [asset('NVDA', NVDA, 10000)])], null, [], new Map());
    expect(t[0]).toMatchObject({ isCurrent: true, createdBy: { name: null, address: null }, performance: null });
  });
});
