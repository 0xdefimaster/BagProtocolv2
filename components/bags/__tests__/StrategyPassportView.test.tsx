// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { StrategyPassportView } from '../StrategyPassportView';
import type { StrategyPassport } from '@/types/strategy-passport';
import type { Enforcement, StrategyPolicy } from '@/types/strategy-policy';

const src = (source: 'ONCHAIN' | 'DATABASE' | 'BAG_DERIVED' | 'BAG_ATTESTED', verifiableBy: 'TX_HASH' | 'NONE' = 'NONE') => ({ source, asOf: '2026-10-01T00:00:00Z', verifiableBy, readFromChainThisRequest: false });
const rule = <T,>(value: T, enforcement: Enforcement, extra: object = {}) => ({ value, source: 'CREATOR_RECIPE' as const, enforcement, enforcedAt: [], status: 'ACTIVE' as const, ...extra });

const policy: StrategyPolicy = {
  schemaVersion: 1,
  maxSingleAssetWeightBps: rule(3000, 'SERVER_ENFORCED'),
  minSingleAssetWeightBps: rule(100, 'SERVER_ENFORCED'),
  maxAssets: rule(10, 'SERVER_ENFORCED'),
  minInvestmentUsd: rule(0, 'SERVER_ENFORCED'),
  maxSlippageBps: rule(100, 'ONCHAIN_ENFORCED'),
  maxPriceImpactBps: { ...rule(500, 'COMPOSER_ENFORCED'), source: 'LIFI_COMPOSER', consentCeilingBps: 1500 },
  performanceFeeBps: { ...rule(1000, 'DATABASE_TRIGGER'), maxBps: 3000 },
  noRouteAssetPolicy: { ...rule('BLOCK' as const, 'SERVER_ENFORCED'), maxUnroutableWeightBps: 3000 },
  rebalanceRule: { ...rule({ frequency: 'MONTHLY' as const, driftThresholdBps: 500 }, 'DECLARED_ONLY'), status: 'NOT_EXECUTED' },
  compositionChanges: rule('ONCHAIN_VERSION_ONLY' as const, 'DATABASE_TRIGGER'),
};

const passport: StrategyPassport = {
  schemaVersion: 1,
  generatedAt: '2026-10-03T00:00:00Z',
  identity: { sourceInfo: src('DATABASE'), bagId: 'bag-2', slug: 'ai', name: 'AI Infrastructure', symbol: 'AINF', description: '', chain: 'robinhood', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE', status: 'ACTIVE', createdAt: '2026-09-01T00:00:00Z' },
  onchain: {
    sourceInfo: src('ONCHAIN', 'TX_HASH'), chain: 'robinhood', chainId: 4663, onChainBagId: '0x' + '33'.repeat(32), onChainCreator: '0xalice', contractAddress: '0xcontract',
    factoryAddress: '0xfactory', deploymentTxHash: '0x' + '22'.repeat(32), deploymentBlock: 123, onChainVersion: 2, explorerUrl: 'https://robinhoodchain.blockscout.com/tx/0x22',
  },
  creator: { sourceInfo: src('DATABASE'), name: 'Alice', walletAddress: '0xalice', avatarUrl: null },
  currentVersion: { sourceInfo: src('DATABASE'), version: 2, createdAt: '2026-09-08T00:00:00Z', reason: 'Lower NVDA', onchainCompositionHash: null },
  composition: { sourceInfo: src('DATABASE'), totalWeightBps: 10000, assets: [{ chain: 'robinhood', address: '0xa1', symbol: 'NVDA', name: 'NVIDIA', assetType: 'stock', decimals: 18, weightBps: 10000, routeStatus: 'ROUTABLE', routeCheckedAt: null }] },
  performance: { sourceInfo: src('BAG_DERIVED'), tvlUsd: '100', navPerShare: '1.02', returns: null, holders: 2 },
  policy,
  lineage: {
    versions: {
      sourceInfo: src('DATABASE'),
      nodes: [
        { version: 1, parentVersion: null, createdAt: '2026-09-01T00:00:00Z', reason: 'Initial creation', isCurrent: false, onchain: null },
        { version: 2, parentVersion: 1, createdAt: '2026-09-08T00:00:00Z', reason: 'Lower NVDA', isCurrent: true, onchain: { txHash: '0x1', onchainVersion: 2, compositionHash: '0xab', metadataUri: null, sourceInfo: src('ONCHAIN', 'TX_HASH') } },
      ],
    },
    forks: {
      sourceInfo: src('DATABASE'),
      ancestors: [{ bagId: 'bag-1', visible: true, name: 'AI Core', symbol: 'AIC', status: 'ACTIVE', creator: { name: 'Bob', walletAddress: '0xbob', avatarUrl: null }, createdAt: null }],
      rootBagId: 'bag-1',
      isOriginal: false,
      children: [{ bagId: 'f1', visible: true, name: 'AI Momentum', symbol: 'AIM', status: 'ACTIVE', creator: null, createdAt: null }],
      childCount: 3,
      forkRoyaltyBps: 150,
      forkedFromVersion: null,
    },
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StrategyPassportView', () => {
  it('renders each section with its source, on-chain records as cached, and rules grouped by on-chain guarantee vs off-chain enforcement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ passport }) })));
    render(<StrategyPassportView bagId="bag-2" />);

    await screen.findByText('Current version · v2');
    // On-chain data is labelled as BAG's record of a confirmed tx — never as re-verified now.
    expect(screen.getByText('On-chain record · cached')).toBeTruthy();
    expect(screen.getByText(/it was not re-read from the chain for this page/)).toBeTruthy();
    expect(screen.queryByText(/on-chain verified/i)).toBeNull();
    expect(screen.getAllByText('BAG database').length).toBeGreaterThan(0);
    expect(screen.getByText('BAG derived')).toBeTruthy();

    // Only the slippage rule is in the on-chain guaranteed group.
    const guaranteed = screen.getByText('On-chain guaranteed', { selector: 'p' }).parentElement!;
    expect(within(guaranteed).getByText('Max slippage per swap')).toBeTruthy();
    expect(within(guaranteed).queryByText('Max single asset')).toBeNull();
    const offchain = screen.getByText('Enforced off-chain, attested or declared').parentElement!;
    expect(within(offchain).getByText('Max single asset')).toBeTruthy();
    expect(within(offchain).getAllByText('BAG validated').length).toBeGreaterThan(0);
    expect(within(offchain).getByText('LI.FI Composer enforced')).toBeTruthy();
    expect(within(offchain).getAllByText('Database enforced').length).toBe(2);
    expect(within(offchain).getByText('Declared only')).toBeTruthy();
    expect(within(offchain).queryByText('On-chain guaranteed')).toBeNull();

    expect(screen.getByText('Version lineage')).toBeTruthy();
    expect(screen.getByText('on-chain record v2')).toBeTruthy();
    expect(screen.getByText('Fork lineage')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AI Core' }).getAttribute('href')).toBe('/dashboard/bag/bag-1');
    expect(screen.getByText('AI Infrastructure (this Bag)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AI Momentum' })).toBeTruthy();
    expect(screen.getByText('3 direct forks (2 not public).')).toBeTruthy();
    expect(screen.getByText('Which parent version was copied is not recorded.')).toBeTruthy();
  });

  it('copies the exact passport JSON', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ passport }) })));
    render(<StrategyPassportView bagId="bag-2" />);
    await screen.findByText('Current version · v2');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Copy passport JSON/ }));
    });
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(passport);
  });

  it('shows the API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Bag not found.' }) })));
    render(<StrategyPassportView bagId="x" />);
    await screen.findByText('Could not load the Strategy Passport: Bag not found.');
  });
});
