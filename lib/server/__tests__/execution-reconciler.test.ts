import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPurchases = vi.fn();
const listRedeems = vi.fn();
const touchPurchase = vi.fn(async () => undefined);
const touchRedeem = vi.fn(async () => undefined);
const verifyPurchase = vi.fn();
const verifyRedeem = vi.fn();
vi.mock('@/lib/server/purchase-intent-repo', () => ({
  listUnsettledPurchaseIntents: (...a: unknown[]) => listPurchases(...a),
  touchUnsettledPurchaseIntent: (...a: unknown[]) => touchPurchase(...(a as [])),
}));
vi.mock('@/lib/server/redeem-intent-repo', () => ({
  listUnsettledRedeemIntents: (...a: unknown[]) => listRedeems(...a),
  touchUnsettledRedeemIntent: (...a: unknown[]) => touchRedeem(...(a as [])),
}));
vi.mock('@/lib/server/purchase-execution', () => ({ verifyExecution: (...a: unknown[]) => verifyPurchase(...a) }));
vi.mock('@/lib/server/redeem-execution', () => ({ verifyRedeemExecution: (...a: unknown[]) => verifyRedeem(...a) }));

import { reconcilePendingExecutions, RECONCILE_BATCH, RECONCILE_GRACE_MS } from '../execution-reconciler';

const NOW = new Date('2026-10-03T17:00:00Z');
const intent = (id: string, userId = 'u-' + id) => ({ id, userId, walletAddress: '0x' + id });

beforeEach(() => {
  [listPurchases, listRedeems, touchPurchase, touchRedeem, verifyPurchase, verifyRedeem].forEach((m) => m.mockReset());
  touchPurchase.mockResolvedValue(undefined);
  touchRedeem.mockResolvedValue(undefined);
  listPurchases.mockResolvedValue([]);
  listRedeems.mockResolvedValue([]);
});

describe('reconcilePendingExecutions', () => {
  it('lists only intents untouched for the grace period, bounded, and verifies each as its own owner', async () => {
    listPurchases.mockResolvedValue([intent('p1', 'alice'), intent('p2', 'bob')]);
    verifyPurchase.mockResolvedValue({ ok: true, value: { status: 'COMPLETED' } });
    const summary = await reconcilePendingExecutions({} as never, NOW);
    const cutoff = new Date(NOW.getTime() - RECONCILE_GRACE_MS).toISOString();
    expect(listPurchases).toHaveBeenCalledWith({}, cutoff, RECONCILE_BATCH);
    expect(listRedeems).toHaveBeenCalledWith({}, cutoff, RECONCILE_BATCH);
    expect(verifyPurchase.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [{ userId: 'alice', walletAddress: '0xp1' }, 'p1'],
      [{ userId: 'bob', walletAddress: '0xp2' }, 'p2'],
    ]);
    expect(summary.purchases).toEqual({ checked: 2, settled: 2, failed: 0 });
    expect(touchPurchase).not.toHaveBeenCalled();
  });

  it('a still-pending or failing check is touched (no starvation) and never stops the others', async () => {
    listPurchases.mockResolvedValue([intent('p1'), intent('p2'), intent('p3')]);
    verifyPurchase
      .mockResolvedValueOnce({ ok: true, value: { status: 'CONFIRMING' } })
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce({ ok: true, value: { status: 'COMPLETED' } });
    const summary = await reconcilePendingExecutions({} as never, NOW);
    expect(summary.purchases).toEqual({ checked: 3, settled: 1, failed: 1 });
    expect(touchPurchase.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['p1', 'p2']);
  });

  it('settles redemptions the same way', async () => {
    listRedeems.mockResolvedValue([intent('r1', 'carol')]);
    verifyRedeem.mockResolvedValue({ ok: true, value: { status: 'RECONCILIATION_REQUIRED' } });
    const summary = await reconcilePendingExecutions({} as never, NOW);
    expect(verifyRedeem.mock.calls[0].slice(1)).toEqual([{ userId: 'carol', walletAddress: '0xr1' }, 'r1']);
    expect(summary.redeems).toEqual({ checked: 1, settled: 1, failed: 0 });
  });
});
