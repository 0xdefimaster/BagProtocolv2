import { describe, expect, it, vi } from 'vitest';
import { CanonicalAsset } from '@/types/basket-protocol';
import {
  computeAllowlistDrift,
  getCanonicalInputTokensForChain,
  getSettlementTokenForChain,
  mergeCanonicalInputTokens,
} from '../canonical-input-tokens';

function asset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'asset_1',
    chain: 'robinhood',
    address: '0x1111111111111111111111111111111111aaaa',
    symbol: 'NVDA',
    decimals: 18,
    name: 'NVIDIA',
    status: 'VERIFIED',
    assetType: 'stock',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as CanonicalAsset;
}

describe('getSettlementTokenForChain', () => {
  it('returns the fixed USDG settlement token for robinhood, and nothing for any other chain', () => {
    const robinhood = getSettlementTokenForChain('robinhood');
    expect(robinhood).toEqual({
      chain: 'robinhood',
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      symbol: 'USDG',
      purpose: 'settlement',
    });

    expect(getSettlementTokenForChain('ethereum')).toBeNull();
    expect(getSettlementTokenForChain('base')).toBeNull();
    expect(getSettlementTokenForChain('arbitrum')).toBeNull();
  });
});

describe('mergeCanonicalInputTokens', () => {
  it('includes the settlement token plus every registry asset, tagged with the right purpose', () => {
    const settlement = getSettlementTokenForChain('robinhood')!;
    const registryAssets = [asset({ address: '0xnvda', symbol: 'NVDA' }), asset({ address: '0xaapl', symbol: 'xAAPL' })];

    const merged = mergeCanonicalInputTokens(settlement, registryAssets);

    expect(merged).toEqual([
      { chain: 'robinhood', address: settlement.address, symbol: 'USDG', purpose: 'settlement' },
      { chain: 'robinhood', address: '0xnvda', symbol: 'NVDA', purpose: 'registry-asset' },
      { chain: 'robinhood', address: '0xaapl', symbol: 'xAAPL', purpose: 'registry-asset' },
    ]);
  });

  it('deduplicates by (chain, address) case-insensitively — never by symbol alone', () => {
    const registryAssets = [
      asset({ address: '0xAAAA000000000000000000000000000000aaaa', symbol: 'DUP' }),
      asset({ address: '0xaaaa000000000000000000000000000000aaaa', symbol: 'DUP-AGAIN-SAME-ADDRESS' }),
    ];

    const merged = mergeCanonicalInputTokens(null, registryAssets);

    expect(merged).toHaveLength(1);
    expect(merged[0].symbol).toBe('DUP'); // first occurrence wins
  });

  it('the settlement token wins a collision against a registry row at the same address (kept first, never duplicated)', () => {
    const settlement = getSettlementTokenForChain('robinhood')!;
    const registryAssets = [asset({ address: settlement.address.toLowerCase(), symbol: 'IMPOSTOR' })];

    const merged = mergeCanonicalInputTokens(settlement, registryAssets);

    expect(merged).toHaveLength(1);
    expect(merged[0].purpose).toBe('settlement');
    expect(merged[0].symbol).toBe('USDG');
  });

  it('a chain with no settlement token configured (e.g. ethereum) still returns every registry asset', () => {
    const registryAssets = [asset({ chain: 'ethereum', address: '0xweth', symbol: 'WETH' })];

    const merged = mergeCanonicalInputTokens(getSettlementTokenForChain('ethereum'), registryAssets);

    expect(merged).toEqual([{ chain: 'ethereum', address: '0xweth', symbol: 'WETH', purpose: 'registry-asset' }]);
  });

  it('an empty registry and no settlement token returns an empty list, never throws', () => {
    expect(mergeCanonicalInputTokens(null, [])).toEqual([]);
  });
});

describe('getCanonicalInputTokensForChain', () => {
  it('queries the registry scoped to the requested chain and VERIFIED-only by default (never DEPRECATED, never another chain)', async () => {
    const listAssetsMock = vi.fn().mockResolvedValue([asset({ chain: 'robinhood', address: '0xnvda' })]);
    const admin = { from: vi.fn() } as never;
    vi.doMock('../asset-repo', () => ({ listAssets: listAssetsMock }));

    // Re-import with the mock in place for this one test — see the
    // module-scoped `vi.mock` alternative below for the other tests, kept
    // separate here since this test cares specifically about the exact
    // query arguments passed through.
    vi.resetModules();
    const mod = await import('../canonical-input-tokens');
    const result = await mod.getCanonicalInputTokensForChain(admin, 'robinhood');

    expect(listAssetsMock).toHaveBeenCalledWith(admin, { chain: 'robinhood', status: ['VERIFIED'], limit: 1000 });
    expect(result).toEqual([
      { chain: 'robinhood', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', purpose: 'settlement' },
      { chain: 'robinhood', address: '0xnvda', symbol: 'NVDA', purpose: 'registry-asset' },
    ]);

    vi.doUnmock('../asset-repo');
    vi.resetModules();
  });

  it('includes DEPRECATED assets too when includeDeprecated is set — a redemption-side caller must still see an asset a Bag might currently hold even after it stops being VERIFIED for new purchases', async () => {
    const listAssetsMock = vi.fn().mockResolvedValue([asset({ chain: 'robinhood', address: '0xold', symbol: 'OLD', status: 'DEPRECATED' })]);
    vi.doMock('../asset-repo', () => ({ listAssets: listAssetsMock }));
    vi.resetModules();
    const mod = await import('../canonical-input-tokens');
    const admin = {} as never;

    const result = await mod.getCanonicalInputTokensForChain(admin, 'robinhood', { includeDeprecated: true });

    expect(listAssetsMock).toHaveBeenCalledWith(admin, { chain: 'robinhood', status: ['VERIFIED', 'DEPRECATED'], limit: 1000 });
    expect(result.some((t) => t.symbol === 'OLD')).toBe(true);

    vi.doUnmock('../asset-repo');
    vi.resetModules();
  });
});

describe('computeAllowlistDrift', () => {
  const settlement = getSettlementTokenForChain('robinhood')!;
  const canonical = [
    settlement,
    { chain: 'robinhood' as const, address: '0xnvda', symbol: 'NVDA', purpose: 'registry-asset' as const },
    { chain: 'robinhood' as const, address: '0xaapl', symbol: 'xAAPL', purpose: 'registry-asset' as const },
  ];

  it('reports nothing missing and nothing extra when on-chain state exactly matches canonical', () => {
    const onChain = new Set([settlement.address, '0xnvda', '0xaapl']);

    const drift = computeAllowlistDrift(canonical, onChain);

    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual([]);
  });

  it('reports a canonical token as MISSING when the chain has never allowlisted it — the dangerous direction that breaks real purchases/redemptions', () => {
    const onChain = new Set([settlement.address, '0xnvda']); // xAAPL never allowlisted on-chain

    const drift = computeAllowlistDrift(canonical, onChain);

    expect(drift.missing).toEqual([{ chain: 'robinhood', address: '0xaapl', symbol: 'xAAPL', purpose: 'registry-asset' }]);
    expect(drift.extra).toEqual([]);
  });

  it('reports an on-chain-allowed address the canonical list does not name as EXTRA — never silently dropped, never auto-removed', () => {
    const onChain = new Set([settlement.address, '0xnvda', '0xaapl', '0xdeprecatedstranger']);

    const drift = computeAllowlistDrift(canonical, onChain);

    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual(['0xdeprecatedstranger']);
  });

  it('is case-insensitive when comparing addresses — a checksummed on-chain read and a lowercase Supabase-stored address are the same token', () => {
    const onChain = new Set([settlement.address.toLowerCase(), '0xNVDA']);
    const mixedCaseCanonical = [
      settlement,
      { chain: 'robinhood' as const, address: '0xnvda', symbol: 'NVDA', purpose: 'registry-asset' as const },
    ];

    const drift = computeAllowlistDrift(mixedCaseCanonical, onChain);

    expect(drift.missing).toEqual([]);
  });

  it('both missing and extra can be reported together in the same run', () => {
    const onChain = new Set([settlement.address, '0xnvda', '0xoldstranger']); // xAAPL missing, oldstranger extra

    const drift = computeAllowlistDrift(canonical, onChain);

    expect(drift.missing).toEqual([{ chain: 'robinhood', address: '0xaapl', symbol: 'xAAPL', purpose: 'registry-asset' }]);
    expect(drift.extra).toEqual(['0xoldstranger']);
  });

  it('an empty on-chain set reports every canonical token as missing', () => {
    const drift = computeAllowlistDrift(canonical, new Set());
    expect(drift.missing).toHaveLength(3);
    expect(drift.extra).toEqual([]);
  });
});

