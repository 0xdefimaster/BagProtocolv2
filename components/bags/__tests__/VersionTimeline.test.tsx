// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VersionTimeline } from '../VersionTimeline';
import { diffRecipes } from '@/lib/domain/basket-protocol/strategy-diff';
import type { RecipeAsset } from '@/types/basket-protocol';

const asset = (symbol: string, n: number, weightBps: number): RecipeAsset => ({ chain: 'robinhood', address: `0x${String(n).padStart(40, '0')}`, symbol, decimals: 18, weightBps });
const v1 = [asset('NVDA', 1, 3000), asset('AMD', 2, 2000), asset('BTC', 3, 5000)];
const v2 = [asset('NVDA', 1, 2500), asset('AMD', 2, 2500), asset('BTC', 3, 5000)];

const versions = [
  {
    versionId: 'b', version: 2, createdAt: '2026-09-08T00:00:00Z', reason: 'Reduced single-asset concentration', compositionHash: 'h2',
    createdBy: { id: 'u', name: 'Alice', address: '0xalice' }, isCurrent: true, assets: v2,
    diff: diffRecipes({ assets: v1, performanceFeeBps: 1000 }, { assets: v2, performanceFeeBps: 1500 }),
    performance: { fromAt: '2026-09-08T00:00:00Z', toAt: '2026-09-20T00:00:00Z', fromNavPerShare: '1.1', toNavPerShare: '1.21', returnPct: 10 },
  },
  {
    versionId: 'a', version: 1, createdAt: '2026-09-01T00:00:00Z', reason: '', compositionHash: 'h1',
    createdBy: { id: 'u', name: null, address: '0x1234567890abcdef1234567890abcdef12345678' }, isCurrent: false, assets: v1,
    diff: diffRecipes(null, { assets: v1 }), performance: null,
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VersionTimeline', () => {
  it('shows versions newest first with reason, author, weight changes, setting changes and live-period performance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ versions }) })));
    render(<VersionTimeline bagId="bag-1" />);

    await screen.findByText('v2');
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('“Reduced single-asset concentration”')).toBeTruthy();
    expect(screen.getByText('by Alice')).toBeTruthy();
    expect(screen.getByText('30% → 25%')).toBeTruthy();
    expect(screen.getByText('−5%')).toBeTruthy();
    expect(screen.getByText('+10.00% since this version')).toBeTruthy();
    expect(screen.getByText(/Performance fee/)).toBeTruthy();

    // Unchanged assets are hidden until asked for.
    expect(screen.queryByText('50% → 50%')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show unchanged (1)' }));
    expect(screen.getByText('50% → 50%')).toBeTruthy();

    // First version: initial composition, no reason, author falls back to address.
    expect(screen.getByText('Initial composition')).toBeTruthy();
    expect(screen.getByText('No reason given.')).toBeTruthy();
    expect(screen.getByText('by 0x1234…5678')).toBeTruthy();
  });

  it('shows the API error instead of an empty history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Bag not found.' }) })));
    render(<VersionTimeline bagId="missing" />);
    await screen.findByText(/Could not load the version history: Bag not found\./);
  });
});
