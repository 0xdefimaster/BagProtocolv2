import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/bags/:id/rebalance-preview: session, visibility, the CURRENT version as target, prices for held and
// targeted assets, fail-closed balances. Supabase, RPC and prices are mocked.

const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const BAG = '170e5e72-d5d5-4f16-b180-24b3dc525b37';
const E18 = BigInt(10) ** BigInt(18);

const m = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getBagById: vi.fn(),
  getCurrentBagVersion: vi.fn(),
  observe: vi.fn(),
  sellable: vi.fn(),
  getPrice: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/require-session', () => ({ requireSession: () => m.requireSession() }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitedResponseBody: () => ({}) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: m.getBagById, getCurrentBagVersion: m.getCurrentBagVersion }));
vi.mock('@/lib/server/asset-repo', () => ({ listAssets: async () => [{ chain: 'robinhood', address: TSLA, symbol: 'TSLA' }, { chain: 'robinhood', address: NVDA, symbol: 'NVDA' }] }));
vi.mock('@/lib/server/price-provider', () => ({ getDisplayPriceProvider: () => ({ getPrice: m.getPrice }) }));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));
vi.mock('@/lib/server/position-valuation', () => ({
  assetKey: (c: string, a: string) => `${c}:${a.toLowerCase()}`,
  observeUserHoldings: m.observe,
  sellableHoldingsForBag: m.sellable,
}));

import { GET } from '@/app/api/bags/[id]/rebalance-preview/route';

const call = () => GET({} as never, { params: Promise.resolve({ id: BAG }) });
const holding = (address: string, units: number) => ({ chain: 'robinhood', address, decimals: 18, quantityRaw: (BigInt(units) * E18).toString(), sellableRaw: (BigInt(units) * E18).toString() });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.requireSession.mockResolvedValue({ ok: true, session: { userId: 'u1', walletAddress: '0xw' } });
  m.getBagById.mockResolvedValue({ id: BAG, name: 'feetest', symbol: 'FEETEST', chain: 'robinhood', status: 'ACTIVE', creatorId: 'creator' });
  m.getCurrentBagVersion.mockResolvedValue({
    version: 2,
    recipe: {
      chain: 'robinhood',
      version: 1, // the stored recipe's own field is stale; the row's version wins
      assets: [
        { chain: 'robinhood', address: TSLA, symbol: 'TSLA', decimals: 18, weightBps: 5000 },
        { chain: 'robinhood', address: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 5000 },
      ],
      rebalanceRule: { frequency: 'MANUAL', driftThresholdBps: 500, maxSlippageBps: 100 },
    },
  });
  m.observe.mockResolvedValue({ blockNumber: '85400000' });
  m.sellable.mockReturnValue([holding(TSLA, 60), holding(NVDA, 40)]);
  m.getPrice.mockImplementation(async (asset: { chain: string; address: string }) => ({ asset, price: '1', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'test' }));
});

describe('GET /api/bags/:id/rebalance-preview', () => {
  it('requires a session', async () => {
    m.requireSession.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await call()).status).toBe(401);
    expect(m.observe).not.toHaveBeenCalled();
  });

  it('plans the position toward the current version and names the assets', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blockNumber).toBe('85400000');
    expect(body.symbols[`robinhood:${TSLA}`]).toBe('TSLA');
    expect(body.preview).toMatchObject({ status: 'OK', targetVersion: 2, driftThresholdBps: 500, maxAbsDriftBps: 1000, requiresRebalance: true });
    expect(m.getPrice).toHaveBeenCalledTimes(2);
  });

  it('fails closed on unreadable balances and on a refused price', async () => {
    m.sellable.mockReturnValue(null);
    expect((await (await call()).json()).preview).toEqual({ status: 'UNREADABLE_BALANCES' });
    m.sellable.mockReturnValue([holding(TSLA, 60), holding(NVDA, 40)]);
    m.getPrice.mockImplementation(async (asset: { address: string }) => {
      if (asset.address === NVDA) throw new Error('no verified price');
      return { asset, price: '1', quoteCurrency: 'USD', timestamp: new Date().toISOString(), source: 'test' };
    });
    expect((await (await call()).json()).preview).toEqual({ status: 'PRICE_UNAVAILABLE', assets: [NVDA] });
  });

  it('hides a non-active Bag from anyone but its creator', async () => {
    m.getBagById.mockResolvedValue({ id: BAG, chain: 'robinhood', status: 'DRAFT', creatorId: 'creator' });
    expect((await call()).status).toBe(404);
  });
});
