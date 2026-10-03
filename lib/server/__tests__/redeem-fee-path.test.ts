import { beforeEach, describe, expect, it, vi } from 'vitest';

// The legacy (LI.FI) redeem path cannot collect a performance fee — the
// proceeds go straight to the redeemer's wallet — so for a Bag that charges
// one, only RedeemFeeRouter may be used. Otherwise the fee would be recorded
// as owed and paid to the creator out of the protocol's own wallet.

const getBagByIdMock = vi.fn();
const getCurrentBagVersionMock = vi.fn();
const getRedeemIntentForUserMock = vi.fn();
const updateRedeemIntentStatusMock = vi.fn();

vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: (...a: unknown[]) => getBagByIdMock(...a),
  getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersionMock(...a),
}));
vi.mock('@/lib/server/redeem-intent-repo', () => ({
  getRedeemIntentForUser: (...a: unknown[]) => getRedeemIntentForUserMock(...a),
  updateRedeemIntentStatus: (...a: unknown[]) => updateRedeemIntentStatusMock(...a),
  createRedeemIntent: vi.fn(),
  findActiveRedeemIntentForBag: vi.fn(),
  markRedeemAccountingApplied: vi.fn(),
  markRedeemReconciliationApplied: vi.fn(),
  updateRedeemIntentSteps: vi.fn(),
}));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));

const { prepareRedeemExecution } = await import('../redeem-execution');

const session = { userId: 'investor_1', walletAddress: '0x1111111111111111111111111111111111111111' };

function bag(overrides: Record<string, unknown> = {}) {
  return { id: 'bag_1', creatorId: 'creator_1', performanceFeeBpsLocked: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedeemIntentForUserMock.mockResolvedValue({
    ok: true,
    intent: { id: 'intent_1', bagId: 'bag_1', userId: 'investor_1', status: 'READY', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  getCurrentBagVersionMock.mockResolvedValue({ recipe: { performanceFeeBps: 0 } });
});

describe('prepareRedeemExecution — performance-fee Bags need the fee router', () => {
  it('refuses the legacy path when the Bag has a locked performance fee', async () => {
    getBagByIdMock.mockResolvedValue(bag({ performanceFeeBpsLocked: 1000 }));
    const outcome = await prepareRedeemExecution({} as never, session, 'intent_1');
    expect(outcome).toEqual({ ok: false, error: { kind: 'FEE_ROUTER_REQUIRED' } });
  });

  it('refuses the legacy path when the recipe sets a fee (not yet locked)', async () => {
    getBagByIdMock.mockResolvedValue(bag());
    getCurrentBagVersionMock.mockResolvedValue({ recipe: { performanceFeeBps: 500 } });
    const outcome = await prepareRedeemExecution({} as never, session, 'intent_1');
    expect(outcome).toEqual({ ok: false, error: { kind: 'FEE_ROUTER_REQUIRED' } });
  });

  it('lets the creator redeem their own Bag without the router (no fee applies to them)', async () => {
    getBagByIdMock.mockResolvedValue(bag({ creatorId: 'investor_1', performanceFeeBpsLocked: 1000 }));
    const outcome = await prepareRedeemExecution({} as never, session, 'intent_1');
    expect(outcome).not.toEqual({ ok: false, error: { kind: 'FEE_ROUTER_REQUIRED' } });
  });
});
