import { beforeEach, describe, expect, it, vi } from 'vitest';

const trackComposerMock = vi.fn();
vi.mock('@/lib/server/rebalance-quote', () => ({ planRebalance: vi.fn() }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ findActiveRedeemIntentForBag: vi.fn() }));
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: (...a: unknown[]) => trackComposerMock(...a) }));
vi.mock('@/lib/blockchain/composer-tx-search', () => ({ findComposerTransactionFromWallet: vi.fn() }));

import { verifyRebalanceExecution } from '../rebalance-execution';

// M2 wiring (BAG_WALLET_BATCH_BINDING): a rebalance hands its stored approvals and its flow to the transaction
// verifier, and a refusal from the verifier (e.g. an exact-binding refusal) fails the rebalance without fills.

const WALLET = '0x1111111111111111111111111111111111111111';
const COMPOSER = '0x4444444444444444444444444444444444444444';
const SOLD = '0x6161616161616161616161616161616161616161';
const HASH = `0x${'ab'.repeat(32)}`;
const approvals = [{ token: SOLD, spender: COMPOSER, amountRaw: '1000' }];

const row = {
  id: 'rb_1', user_id: 'user_1', wallet_address: WALLET, bag_id: 'bag_1', target_version: 2, status: 'SUBMITTED',
  sells: [], buys: [], composer_transaction: { to: COMPOSER, data: '0xdeadbeef', value: '0', chainId: 4663, approvals },
  tx_hash: HASH, failure_code: null, failure_message: null, result: null,
  expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
};

const updates: Record<string, unknown>[] = [];
const admin = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
    update: (patch: Record<string, unknown>) => ({ eq: async () => { updates.push(patch); return { error: null }; } }),
  }),
};

beforeEach(() => {
  trackComposerMock.mockReset();
  updates.length = 0;
});

describe('verifyRebalanceExecution: exact-binding wiring', () => {
  it('hands the built approvals and the rebalance flow to the verifier', async () => {
    trackComposerMock.mockResolvedValue({ kind: 'PENDING' });
    await verifyRebalanceExecution(admin as never, { userId: 'user_1' }, 'rb_1');
    expect(trackComposerMock).toHaveBeenCalledTimes(1);
    expect(trackComposerMock.mock.calls[0][0]).toMatchObject({
      txHash: HASH, recipient: WALLET, expectedTransaction: row.composer_transaction, expectedApprovals: approvals, flow: 'rebalance',
    });
  });

  it('a verifier refusal fails the rebalance and records no fills', async () => {
    trackComposerMock.mockResolvedValue({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED', message: 'Reported transaction is not exactly the transaction built for this intent (UNEXPECTED_CALL): …' });
    const outcome = await verifyRebalanceExecution(admin as never, { userId: 'user_1' }, 'rb_1');
    expect(outcome).toMatchObject({ ok: true, intent: { status: 'FAILED', failureCode: 'VERIFICATION_FAILED' } });
    expect(updates).toEqual([expect.objectContaining({ status: 'FAILED', failure_code: 'VERIFICATION_FAILED' })]);
    expect(updates.some((u) => 'result' in u)).toBe(false);
  });
});
