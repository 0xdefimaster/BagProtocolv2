import { describe, expect, it, vi } from 'vitest';
import { CanonicalAsset } from '@/types/basket-protocol';
import { applyLogoUpdates, planLogoUpdates, sanitizeLogoUrl } from '../logo-url';

function asset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'a1',
    chain: 'robinhood',
    address: '0xabc',
    symbol: 'AAPL',
    decimals: 18,
    name: 'Apple • Robinhood Token',
    status: 'VERIFIED',
    assetType: 'stock',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('sanitizeLogoUrl', () => {
  it('keeps an https URL as-is', () => {
    const url = 'https://cdn.robinhood.com/ncw_assets/logos/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9.png';
    expect(sanitizeLogoUrl(url)).toBe(url);
  });

  it('drops anything that is not a bounded https URL — never rewrites it', () => {
    for (const bad of ['http://x.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'not a url', '', '   ', 42, null, undefined, `https://x.com/${'a'.repeat(2100)}`]) {
      expect(sanitizeLogoUrl(bad)).toBeUndefined();
    }
  });
});

describe('planLogoUpdates / applyLogoUpdates', () => {
  it('only plans assets whose source logo is present and different', () => {
    const same = asset({ id: 's', address: '0x1', logoUrl: 'https://l/1.png' });
    const changed = asset({ id: 'c', address: '0x2', logoUrl: 'https://l/old.png' });
    const missing = asset({ id: 'm', address: '0x3' });
    const noRemote = asset({ id: 'n', address: '0x4' });
    const remote = new Map([
      ['0x1', 'https://l/1.png'],
      ['0x2', 'https://l/new.png'],
      ['0x3', 'https://l/3.png'],
      ['0x4', undefined],
    ]);

    const updates = planLogoUpdates([same, changed, missing, noRemote], remote, (a) => a.address);

    expect(updates).toEqual([
      { asset: changed, logoUrl: 'https://l/new.png' },
      { asset: missing, logoUrl: 'https://l/3.png' },
    ]);
  });

  it('reports failures without aborting the rest', async () => {
    const a = asset({ id: 'a' });
    const b = asset({ id: 'b' });
    const updateFn = vi.fn().mockResolvedValueOnce(a).mockRejectedValueOnce(new Error('db down'));

    const result = await applyLogoUpdates(updateFn, [
      { asset: a, logoUrl: 'https://l/a.png' },
      { asset: b, logoUrl: 'https://l/b.png' },
    ]);

    expect(result.updated).toEqual([a]);
    expect(result.failed).toEqual([{ update: { asset: b, logoUrl: 'https://l/b.png' }, error: 'db down' }]);
  });
});
