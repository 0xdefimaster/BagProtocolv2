// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { StrategyPassportView } from '../StrategyPassportView';
import type { StrategyPassport } from '@/types/strategy-passport';

const passport: StrategyPassport = {
  schemaVersion: 1,
  generatedAt: '2026-10-03T00:00:00Z',
  identity: { provenance: 'DATABASE', bagId: 'bag-2', slug: 'ai', name: 'AI Infrastructure', symbol: 'AINF', description: '', chain: 'robinhood', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE', status: 'ACTIVE', createdAt: '2026-09-01T00:00:00Z' },
  onchain: null,
  creator: { provenance: 'DATABASE', userId: 'alice', name: 'Alice', walletAddress: '0xalice', avatarUrl: null },
  currentVersion: { provenance: 'DATABASE', versionId: 'v2', version: 2, createdAt: '2026-09-08T00:00:00Z', reason: 'Lower NVDA', compositionHash: 'h2', onchainCompositionHash: null },
  composition: { provenance: 'DATABASE', totalWeightBps: 10000, assets: [{ chain: 'robinhood', address: '0xa1', symbol: 'NVDA', name: 'NVIDIA', assetType: 'stock', decimals: 18, weightBps: 10000, routeStatus: 'ROUTABLE', routeCheckedAt: null }] },
  performance: { provenance: 'BAG_COMPUTED', tvlUsd: '100', navPerShare: '1.02', navAsOf: null, returns: null, holders: 2 },
  policy: {
    rules: [
      { key: 'max_slippage_per_swap', label: 'Max slippage per swap', value: 100, display: '1%', enforcement: 'ONCHAIN' },
      { key: 'max_weight_per_asset', label: 'Max weight per asset', value: 7000, display: '70%', enforcement: 'BAG_SERVER' },
      { key: 'rebalance', label: 'Rebalance rule', value: 'MONTHLY', display: 'MONTHLY', enforcement: 'DECLARED', note: 'No automatic rebalancing runs today.' },
    ],
  },
  lineage: {
    versions: {
      provenance: 'DATABASE',
      nodes: [
        { versionId: 'v1', version: 1, parentVersion: null, createdAt: '2026-09-01T00:00:00Z', reason: 'Initial creation', compositionHash: 'h1', isCurrent: false, onchain: null },
        { versionId: 'v2', version: 2, parentVersion: 1, createdAt: '2026-09-08T00:00:00Z', reason: 'Lower NVDA', compositionHash: 'h2', isCurrent: true, onchain: { txHash: '0x1', onchainVersion: 2, compositionHash: '0xab', metadataUri: null } },
      ],
    },
    forks: {
      provenance: 'DATABASE',
      ancestors: [{ bagId: 'bag-1', visible: true, name: 'AI Core', symbol: 'AIC', status: 'ACTIVE', creator: { userId: 'bob', name: 'Bob', walletAddress: '0xbob', avatarUrl: null }, createdAt: null }],
      rootBagId: 'bag-1',
      isOriginal: false,
      children: [{ bagId: 'f1', visible: true, name: 'AI Momentum', symbol: 'AIM', status: 'ACTIVE', creator: null, createdAt: null }],
      childCount: 3,
      forkRoyaltyBps: 150,
      forkedFromVersion: null,
    },
  },
  provenance: {},
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StrategyPassportView', () => {
  it('renders sections with provenance, rules with enforcement, and version vs fork lineage separately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ passport }) })));
    render(<StrategyPassportView bagId="bag-2" />);

    await screen.findByText('Current version · v2');
    expect(screen.getByText('Not deployed on-chain yet.')).toBeTruthy();
    expect(screen.getAllByText('BAG database').length).toBeGreaterThan(0);
    expect(screen.getByText('BAG computed')).toBeTruthy();

    expect(screen.getByText('On-chain enforced')).toBeTruthy();
    expect(screen.getByText('BAG validated')).toBeTruthy();
    expect(screen.getByText('Declared only')).toBeTruthy();
    expect(screen.getByText('No automatic rebalancing runs today.')).toBeTruthy();

    expect(screen.getByText('Version lineage')).toBeTruthy();
    expect(screen.getByText('on-chain v2')).toBeTruthy();
    expect(screen.getByText('Fork lineage')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AI Core' }).getAttribute('href')).toBe('/dashboard/bag/bag-1');
    expect(screen.getByText('AI Infrastructure (this Bag)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AI Momentum' })).toBeTruthy();
    expect(screen.getByText('3 direct forks (2 not public).')).toBeTruthy();
    expect(screen.getByText('Forks pay the root creator 1.5% of every deposit.')).toBeTruthy();
  });

  it('shows the API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Bag not found.' }) })));
    render(<StrategyPassportView bagId="x" />);
    await screen.findByText('Could not load the Strategy Passport: Bag not found.');
  });
});
