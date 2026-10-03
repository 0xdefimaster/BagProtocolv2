import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CanonicalAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 17 — route-level tests for `POST /api/bags`'s new registry-lookup
// wiring: composition symbols are resolved against the VERIFIED asset
// registry (Phase 16) before being handed to
// `mapCreateBagRequestToRecipeInput`, so a real Robinhood stock token no
// longer always gets the `__PENDING__` address placeholder. See
// `lib/mappers/__tests__/bag-mapper.test.ts` for the mapper-level unit
// tests of the lookup's per-asset chain behavior — these are route-level:
// they prove the route actually builds and passes the lookup.
// -----------------------------------------------------------------------------

const listAssetsMock = vi.fn();
const createBagMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({}) as never,
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireSession: async () => ({ ok: true, session: { userId: 'creator_1', walletAddress: '0xabc' } }),
}));

vi.mock('@/lib/server/asset-repo', () => ({
  listAssets: (...args: unknown[]) => listAssetsMock(...args),
}));

const countRecentDraftBagsMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock('@/lib/server/bag-repo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/bag-repo')>('@/lib/server/bag-repo');
  return {
    ...actual,
    createBag: (...args: unknown[]) => createBagMock(...args),
    countRecentDraftBags: (...args: unknown[]) => countRecentDraftBagsMock(...args),
    getCurrentBagVersion: vi.fn(),
    listBags: vi.fn(),
  };
});

import { POST } from '@/app/api/bags/route';

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/bags', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function asset(overrides: Partial<CanonicalAsset> = {}): CanonicalAsset {
  return {
    id: 'asset_1',
    chain: 'robinhood',
    address: '0xaaaa000000000000000000000000000000aaaa',
    symbol: 'NVDA',
    decimals: 18,
    name: 'NVIDIA',
    status: 'VERIFIED',
    assetType: 'stock',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  countRecentDraftBagsMock.mockResolvedValue(0);
  listAssetsMock.mockResolvedValue([]);
  createBagMock.mockResolvedValue({
    ok: true,
    bag: {
      id: 'bag_1',
      slug: 'nvda-bag-abc123',
      name: 'NVDA Bag',
      symbol: 'NVDABAG',
      description: '',
      creatorId: 'creator_1',
      chain: 'robinhood',
      strategyType: 'STATIC_BASKET',
      mutability: 'MUTABLE',
      status: 'ACTIVE',
      currentVersion: 1,
      currentVersionId: 'version_1',
      parentBagId: null,
      rootBagId: null,
      registryId: null,
      contractAddress: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    version: null,
  });
});

describe('POST /api/bags — asset registry lookup (Phase 17)', () => {
  it('queries the VERIFIED registry SCOPED TO THE BAG\'S OWN CHAIN and resolves a known symbol to its real chain/address/decimals', async () => {
    listAssetsMock.mockResolvedValue([asset({ symbol: 'NVDA', chain: 'robinhood', decimals: 6 })]);

    const res = await POST(
      postRequest({
        name: 'NVDA Bag',
        chain: 'robinhood',
        composition: [{ symbol: 'NVDA', weight: 100 }],
      })
    );

    expect(res.status).toBe(201);
    // Production-hardening P0-3: scoped by chain in the query itself, not
    // filtered after the fact — a cross-chain VERIFIED row is never even
    // fetched for consideration.
    expect(listAssetsMock).toHaveBeenCalledWith(expect.anything(), { status: 'VERIFIED', chain: 'robinhood' });

    const input = createBagMock.mock.calls[0][1];
    expect(input.recipe.assets).toHaveLength(1);
    expect(input.recipe.assets[0]).toMatchObject({
      symbol: 'NVDA',
      chain: 'robinhood',
      address: '0xaaaa000000000000000000000000000000aaaa',
      decimals: 6,
    });
  });

  it('a symbol the registry does not know falls back to the bag chain and the __PENDING__ placeholder — same as before Phase 17', async () => {
    listAssetsMock.mockResolvedValue([]); // nothing registered yet

    const res = await POST(
      postRequest({
        name: 'Majors Basket',
        chain: 'ethereum',
        composition: [{ symbol: 'BTC', weight: 100 }],
      })
    );

    expect(res.status).toBe(201);
    const input = createBagMock.mock.calls[0][1];
    expect(input.recipe.assets[0]).toMatchObject({ symbol: 'BTC', chain: 'ethereum', address: '__PENDING__' });
  });

  it('symbol lookup is case-insensitive against the registry', async () => {
    listAssetsMock.mockResolvedValue([asset({ symbol: 'NVDA', chain: 'robinhood' })]);

    const res = await POST(
      postRequest({
        name: 'nvda lowercase',
        chain: 'robinhood',
        composition: [{ symbol: 'nvda', weight: 100 }],
      })
    );

    expect(res.status).toBe(201);
    const input = createBagMock.mock.calls[0][1];
    expect(input.recipe.assets[0].address).toBe('0xaaaa000000000000000000000000000000aaaa');
  });

  // Production-hardening P0-3 — regression test 7: "Asset present on
  // another chain does not resolve." An earlier revision had a second
  // fallback pass that filled an unresolved symbol from ANY chain's
  // registry entry; that pass is gone. `listAssets` is now called with
  // `chain: bagChain`, so a real query scoped to `ethereum` would never
  // even see a `robinhood`-only NVDA row — modeled here by the mock
  // simply returning nothing for this (chain-scoped) call, exactly like a
  // real Postgres query would.
  it('a symbol registered ONLY on a different chain than the bag does NOT resolve — no cross-chain fallback (item 3 / regression test 7)', async () => {
    listAssetsMock.mockResolvedValue([]); // the bag's own chain (ethereum) has no VERIFIED NVDA — only robinhood does, and that's never queried

    const res = await POST(
      postRequest({
        name: 'Cross chain test',
        chain: 'ethereum',
        composition: [{ symbol: 'NVDA', weight: 100 }],
      })
    );

    expect(res.status).toBe(201);
    expect(listAssetsMock).toHaveBeenCalledWith(expect.anything(), { status: 'VERIFIED', chain: 'ethereum' });
    const input = createBagMock.mock.calls[0][1];
    // Falls to the SAME unresolved/__PENDING__ path as any other unknown
    // symbol — never silently adopts the robinhood asset's address/chain.
    expect(input.recipe.assets[0]).toMatchObject({ symbol: 'NVDA', chain: 'ethereum', address: '__PENDING__' });
  });

  // Regression test 8: BTC specifically — the asset with no ERC-20
  // deployment on any EVM chain this app supports at all (see
  // coingecko-import.ts's own doc). Never allowed to resolve to a fake
  // address; always falls to the same honest __PENDING__/unresolved path.
  it('BTC can never resolve to a fabricated ERC-20 address on any chain (regression test 8)', async () => {
    listAssetsMock.mockResolvedValue([]); // BTC is never a VERIFIED row on an EVM chain — the importer correctly never registers one

    const res = await POST(
      postRequest({
        name: 'BTC basket',
        chain: 'base',
        composition: [{ symbol: 'BTC', weight: 100 }],
      })
    );

    expect(res.status).toBe(201);
    const input = createBagMock.mock.calls[0][1];
    expect(input.recipe.assets[0]).toMatchObject({ symbol: 'BTC', chain: 'base', address: '__PENDING__' });
  });

  it('mixed composition: a registry-known symbol and an unknown one each get correctly resolved independently', async () => {
    listAssetsMock.mockResolvedValue([asset({ symbol: 'NVDA', chain: 'robinhood', decimals: 6 })]);

    const res = await POST(
      postRequest({
        name: 'Mixed Bag',
        chain: 'robinhood',
        composition: [
          { symbol: 'NVDA', weight: 60 },
          { symbol: 'UNLISTEDCOIN', weight: 40 },
        ],
      })
    );

    expect(res.status).toBe(201);
    const input = createBagMock.mock.calls[0][1];
    const bySymbol = Object.fromEntries(input.recipe.assets.map((a: { symbol: string }) => [a.symbol, a]));
    expect(bySymbol.NVDA).toMatchObject({ address: '0xaaaa000000000000000000000000000000aaaa', decimals: 6 });
    expect(bySymbol.UNLISTEDCOIN).toMatchObject({ address: '__PENDING__' });
  });
});

describe('POST /api/bags — undeployed draft cap', () => {
  it('refuses a new draft once the wallet has MAX_RECENT_DRAFTS undeployed ones in the last 24h', async () => {
    countRecentDraftBagsMock.mockResolvedValue(5);
    const res = await POST(postRequest({ name: 'Spam Bag', chain: 'robinhood', composition: [{ symbol: 'NVDA', weight: 100 }] }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'TOO_MANY_DRAFTS' });
    expect(createBagMock).not.toHaveBeenCalled();
  });

  it('still allows a draft below the cap', async () => {
    countRecentDraftBagsMock.mockResolvedValue(4);
    const res = await POST(postRequest({ name: 'NVDA Bag', chain: 'robinhood', composition: [{ symbol: 'NVDA', weight: 100 }] }));
    expect(res.status).toBe(201);
  });
});
