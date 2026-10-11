import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileWallet = vi.fn();
const trackedAssets = vi.fn();
const reconcileDue = vi.fn();
const usersIn = vi.fn();
const transferScan = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ in: (_c: string, v: string[]) => usersIn(v) }) }) }),
}));
vi.mock('@/lib/blockchain/robinhood-public-client', () => ({ getRobinhoodPublicClient: () => ({}) }));
vi.mock('@/lib/server/wallet-reconciliation', () => ({
  reconcileWallet: (...a: unknown[]) => reconcileWallet(...a),
  trackedAssetsForUser: (...a: unknown[]) => trackedAssets(...a),
  reconcileDueWallets: (...a: unknown[]) => reconcileDue(...a),
}));

vi.mock('@/lib/server/wallet-transfer-scan', () => ({ scanTrackedWalletTransfers: (...a: unknown[]) => transferScan(...a) }));

import { POST as webhook } from '@/app/api/webhooks/alchemy/address-activity/route';
import { POST as cron } from '@/app/api/cron/reconcile-wallets/route';

const KEY = 'whsec_k';
const A = '0x49da000000000000000000000000000000000001';
const body = JSON.stringify({ type: 'ADDRESS_ACTIVITY', event: { network: 'ROBINHOOD_MAINNET', activity: [{ fromAddress: A, toAddress: '0x' + 'f'.repeat(40), value: 1e9 }] } });
const req = (b: string, sig?: string) => new Request('http://x', { method: 'POST', body: b, headers: sig ? { 'x-alchemy-signature': sig } : {} }) as never;
const sign = (b: string) => createHmac('sha256', KEY).update(b).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ALCHEMY_WEBHOOK_SIGNING_KEY', KEY);
  vi.stubEnv('CRON_SECRET', 'a-long-enough-cron-secret-value-123456');
  usersIn.mockResolvedValue({ data: [{ id: 'u1', wallet_address: A }], error: null });
  trackedAssets.mockResolvedValue([{ chain: 'robinhood', address: '0x' + 'a'.repeat(40), decimals: 18 }]);
  reconcileWallet.mockResolvedValue({});
  reconcileDue.mockResolvedValue({ checked: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/webhooks/alchemy/address-activity', () => {
  it('fails closed without a signing key, and rejects a bad signature', async () => {
    vi.stubEnv('ALCHEMY_WEBHOOK_SIGNING_KEY', '');
    expect((await webhook(req(body, sign(body)))).status).toBe(503);
    vi.stubEnv('ALCHEMY_WEBHOOK_SIGNING_KEY', KEY);
    expect((await webhook(req(body, 'f'.repeat(64)))).status).toBe(401);
    expect((await webhook(req(body))).status).toBe(401);
    expect(reconcileWallet).not.toHaveBeenCalled();
  });

  it('re-checks only known users, reading balances itself (payload amounts are never passed on)', async () => {
    const res = await webhook(req(body, sign(body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reconciled: 1 });
    expect(usersIn).toHaveBeenCalledWith(expect.arrayContaining([A]));
    expect(reconcileWallet.mock.calls[0][2]).toEqual({ userId: 'u1', walletAddress: A, assets: [{ chain: 'robinhood', address: '0x' + 'a'.repeat(40), decimals: 18 }] });
  });

  it('a failing reconciliation does not fail the delivery (the 5-minute pass retries)', async () => {
    reconcileWallet.mockRejectedValue(new Error('rpc down'));
    const res = await webhook(req(body, sign(body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reconciled: 0 });
  });
});

describe('POST /api/cron/reconcile-wallets', () => {
  it('requires the cron secret', async () => {
    expect((await cron(new Request('http://x', { method: 'POST' }) as never)).status).toBe(401);
    const ok = await cron(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer a-long-enough-cron-secret-value-123456' } }) as never);
    expect(ok.status).toBe(200);
    // Every holder through Transfer logs first, then a few wallets in full.
    expect(transferScan).toHaveBeenCalled();
    expect(reconcileDue).toHaveBeenCalledWith(expect.anything(), expect.anything(), 5);
  });
});
