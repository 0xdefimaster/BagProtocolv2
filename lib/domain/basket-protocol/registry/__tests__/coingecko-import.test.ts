import { describe, expect, it, vi } from 'vitest';
import {
  applyCoinImportPlan,
  fetchCoinCandidatesForChain,
  planCoinImportForChain,
} from '../coingecko-import';
import { CanonicalAsset } from '@/types/basket-protocol';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Error', json: async () => body } as unknown as Response;
}

function makeCanonicalAsset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'asset_1',
    chain: 'ethereum',
    address: '0x1111111111111111111111111111111111111a',
    symbol: 'BTC',
    decimals: 18,
    name: 'Wrapped Bitcoin',
    status: 'VERIFIED',
    assetType: 'crypto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const noSleep = () => Promise.resolve();

describe('fetchCoinCandidatesForChain', () => {
  it('resolves a coin to a real candidate when the requested chain has a deployment', async () => {
    const fetchImpl = vi
      .fn()
      // /search
      .mockResolvedValueOnce(
        jsonResponse({ coins: [{ id: 'ethereum', symbol: 'ETH', name: 'Ethereum', market_cap_rank: 2 }] })
      )
      // /coins/{id}
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'ethereum',
          symbol: 'eth',
          name: 'Ethereum',
          detail_platforms: {
            base: { decimal_place: 18, contract_address: '0x4200000000000000000000000000000000000006' },
          },
        })
      );

    const result = await fetchCoinCandidatesForChain(
      'base',
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
      [{ symbol: 'ETH', name: 'Ethereum' }]
    );

    expect(result.skipped).toEqual([]);
    expect(result.candidates).toEqual([
      {
        chain: 'base',
        address: '0x4200000000000000000000000000000000000006',
        symbol: 'ETH',
        decimals: 18,
        name: 'Ethereum',
        assetType: 'crypto',
      },
    ]);
  });

  it('skips a native asset with no deployment on the requested chain, rather than fabricating a wrapped-token equivalence', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ coins: [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1 }] })
      )
      .mockResolvedValueOnce(
        // real CoinGecko shape for a coin with no EVM deployment: platforms/detail_platforms keyed by ''
        jsonResponse({
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          detail_platforms: { '': { decimal_place: null, contract_address: '' } },
        })
      );

    const result = await fetchCoinCandidatesForChain(
      'ethereum',
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
      [{ symbol: 'BTC', name: 'Bitcoin' }]
    );

    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ symbol: 'BTC', reason: 'NO_DEPLOYMENT_ON_CHAIN' }]);
  });

  it('picks the highest-market-cap result when multiple search hits share a symbol, never the first one blindly', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          coins: [
            { id: 'some-copycat-uni', symbol: 'UNI', name: 'Uni Copycat', market_cap_rank: 4500 },
            { id: 'uniswap', symbol: 'UNI', name: 'Uniswap', market_cap_rank: 30 },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'uniswap',
          symbol: 'uni',
          name: 'Uniswap',
          detail_platforms: {
            ethereum: { decimal_place: 18, contract_address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984' },
          },
        })
      );

    const result = await fetchCoinCandidatesForChain(
      'ethereum',
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
      [{ symbol: 'UNI', name: 'Uniswap' }]
    );

    expect(fetchImpl.mock.calls[1][0]).toContain('/coins/uniswap');
    expect(result.candidates[0].address).toBe('0x1f9840a85d5af5bf1d1762f925bdaddc4201f984');
  });

  it('skips with NOT_FOUND_ON_COINGECKO when no search result matches the symbol', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ coins: [] }));

    const result = await fetchCoinCandidatesForChain(
      'ethereum',
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
      [{ symbol: 'ZZZZ', name: 'Nonexistent Coin' }]
    );

    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ symbol: 'ZZZZ', reason: 'NOT_FOUND_ON_COINGECKO' }]);
  });

  it('fails closed with FETCH_ERROR (not a thrown exception) on a non-2xx response, and keeps processing remaining coins', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(
        jsonResponse({ coins: [{ id: 'ethereum', symbol: 'ETH', name: 'Ethereum', market_cap_rank: 2 }] })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'ethereum',
          symbol: 'eth',
          name: 'Ethereum',
          detail_platforms: { ethereum: { decimal_place: 18, contract_address: '0xnative' } },
        })
      );

    const result = await fetchCoinCandidatesForChain(
      'ethereum',
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
      [
        { symbol: 'BROKEN', name: 'Broken Coin' },
        { symbol: 'ETH', name: 'Ethereum' },
      ]
    );

    expect(result.skipped).toEqual([{ symbol: 'BROKEN', reason: 'FETCH_ERROR', detail: expect.any(String) }]);
    expect(result.candidates).toHaveLength(1);
  });
});

describe('planCoinImportForChain', () => {
  it('separates candidates already in the registry from ones that need registering', () => {
    const existing = [
      makeCanonicalAsset({ chain: 'ethereum', address: '0xalready', symbol: 'ETH' }),
    ];
    const candidateResult = {
      candidates: [
        { chain: 'ethereum' as const, address: '0xalready', symbol: 'ETH', decimals: 18, name: 'Ethereum', assetType: 'crypto' as const },
        { chain: 'ethereum' as const, address: '0xnew', symbol: 'ARB', decimals: 18, name: 'Arbitrum', assetType: 'crypto' as const },
      ],
      skipped: [],
    };

    const plan = planCoinImportForChain(candidateResult, existing);

    expect(plan.toRegister).toEqual([candidateResult.candidates[1]]);
    expect(plan.alreadyRegistered).toEqual([existing[0]]);
  });
});

describe('applyCoinImportPlan', () => {
  it('continues past an individual registration failure and reports it', async () => {
    const registerAssetFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'DUPLICATE_ASSET', message: 'already there' })
      .mockResolvedValueOnce({ ok: true, asset: makeCanonicalAsset({ symbol: 'ARB' }) });

    const plan = {
      toRegister: [
        { chain: 'ethereum' as const, address: '0xa', symbol: 'A', decimals: 18, name: 'A', assetType: 'crypto' as const },
        { chain: 'ethereum' as const, address: '0xb', symbol: 'ARB', decimals: 18, name: 'Arbitrum', assetType: 'crypto' as const },
      ],
      alreadyRegistered: [],
      skipped: [],
    };

    const result = await applyCoinImportPlan(registerAssetFn, plan);

    expect(result.registered).toHaveLength(1);
    expect(result.failed).toEqual([{ input: plan.toRegister[0], error: 'already there' }]);
  });
});
