import { describe, expect, it, vi } from 'vitest';
import { LiFiPriceProvider, LiFiTokenData, LiFiTokenUnavailableError, normalizeLiFiToken } from '../lifi-token-data';
import { PriceDataGapError, PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';

// LI.FI token lookups are scripted (no network). Shapes follow @lifi/types Token.

const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const token = (o: Record<string, unknown> = {}) => ({ chainId: 42161, address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: 'https://static.li.fi/weth.png', priceUSD: '2500.12', ...o });

describe('normalizeLiFiToken', () => {
  it('normalizes to BagCryptoAsset', () => {
    expect(normalizeLiFiToken(token(), { chainId: 42161, address: WETH.toLowerCase() })).toEqual({
      chainId: 42161, address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: 'https://static.li.fi/weth.png', priceUSD: '2500.12', priceSource: 'LIFI',
    });
  });
  it.each([
    ['priceUSD " 2500.10 "', ' 2500.10 ', '2500.10'],
    ['priceUSD "0"', '0', undefined],
    ['priceUSD number', 2500 as unknown, undefined],
    ['priceUSD exponent', '1e-7', undefined],
    ['priceUSD negative', '-1', undefined],
    ['priceUSD missing', undefined, undefined],
  ])('%s', (_l, priceUSD, expected) => {
    expect(normalizeLiFiToken(token({ priceUSD }), { chainId: 42161, address: WETH }).priceUSD).toBe(expected);
  });
  it.each([
    ['other chain', { chainId: 1 }],
    ['other address', { address: '0x0000000000000000000000000000000000000001' }],
    ['missing symbol', { symbol: '' }],
    ['bad decimals', { decimals: 18.5 }],
  ])('rejects %s', (_l, o) => {
    expect(() => normalizeLiFiToken(token(o), { chainId: 42161, address: WETH })).toThrow(LiFiTokenUnavailableError);
  });
  it('drops a non-https logo', () => {
    expect(normalizeLiFiToken(token({ logoURI: 'javascript:alert(1)' }), { chainId: 42161, address: WETH }).logoURI).toBeUndefined();
  });
});

describe('LiFiTokenData + LiFiPriceProvider', () => {
  const setup = (impl: (chainId: number, address: string) => Promise<unknown>) => {
    let t = 1_000_000;
    const fetchToken = vi.fn(impl);
    const data = new LiFiTokenData({ fetchToken, now: () => t });
    return { data, fetchToken, advance: (ms: number) => (t += ms), provider: new LiFiPriceProvider(data) };
  };
  const asset = { chain: 'arbitrum' as const, address: WETH };

  it('caches per token for 60 s and shares concurrent lookups (chain id mapped via lifi-config)', async () => {
    const s = setup(async () => token());
    await Promise.all([s.data.getToken('arbitrum', WETH), s.data.getToken('arbitrum', WETH.toLowerCase())]);
    s.advance(59_000);
    await s.provider.getPrice(asset);
    expect(s.fetchToken).toHaveBeenCalledTimes(1);
    expect(s.fetchToken).toHaveBeenCalledWith(42161, WETH);
    s.advance(2_000);
    await s.data.getToken('arbitrum', WETH);
    expect(s.fetchToken).toHaveBeenCalledTimes(2);
  });

  it('price: USD, stamped with fetch time, source lifi', async () => {
    const s = setup(async () => token());
    const p = await s.provider.getPrice(asset);
    expect(p).toMatchObject({ price: '2500.12', quoteCurrency: 'USD', source: 'lifi:token:42161', timestamp: new Date(1_000_000).toISOString() });
  });

  it('missing price → PriceDataGapError', async () => {
    await expect(setup(async () => token({ priceUSD: undefined })).provider.getPrice(asset)).rejects.toThrow(PriceDataGapError);
  });

  it('unavailable token (404/400) → PriceDataGapError, NOT_FOUND', async () => {
    const s = setup(async () => {
      throw Object.assign(new Error('Token not found'), { cause: { status: 404 } });
    });
    await expect(s.data.getToken('arbitrum', WETH)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    await expect(s.provider.getPrice(asset)).rejects.toThrow(PriceDataGapError);
  });

  it('outage (5xx / network) → plain PriceUnavailableError (no fallback allowed), not cached', async () => {
    let fail = true;
    const s = setup(async () => {
      if (fail) throw Object.assign(new Error('Internal'), { status: 500 });
      return token();
    });
    const err = await s.provider.getPrice(asset).catch((e) => e);
    expect(err).toBeInstanceOf(PriceUnavailableError);
    expect(err).not.toBeInstanceOf(PriceDataGapError);
    fail = false;
    await expect(s.provider.getPrice(asset)).resolves.toMatchObject({ price: '2500.12' });
  });

  it('prime() seeds the cache from a quote token; invalid objects are ignored', async () => {
    const s = setup(async () => token({ priceUSD: '1' }));
    s.data.prime(token({ priceUSD: '2600' }));
    s.data.prime({ chainId: 'x' });
    expect((await s.provider.getPrice(asset)).price).toBe('2600');
    expect(s.fetchToken).not.toHaveBeenCalled();
  });

  it('a token answered for a different chain than requested is rejected', async () => {
    const s = setup(async () => token());
    await expect(s.data.getToken('robinhood', WETH)).rejects.toMatchObject({ kind: 'INVALID' }); // asked 4663, got 42161
  });
});
