import { beforeEach, describe, expect, it, vi } from 'vitest';

// Purchases whose window was closed before verification stay SUBMITTED/CONFIRMING. Opening the portfolio or
// profile settles them through the same verifyExecution() as the purchase flow (own intents only, idempotent).

const listUnsettled = vi.fn();
const getPurchaseIntentForUser = vi.fn();
vi.mock('@/lib/server/purchase-intent-repo', () => ({
  listUnsettledPurchaseIntentsForUser: (...a: unknown[]) => listUnsettled(...a),
  getPurchaseIntentForUser: (...a: unknown[]) => getPurchaseIntentForUser(...a),
  findActivePurchaseIntentForBag: async () => null,
}));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));

const { settleUnsettledPurchasesForUser, MAX_SETTLE_PER_CALL } = await import('../purchase-execution');
const session = { userId: 'u1', walletAddress: '0xw' };

beforeEach(() => {
  listUnsettled.mockReset();
  getPurchaseIntentForUser.mockReset();
});

describe('settleUnsettledPurchasesForUser', () => {
  it("lists only this user's unsettled intents, bounded, and verifies each", async () => {
    listUnsettled.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);
    // Already final in the database: verifyExecution returns it as-is (idempotent).
    getPurchaseIntentForUser.mockImplementation(async (_a: unknown, id: string) => ({ ok: true, intent: { id, status: 'COMPLETED', steps: [] } }));
    expect(await settleUnsettledPurchasesForUser({} as never, session)).toEqual({ checked: 2, settled: 2 });
    expect(listUnsettled).toHaveBeenCalledWith({}, 'u1', MAX_SETTLE_PER_CALL);
    expect(getPurchaseIntentForUser.mock.calls.map((c) => [c[1], c[2]])).toEqual([['i1', 'u1'], ['i2', 'u1']]);
  });

  it('never throws: a failing lookup or check is left for the next call', async () => {
    listUnsettled.mockRejectedValueOnce(new Error('db down'));
    expect(await settleUnsettledPurchasesForUser({} as never, session)).toEqual({ checked: 0, settled: 0 });
    listUnsettled.mockResolvedValue([{ id: 'i1' }]);
    getPurchaseIntentForUser.mockRejectedValue(new Error('timeout'));
    expect(await settleUnsettledPurchasesForUser({} as never, session)).toEqual({ checked: 1, settled: 0 });
  });
});
