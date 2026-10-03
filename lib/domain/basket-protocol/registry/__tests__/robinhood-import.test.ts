import { describe, expect, it, vi } from 'vitest';
import { CanonicalAsset } from '@/types/basket-protocol';
import {
  RobinhoodAsset,
  RobinhoodFetchError,
  applyMultiplierUpdates,
  applyRobinhoodImportPlan,
  fetchRobinhoodAssets,
  mapRobinhoodAssets,
  planRobinhoodImport,
} from '../robinhood-import';

function makeRemoteAsset(overrides: Partial<RobinhoodAsset> = {}): RobinhoodAsset {
  return {
    id: '0xasset1',
    tokenSymbol: 'NVDA',
    tokenName: 'NVIDIA • Robinhood Token',
    deployments: [{ contractAddress: '0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 }],
    currentMultiplier: '1.000000000000000000',
    status: 'ASSET_STATUS_ACTIVE',
    tokenDecimals: 18,
    ...overrides,
  };
}

function makeCanonicalAsset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'row_1',
    chain: 'robinhood',
    address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    symbol: 'NVDA',
    decimals: 18,
    name: 'NVIDIA • Robinhood Token',
    status: 'VERIFIED',
    assetType: 'stock',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('fetchRobinhoodAssets', () => {
  it('returns the assets array on a healthy 200 JSON response', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assets: [makeRemoteAsset()] }),
    });
    const assets = await fetchRobinhoodAssets(fakeFetch as unknown as typeof fetch);
    expect(assets).toHaveLength(1);
    expect(assets[0].tokenSymbol).toBe('NVDA');
  });

  it('throws RobinhoodFetchError on a non-200 response instead of returning empty', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(fetchRobinhoodAssets(fakeFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(
      RobinhoodFetchError
    );
  });

  it('throws RobinhoodFetchError when the response has no `assets` array', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oops: true }) });
    await expect(fetchRobinhoodAssets(fakeFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(
      RobinhoodFetchError
    );
  });

  it('throws RobinhoodFetchError when the network call itself rejects', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(fetchRobinhoodAssets(fakeFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(
      RobinhoodFetchError
    );
  });
});

describe('mapRobinhoodAssets', () => {
  it('maps an active, Robinhood-Chain-deployed asset to a RegisterAssetInput with the un-prefixed symbol', () => {
    const { candidates, skipped } = mapRobinhoodAssets([makeRemoteAsset()]);
    expect(skipped).toHaveLength(0);
    expect(candidates).toEqual([
      {
        chain: 'robinhood',
        address: '0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
        symbol: 'NVDA',
        decimals: 18,
        name: 'NVIDIA • Robinhood Token',
        assetType: 'stock',
        currentMultiplier: '1.000000000000000000',
      },
    ]);
  });

  it('passes through a non-1.0 currentMultiplier as-received (never parsed to a number)', () => {
    const { candidates } = mapRobinhoodAssets([
      makeRemoteAsset({ tokenSymbol: 'CRWD', currentMultiplier: '4.000000000000000000' }),
    ]);
    expect(candidates[0].currentMultiplier).toBe('4.000000000000000000');
    expect(typeof candidates[0].currentMultiplier).toBe('string');
  });

  it('skips assets that are not ASSET_STATUS_ACTIVE', () => {
    const { candidates, skipped } = mapRobinhoodAssets([makeRemoteAsset({ status: 'ASSET_STATUS_HALTED' })]);
    expect(candidates).toHaveLength(0);
    expect(skipped).toEqual([{ tokenSymbol: 'NVDA', reason: 'NOT_ACTIVE' }]);
  });

  it('skips assets with no deployment on chainId 4663 (Robinhood Chain)', () => {
    const { candidates, skipped } = mapRobinhoodAssets([
      makeRemoteAsset({ deployments: [{ contractAddress: '0xabc', chainId: 1 }] }),
    ]);
    expect(candidates).toHaveLength(0);
    expect(skipped).toEqual([{ tokenSymbol: 'NVDA', reason: 'NO_ROBINHOOD_DEPLOYMENT' }]);
  });

  it('picks the 4663 deployment when an asset lists deployments on multiple chains', () => {
    const { candidates } = mapRobinhoodAssets([
      makeRemoteAsset({
        deployments: [
          { contractAddress: '0xOTHERCHAIN', chainId: 1 },
          { contractAddress: '0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', chainId: 4663 },
        ],
      }),
    ]);
    expect(candidates[0].address).toBe('0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
  });
});

describe('planRobinhoodImport', () => {
  it('puts a brand-new active asset in toRegister', () => {
    const plan = planRobinhoodImport([makeRemoteAsset()], []);
    expect(plan.toRegister).toHaveLength(1);
    expect(plan.toRegister[0].symbol).toBe('NVDA');
    expect(plan.alreadyRegistered).toHaveLength(0);
    expect(plan.possiblyDelisted).toHaveLength(0);
  });

  it('treats a matching (chain, address) as already registered regardless of address casing', () => {
    const plan = planRobinhoodImport([makeRemoteAsset()], [makeCanonicalAsset()]);
    expect(plan.toRegister).toHaveLength(0);
    expect(plan.alreadyRegistered).toHaveLength(1);
  });

  it('flags a VERIFIED asset no longer on the active remote feed as possiblyDelisted, without touching UNKNOWN/DEPRECATED ones', () => {
    const verifiedGone = makeCanonicalAsset({ id: 'row_1', symbol: 'OLD' });
    const unknownGone = makeCanonicalAsset({
      id: 'row_2',
      address: '0x0000000000000000000000000000000000000001',
      status: 'UNKNOWN',
    });
    const plan = planRobinhoodImport([], [verifiedGone, unknownGone]);
    expect(plan.possiblyDelisted).toEqual([verifiedGone]);
    expect(plan.toRegister).toHaveLength(0);
  });

  it('a symbol change on the same contract is identity, not a new asset plus a delisting', () => {
    // Same (chain, address) as the fixture, but the remote feed now reports
    // a different tokenSymbol (e.g. a corporate-action rename).
    const renamed = makeRemoteAsset({ tokenSymbol: 'NEWSYM' });
    const plan = planRobinhoodImport([renamed], [makeCanonicalAsset({ symbol: 'NVDA' })]);
    expect(plan.toRegister).toHaveLength(0);
    expect(plan.possiblyDelisted).toHaveLength(0);
    expect(plan.alreadyRegistered).toHaveLength(1);
  });

  it('never reports a crypto row on the same chain (e.g. WETH) as possiblyDelisted', () => {
    const weth = makeCanonicalAsset({ id: 'weth', address: '0xweth', symbol: 'WETH', assetType: 'crypto' });
    const plan = planRobinhoodImport([makeRemoteAsset()], [weth]);
    expect(plan.possiblyDelisted).toEqual([]);
  });

  it('surfaces skipped assets on the plan', () => {
    const plan = planRobinhoodImport([makeRemoteAsset({ status: 'ASSET_STATUS_HALTED' })], []);
    expect(plan.skipped).toEqual([{ tokenSymbol: 'NVDA', reason: 'NOT_ACTIVE' }]);
  });

  // Phase 16 — currentMultiplier drift on an already-registered asset
  // (the Phase 15 gap this phase's spec called out explicitly).
  it('flags a multiplier change on an already-registered asset as multiplierUpdates, not a re-registration', () => {
    const remote = makeRemoteAsset({ currentMultiplier: '2.000000000000000000' });
    const existing = makeCanonicalAsset({ currentMultiplier: '1.000000000000000000' });
    const plan = planRobinhoodImport([remote], [existing]);

    expect(plan.toRegister).toHaveLength(0);
    expect(plan.alreadyRegistered).toHaveLength(1);
    expect(plan.multiplierUpdates).toEqual([
      { asset: existing, previousMultiplier: '1.000000000000000000', newMultiplier: '2.000000000000000000' },
    ]);
  });

  it('does not flag a multiplierUpdate when the remote value matches what is already stored', () => {
    const remote = makeRemoteAsset({ currentMultiplier: '1.000000000000000000' });
    const existing = makeCanonicalAsset({ currentMultiplier: '1.000000000000000000' });
    const plan = planRobinhoodImport([remote], [existing]);
    expect(plan.multiplierUpdates).toHaveLength(0);
  });

  it('does not flag a multiplierUpdate for a brand-new (toRegister) asset — it registers with the right value already', () => {
    const plan = planRobinhoodImport([makeRemoteAsset({ currentMultiplier: '3.0' })], []);
    expect(plan.multiplierUpdates).toHaveLength(0);
  });

  it('stores the feed logoUrl (the Stock Token icon wallets show) and syncs it onto registered assets', () => {
    const logoUrl = 'https://cdn.robinhood.com/ncw_assets/logos/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png';
    const fresh = planRobinhoodImport([makeRemoteAsset({ logoUrl })], []);
    expect(fresh.toRegister[0].logoUrl).toBe(logoUrl);

    const plan = planRobinhoodImport([makeRemoteAsset({ logoUrl })], [makeCanonicalAsset()]);
    expect(plan.logoUpdates.map((u) => u.logoUrl)).toEqual([logoUrl]);
  });

  it('ignores a non-https feed logoUrl', () => {
    const fresh = planRobinhoodImport([makeRemoteAsset({ logoUrl: 'http://insecure.example/x.png' })], []);
    expect(fresh.toRegister[0].logoUrl).toBeUndefined();
  });
});

describe('applyRobinhoodImportPlan', () => {
  it('registers every toRegister entry and reports per-item results', async () => {
    const registerAssetFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, asset: makeCanonicalAsset({ id: 'new_1' }) })
      .mockResolvedValueOnce({ ok: false, error: 'DUPLICATE_ASSET', message: 'already registered' });

    const plan = planRobinhoodImport(
      [makeRemoteAsset(), makeRemoteAsset({ tokenSymbol: 'AAPL', deployments: [{ contractAddress: '0xAAPL', chainId: 4663 }] })],
      []
    );

    const result = await applyRobinhoodImportPlan(registerAssetFn, plan);
    expect(registerAssetFn).toHaveBeenCalledTimes(2);
    expect(result.registered).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe('already registered');
  });

  it('does not call registerAssetFn at all for an empty toRegister list', async () => {
    const registerAssetFn = vi.fn();
    await applyRobinhoodImportPlan(registerAssetFn, {
      toRegister: [],
      alreadyRegistered: [],
      possiblyDelisted: [],
      skipped: [],
      multiplierUpdates: [],
      logoUpdates: [],
    });
    expect(registerAssetFn).not.toHaveBeenCalled();
  });
});

describe('applyMultiplierUpdates', () => {
  it('updates every flagged asset and reports per-item results', async () => {
    const existing = makeCanonicalAsset({ id: 'row_1', currentMultiplier: '1.0' });
    const updateFn = vi.fn().mockResolvedValueOnce(makeCanonicalAsset({ id: 'row_1', currentMultiplier: '2.0' }));

    const plan = {
      toRegister: [],
      alreadyRegistered: [existing],
      possiblyDelisted: [],
      skipped: [],
      multiplierUpdates: [{ asset: existing, previousMultiplier: '1.0', newMultiplier: '2.0' }],
      logoUpdates: [],
    };

    const result = await applyMultiplierUpdates(updateFn, plan);
    expect(updateFn).toHaveBeenCalledWith('row_1', '2.0');
    expect(result.updated).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('continues past an individual failure and reports it rather than throwing', async () => {
    const existing = makeCanonicalAsset({ id: 'row_1' });
    const updateFn = vi.fn().mockRejectedValueOnce(new Error('db down'));

    const plan = {
      toRegister: [],
      alreadyRegistered: [existing],
      possiblyDelisted: [],
      skipped: [],
      multiplierUpdates: [{ asset: existing, previousMultiplier: '1.0', newMultiplier: '2.0' }],
      logoUpdates: [],
    };

    const result = await applyMultiplierUpdates(updateFn, plan);
    expect(result.updated).toHaveLength(0);
    expect(result.failed).toEqual([{ update: plan.multiplierUpdates[0], error: 'db down' }]);
  });

  it('does not call updateFn at all for an empty multiplierUpdates list', async () => {
    const updateFn = vi.fn();
    await applyMultiplierUpdates(updateFn, {
      toRegister: [],
      alreadyRegistered: [],
      possiblyDelisted: [],
      skipped: [],
      multiplierUpdates: [],
      logoUpdates: [],
    });
    expect(updateFn).not.toHaveBeenCalled();
  });
});
