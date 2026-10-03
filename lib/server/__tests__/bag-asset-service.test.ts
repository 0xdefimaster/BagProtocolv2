import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AssetIdentity, AssetPrice, CanonicalAsset } from '@/types/basket-protocol';
import { BagAssetService } from '../bag-asset-service';
import { checkStockTokensForPurchase } from '../stock-token-guard';
import { LiFiTokenData } from '@/lib/blockchain/lifi-token-data';
import { PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { priceSourceOf } from '@/lib/domain/basket-protocol/assets/bag-asset';
import { AAPL, CRWD, harness, IMPOSTOR, NOW, quoteBody, UNTRADABLE } from '@/lib/domain/basket-protocol/pricing/__tests__/robinhood-harness';

// Unified normalizer, the /api/asset-prices route and the purchase-time
// Stock Token guard, with every provider scripted.

const WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const UNKNOWN_BASE = '0x9999999999999999999999999999999999999999';

function service(opts: { registryStatus?: number; lifiFails?: 'NOT_FOUND' | 'OUTAGE'; priceFails?: boolean } = {}) {
  const h = harness({ AAPL: quoteBody('AAPL', '213.45', '213.47'), CRWD: quoteBody('CRWD', '100', '100.1') }, { registryStatus: opts.registryStatus });
  const lifi = new LiFiTokenData({
    now: () => NOW,
    fetchToken: async (chainId, address) => {
      if (opts.lifiFails === 'OUTAGE') throw Object.assign(new Error('down'), { status: 502 });
      if (address.toLowerCase() !== WETH_ARB.toLowerCase() || opts.lifiFails) throw Object.assign(new Error('nf'), { cause: { status: 404 } });
      return { chainId, address, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, priceUSD: '2500.5', logoURI: 'https://static.li.fi/weth.png' };
    },
  });
  const prices = {
    getPrice: vi.fn(async (a: AssetIdentity): Promise<AssetPrice> => {
      if (opts.priceFails) throw new PriceUnavailableError(a);
      const source = a.chain === 'robinhood' && a.address.toLowerCase() === AAPL ? 'robinhood-api:prices:AAPL:mid×1' : 'lifi:token:42161';
      return { asset: a, price: '1.5', quoteCurrency: 'USD', timestamp: new Date(NOW).toISOString(), source };
    }),
  };
  const readErc20 = vi.fn(async () => ({ symbol: 'UNK', name: 'Unknown', decimals: 6 }));
  return { svc: new BagAssetService({ stockApi: h.api, lifi, prices, readErc20 }), prices, readErc20, api: h.api };
}

describe('BagAssetService (BAG normalizer)', () => {
  it('Stock Token → Robinhood metadata + bid/ask block, STOCK_TOKEN, ROBINHOOD_STOCK_API price', async () => {
    const r = await service().svc.resolve({ chain: 'robinhood', address: AAPL });
    expect(r.ok && r.asset).toMatchObject({
      id: `4663:${AAPL}`,
      chainId: 4663,
      symbol: 'AAPL',
      assetType: 'STOCK_TOKEN',
      metadataSource: 'ROBINHOOD',
      priceSource: 'ROBINHOOD_STOCK_API',
      priceKind: 'INDICATIVE',
      stock: { rawBid: '213.450000000000000000', currentMultiplier: '1.000566080061092436', isTradingHalt: false, fractionallyTradable: true },
    });
  });

  it('crypto on another chain → LI.FI metadata, CRYPTO, LIFI price', async () => {
    const r = await service().svc.resolve({ chain: 'arbitrum', address: WETH_ARB });
    expect(r.ok && r.asset).toMatchObject({ id: `42161:${WETH_ARB.toLowerCase()}`, chainId: 42161, symbol: 'WETH', decimals: 18, assetType: 'CRYPTO', metadataSource: 'LIFI', priceSource: 'LIFI' });
  });

  it('a token with a Stock Token ticker but unknown contract is CRYPTO, never the Stock Token', async () => {
    const r = await service().svc.resolve({ chain: 'robinhood', address: IMPOSTOR });
    expect(r.ok && r.asset.assetType).toBe('CRYPTO');
    expect(r.ok && r.asset.stock).toBeUndefined();
  });

  it('LI.FI does not know the token → ERC-20 metadata read on-chain (ONCHAIN)', async () => {
    const s = service();
    const r = await s.svc.resolve({ chain: 'base', address: UNKNOWN_BASE });
    expect(r.ok && r.asset).toMatchObject({ chainId: 8453, symbol: 'UNK', decimals: 6, metadataSource: 'ONCHAIN' });
    expect(s.readErc20).toHaveBeenCalledWith('base', UNKNOWN_BASE);
  });

  it('LI.FI outage → TOKEN_UNAVAILABLE (no on-chain guess on an outage)', async () => {
    const s = service({ lifiFails: 'OUTAGE' });
    expect(await s.svc.resolve({ chain: 'arbitrum', address: WETH_ARB })).toEqual({ ok: false, error: 'TOKEN_UNAVAILABLE' });
    expect(s.readErc20).not.toHaveBeenCalled();
  });

  it('price failure keeps the metadata, reports the reason, never a number', async () => {
    const r = await service({ priceFails: true }).svc.resolve({ chain: 'arbitrum', address: WETH_ARB });
    expect(r.ok && r.asset.priceUSD).toBeUndefined();
    expect(r.ok && r.asset.priceUnavailable).toBe('PriceUnavailableError');
  });

  it('registry down → STOCK_REGISTRY_UNAVAILABLE for Robinhood; unsupported chain rejected', async () => {
    expect(await service({ registryStatus: 503 }).svc.resolve({ chain: 'robinhood', address: AAPL })).toEqual({ ok: false, error: 'STOCK_REGISTRY_UNAVAILABLE' });
    expect(await service().svc.resolve({ chain: 'solana', address: AAPL })).toEqual({ ok: false, error: 'UNSUPPORTED_CHAIN' });
  });

  it('source mapping never mislabels a fallback', () => {
    expect(priceSourceOf('uniswap-v3-twap:0xp:1800s:USDG|fallback:lifi-data-gap')).toBe('UNISWAP_V3_TWAP');
    expect(priceSourceOf('peg:USDG|fallback:lifi-data-gap')).toBe('USDG_PEG');
    expect(priceSourceOf('coingecko:simple|fallback:lifi-data-gap')).toBe('COINGECKO');
    expect(priceSourceOf('robinhood-api:prices:X|verify:chainlink:0x:3bps')).toBe('ROBINHOOD_STOCK_API');
  });
});

describe('GET /api/asset-prices', () => {
  it('returns unified objects for a mixed request and validates input', async () => {
    const s = service();
    vi.resetModules();
    vi.doMock('@/lib/server/bag-asset-service', () => ({ getBagAssetService: () => s.svc }));
    const { GET } = await import('@/app/api/asset-prices/route');
    const res = await GET(new NextRequest(`http://localhost/api/asset-prices?assets=robinhood:${AAPL},arbitrum:${WETH_ARB},ethereum:${UNKNOWN_BASE}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assets.map((a: { symbol: string; assetType: string }) => `${a.symbol}:${a.assetType}`)).toEqual(['AAPL:STOCK_TOKEN', 'WETH:CRYPTO', 'UNK:CRYPTO']);
    expect(body.assets.map((a: { chainId: number }) => a.chainId)).toEqual([4663, 42161, 1]);
    expect(body.errors).toEqual({});
    for (const q of ['', '?assets=', '?assets=mars:0x1', `?assets=robinhood:${AAPL}:x`, `?assets=${Array.from({ length: 26 }, (_, i) => `base:0x${String(i).padStart(40, '0')}`).join(',')}`]) {
      expect((await GET(new NextRequest(`http://localhost/api/asset-prices${q}`))).status).toBe(400);
    }
    vi.doUnmock('@/lib/server/bag-asset-service');
  });
});

describe('checkStockTokensForPurchase (live registry, trading capabilities)', () => {
  const db = (address: string, assetType: 'stock' | 'crypto' = 'stock'): CanonicalAsset => ({ id: address, chain: 'robinhood', address, symbol: 'X', decimals: 18, name: 'X', status: 'VERIFIED', assetType, createdAt: '', updatedAt: '' });
  const rh = (address: string): AssetIdentity => ({ chain: 'robinhood', address });

  it('tradable canonical Stock Tokens pass; crypto assets are not checked', async () => {
    const { api } = service();
    expect(await checkStockTokensForPurchase([rh(AAPL), rh(CRWD), rh(IMPOSTOR)], [db(AAPL), db(CRWD), db(IMPOSTOR, 'crypto')], api)).toEqual({ ok: true });
  });
  it('untradable or no-longer-listed Stock Tokens block the purchase', async () => {
    const { api } = service();
    const r = await checkStockTokensForPurchase([rh(UNTRADABLE), rh(IMPOSTOR)], [db(UNTRADABLE), db(IMPOSTOR)], api);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind === 'NOT_TRADABLE' && r.details).toEqual([
      'HALTD is not currently tradable (Robinhood trading capabilities).',
      `${IMPOSTOR} is no longer an active Robinhood Stock Token on Robinhood Chain.`,
    ]);
  });
  it('registry unreachable → fail closed', async () => {
    const { api } = service({ registryStatus: 503 });
    expect((await checkStockTokensForPurchase([rh(AAPL)], [db(AAPL)], api)).ok).toBe(false);
  });
});
