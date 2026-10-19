import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileSpy = vi.fn();
vi.mock('@/lib/server/wallet-balances', () => ({ readBalancesAtBlock: vi.fn() }));
vi.mock('@/lib/server/redeem-execution', () => ({ verifyRedeemExecution: vi.fn() }));
vi.mock('@/lib/server/purchase-execution', () => ({ settleUnsettledPurchasesForUser: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ listUnsettledRedeemIntentsForUser: vi.fn(async () => []) }));
vi.mock('@/lib/server/bag-nav-snapshots', () => ({ recordNavSnapshot: vi.fn() }));

import { readBalancesAtBlock } from '@/lib/server/wallet-balances';
import { RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS, RECONCILE_ON_CONNECT_MIN_INTERVAL_MS, reconcileWalletOnConnect } from '@/lib/server/wallet-reconciliation';

// The on-connect check: one wallet, at most once per interval, nothing read when BAG tracks nothing for it.

const NOW = Date.parse('2026-10-12T12:00:00Z');
const TOKEN = '0x' + 'a'.repeat(40);

function fakeAdmin(opts: { lastCheckedAt: string | null; holdings: { quantity_raw: string }[] }) {
  const rpc = vi.fn(async (name: string) => {
    reconcileSpy(name);
    return { data: name === 'apply_wallet_observation' ? { status: 'OK' } : null, error: null };
  });
  const from = (table: string) => ({
    select: () => ({
      eq: () =>
        table === 'wallet_reconciliation_state'
          ? { maybeSingle: async () => ({ data: opts.lastCheckedAt ? { last_checked_at: opts.lastCheckedAt } : null, error: null }) }
          : Promise.resolve({
              data: opts.holdings.map((h) => ({ chain: 'robinhood', address: TOKEN, decimals: 18, quantity_raw: h.quantity_raw })),
              error: null,
            }),
    }),
  });
  return { from, rpc } as never;
}

const client = { getBlockNumber: vi.fn(async () => BigInt(123)) } as never;
const session = { userId: 'u1', walletAddress: '0x' + 'b'.repeat(40) };

beforeEach(() => {
  reconcileSpy.mockReset();
  vi.mocked(readBalancesAtBlock).mockReset().mockResolvedValue([BigInt(5)]);
});

describe('reconcileWalletOnConnect', () => {
  it('checks the wallet when its last check is older than the interval (or never happened)', async () => {
    for (const lastCheckedAt of [null, new Date(NOW - RECONCILE_ON_CONNECT_MIN_INTERVAL_MS).toISOString()]) {
      reconcileSpy.mockReset();
      const out = await reconcileWalletOnConnect(fakeAdmin({ lastCheckedAt, holdings: [{ quantity_raw: '5' }] }), client, session, NOW);
      expect(out).toEqual({ status: 'checked', blockNumber: '123' });
      expect(reconcileSpy).toHaveBeenCalledWith('apply_wallet_observation');
      expect(reconcileSpy).toHaveBeenCalledWith('mark_wallet_reconciled');
    }
  });

  it('reuses a check from the last few minutes without reading the chain', async () => {
    const out = await reconcileWalletOnConnect(
      fakeAdmin({ lastCheckedAt: new Date(NOW - 60_000).toISOString(), holdings: [{ quantity_raw: '5' }] }),
      client,
      session,
      NOW
    );
    expect(out).toEqual({ status: 'recent' });
    expect(readBalancesAtBlock).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('reads nothing when BAG tracks nothing for the wallet', async () => {
    const out = await reconcileWalletOnConnect(fakeAdmin({ lastCheckedAt: null, holdings: [{ quantity_raw: '0' }] }), client, session, NOW);
    expect(out).toEqual({ status: 'nothing-tracked' });
    expect(readBalancesAtBlock).not.toHaveBeenCalled();
  });

  it('after a trade a shorter interval applies: a check from a minute ago is not reused', async () => {
    const admin = fakeAdmin({ lastCheckedAt: new Date(NOW - 60_000).toISOString(), holdings: [{ quantity_raw: '5' }] });
    expect(await reconcileWalletOnConnect(admin, client, session, NOW, RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS)).toEqual({ status: 'checked', blockNumber: '123' });
    const fresh = fakeAdmin({ lastCheckedAt: new Date(NOW - 10_000).toISOString(), holdings: [{ quantity_raw: '5' }] });
    expect(await reconcileWalletOnConnect(fresh, client, session, NOW, RECONCILE_AFTER_TRADE_MIN_INTERVAL_MS)).toEqual({ status: 'recent' });
  });
});
