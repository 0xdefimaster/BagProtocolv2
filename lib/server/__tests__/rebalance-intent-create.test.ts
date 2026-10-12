import { beforeEach, describe, expect, it, vi } from 'vitest';

const planMock = vi.fn();
const activeRedeemMock = vi.fn();
vi.mock('@/lib/server/rebalance-quote', () => ({ planRebalance: (...a: unknown[]) => planMock(...a) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ findActiveRedeemIntentForBag: (...a: unknown[]) => activeRedeemMock(...a) }));
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: vi.fn() }));
vi.mock('@/lib/blockchain/composer-tx-search', () => ({ findComposerTransactionFromWallet: vi.fn() }));

import { createRebalanceIntent, publicRebalanceIntent, REBALANCE_INTENT_TTL_MS } from '../rebalance-execution';

// Creating a rebalance intent: one open rebalance per position, none while a sale is open, and the planned
// transaction is recorded before it is handed out.

const NOW = new Date('2026-10-13T10:00:00Z');
const session = { userId: 'u1', walletAddress: '0x' + '1'.repeat(40) };
const PLAN = {
  ok: true,
  targetVersion: 3,
  planSells: [{ chain: 'robinhood', address: '0xa', decimals: 18, symbol: 'A', amountRaw: '5' }],
  planBuys: [{ chain: 'robinhood', address: '0xb', decimals: 18, symbol: 'B', weightBps: 10000, expectedOutRaw: '9', minOutRaw: '8' }],
  transaction: { to: '0xc', data: '0xdead', value: '0', chainId: 4663 },
  approvals: [{ token: '0xa', spender: '0xs', amountRaw: '5' }],
};

function fakeAdmin(openRow: Record<string, unknown> | null) {
  const inserted: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      select: () => {
        const q: Record<string, unknown> = {};
        q.eq = () => q;
        q.in = () => q;
        q.order = () => q;
        q.limit = () => q;
        q.maybeSingle = async () => ({ data: openRow, error: null });
        return q;
      },
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { select: () => ({ single: async () => ({ data: { id: 'r1', created_at: NOW.toISOString(), tx_hash: null, failure_code: null, failure_message: null, result: null, ...row }, error: null }) }) };
      },
    }),
  };
  return { admin: admin as never, inserted };
}
const create = (admin: never) => createRebalanceIntent(admin, {} as never, {} as never, session, 'bag1', { apiKey: 'k', now: NOW });

beforeEach(() => {
  planMock.mockReset().mockResolvedValue(PLAN);
  activeRedeemMock.mockReset().mockResolvedValue(null);
});

describe('createRebalanceIntent', () => {
  it('records the planned transaction and its legs as a READY intent that expires', async () => {
    const { admin, inserted } = fakeAdmin(null);
    const r = await create(admin);
    expect(r.ok).toBe(true);
    expect(inserted[0]).toMatchObject({
      user_id: 'u1',
      bag_id: 'bag1',
      target_version: 3,
      status: 'READY',
      sells: PLAN.planSells,
      buys: PLAN.planBuys,
      composer_transaction: { ...PLAN.transaction, approvals: PLAN.approvals },
      expires_at: new Date(NOW.getTime() + REBALANCE_INTENT_TTL_MS).toISOString(),
    });
    if (r.ok) {
      const view = publicRebalanceIntent(r.intent);
      expect(view.composerTransaction).toMatchObject({ to: '0xc', approvals: PLAN.approvals });
      expect(view).not.toHaveProperty('walletAddress');
    }
  });

  it('refuses while another rebalance of the position is open, or a sale is in progress', async () => {
    const open = { status: 'SUBMITTED', expires_at: NOW.toISOString() };
    expect(await create(fakeAdmin(open).admin)).toMatchObject({ ok: false, status: 409 });
    activeRedeemMock.mockResolvedValue({ id: 'sale' });
    expect(await create(fakeAdmin(null).admin)).toMatchObject({ ok: false, status: 409 });
    expect(planMock).not.toHaveBeenCalled();
  });

  it('an expired READY intent does not block a new plan', async () => {
    const stale = { status: 'READY', expires_at: new Date(NOW.getTime() - 1000).toISOString() };
    expect((await create(fakeAdmin(stale).admin)).ok).toBe(true);
  });

  it('a plan that cannot be made is returned as is, nothing recorded', async () => {
    planMock.mockResolvedValue({ ok: false, status: 409, error: 'within threshold' });
    const { admin, inserted } = fakeAdmin(null);
    expect(await create(admin)).toEqual({ ok: false, status: 409, error: 'within threshold' });
    expect(inserted).toHaveLength(0);
  });

  it('the transaction is only shown while the intent can still be signed', () => {
    const base = { id: 'r', userId: 'u', walletAddress: '0x', bagId: 'b', targetVersion: 1, sells: [], buys: [], composerTransaction: { ...PLAN.transaction, approvals: [] }, txHash: null, failureCode: null, failureMessage: null, result: null, expiresAt: '', createdAt: '' };
    expect(publicRebalanceIntent({ ...base, status: 'SUBMITTED' }).composerTransaction).toBeNull();
  });
});
