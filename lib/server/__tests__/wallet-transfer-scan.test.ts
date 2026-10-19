import { beforeEach, describe, expect, it, vi } from 'vitest';

// The every-minute scan covers every holder: a wallet with an outgoing transfer of a tracked token after its last
// full check is re-read in full; every other covered wallet is verified at the latest block, and its row is
// rewritten (in one call for all of them) only once its recorded block is REMARK_AFTER_BLOCKS old.

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/wallet-reconciliation', () => ({ reconcileWallet: (...a: unknown[]) => reconcile(...a) }));

const { scanTrackedWalletTransfers, REMARK_AFTER_BLOCKS } = await import('../wallet-transfer-scan');

const TOKEN = '0x' + 'a'.repeat(40);
const OTHER_TOKEN = '0x' + 'b'.repeat(40);
const W = (n: number) => '0x' + String(n).repeat(40).slice(0, 40);
const asset = (address = TOKEN) => ({ chain: 'robinhood', address, decimals: 18 });

function admin(o: { users: { user_id: string; wallet_address: string; assets: unknown[] }[]; state: Record<string, number | null>; drift?: { id: string; user_id: string; status: string; confirms_record_id: string | null }[]; noBulk?: boolean }) {
  const marked: { user: string; block: number }[] = [];
  const db = {
    marked,
    calls: [] as string[],
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'wallet_reconciliation_due') return { data: o.users, error: null };
      if (name === 'mark_wallets_reconciled') {
        db.calls.push(name);
        if (o.noBulk) return { data: null, error: { message: 'Could not find the function public.mark_wallets_reconciled' } };
        for (const u of args.p_user_ids as string[]) marked.push({ user: u, block: args.p_block_number as number });
        return { data: (args.p_user_ids as string[]).length, error: null };
      }
      if (name === 'mark_wallet_reconciled') {
        db.calls.push(name);
        marked.push({ user: args.p_user_id as string, block: args.p_block_number as number });
        return { data: null, error: null };
      }
      throw new Error(name);
    }),
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: Object.entries(o.state).map(([user_id, last_block_number]) => ({ user_id, last_block_number })), error: null }),
        gte: async () => ({ data: table === 'reconciliation_records' ? (o.drift ?? []) : [], error: null }),
      }),
    }),
  };
  return db;
}

function client(latest: bigint, logs: { from: string; token: string; block: bigint }[], fail = false) {
  return {
    getBlockNumber: async () => latest,
    getLogs: vi.fn(async ({ args, fromBlock, toBlock, address }: { args: { from: string[] }; fromBlock: bigint; toBlock: bigint; address: string[] }) => {
      if (fail) throw new Error('rpc down');
      return logs
        .filter((l) => l.block >= fromBlock && l.block <= toBlock && args.from.map((a) => a.toLowerCase()).includes(l.from.toLowerCase()) && address.includes(l.token.toLowerCase()))
        .map((l) => ({ address: l.token, blockNumber: l.block, args: { from: l.from } }));
    }),
  } as never;
}

beforeEach(() => {
  reconcile.mockReset();
  reconcile.mockResolvedValue({});
});

describe('scanTrackedWalletTransfers', () => {
  it('re-reads only wallets that sent a tracked token after their last check; the rest are verified, old rows rewritten in one call', async () => {
    const db = admin({
      users: [
        { user_id: 'u1', wallet_address: W(1), assets: [asset()] },
        { user_id: 'u2', wallet_address: W(2), assets: [asset()] },
        { user_id: 'u3', wallet_address: W(3), assets: [asset()] },
      ],
      state: { u1: 10_000, u2: 10_000, u3: 15_000 },
    });
    const c = client(BigInt(20_000), [
      { from: W(1), token: TOKEN, block: BigInt(12_000) }, // after u1's check: re-read
      { from: W(3), token: TOKEN, block: BigInt(14_000) }, // before u3's check (15000): already covered
      { from: W(2), token: OTHER_TOKEN, block: BigInt(13_000) }, // not a token u2 holds through BAG
    ]);
    const r = await scanTrackedWalletTransfers(db as never, c);
    expect(reconcile.mock.calls.map((x) => (x[2] as { userId: string }).userId)).toEqual(['u1']);
    // u2's row is 10000 blocks old (>= REMARK_AFTER_BLOCKS): rewritten; u3's is 5000 old: verified, not rewritten.
    expect(REMARK_AFTER_BLOCKS).toBe(BigInt(7_200));
    expect(db.calls).toEqual(['mark_wallets_reconciled']);
    expect(db.marked).toEqual([{ user: 'u2', block: 20_000 }]);
    expect(r).toMatchObject({ wallets: 3, covered: 3, reconciled: 1, verified: 2, marked: 1, scannedFrom: '10001', scannedTo: '20000' });
  });

  it('a wallet never checked, or checked too long ago, is left to the full pass; an open drift is re-read to confirm it', async () => {
    const db = admin({
      users: [
        { user_id: 'new', wallet_address: W(4), assets: [asset()] },
        { user_id: 'old', wallet_address: W(5), assets: [asset()] },
        { user_id: 'drift', wallet_address: W(6), assets: [asset()] },
      ],
      state: { new: null, old: 1, drift: 900_000 },
      drift: [{ id: 'r1', user_id: 'drift', status: 'DRIFT', confirms_record_id: null }],
    });
    const r = await scanTrackedWalletTransfers(db as never, client(BigInt(900_100), []));
    expect(reconcile.mock.calls.map((x) => (x[2] as { userId: string }).userId)).toEqual(['drift']);
    expect(db.marked).toEqual([]);
    expect(r).toMatchObject({ covered: 1, deferred: 2, reconciled: 1, verified: 0 });
  });

  it('a resolved drift is not re-read; a failed log read marks nothing', async () => {
    const users = [{ user_id: 'u1', wallet_address: W(1), assets: [asset()] }];
    const resolved = admin({ users, state: { u1: 1000 }, drift: [{ id: 'r1', user_id: 'u1', status: 'DRIFT', confirms_record_id: null }, { id: 'r2', user_id: 'u1', status: 'RESOLVED', confirms_record_id: 'r1' }] });
    await scanTrackedWalletTransfers(resolved as never, client(BigInt(9000), []));
    expect(reconcile).not.toHaveBeenCalled();
    expect(resolved.marked).toEqual([{ user: 'u1', block: 9000 }]);

    const failing = admin({ users, state: { u1: 1000 } });
    await expect(scanTrackedWalletTransfers(failing as never, client(BigInt(2000), [], true))).rejects.toThrow('rpc down');
    expect(failing.marked).toEqual([]);
  });

  it('every minute with nothing moving: no writes at all until a row is REMARK_AFTER_BLOCKS old', async () => {
    const users = [
      { user_id: 'u1', wallet_address: W(1), assets: [asset()] },
      { user_id: 'u2', wallet_address: W(2), assets: [asset()] },
    ];
    const db = admin({ users, state: { u1: 100_000, u2: 100_000 } });
    const r = await scanTrackedWalletTransfers(db as never, client(BigInt(100_240), []));
    expect(db.calls).toEqual([]);
    expect(r).toMatchObject({ covered: 2, verified: 2, marked: 0 });
  });

  it('before migration 0060: falls back to one call per wallet', async () => {
    const users = [
      { user_id: 'u1', wallet_address: W(1), assets: [asset()] },
      { user_id: 'u2', wallet_address: W(2), assets: [asset()] },
    ];
    const db = admin({ users, state: { u1: 1000, u2: 1000 }, noBulk: true });
    const r = await scanTrackedWalletTransfers(db as never, client(BigInt(10_000), []));
    expect(db.calls).toEqual(['mark_wallets_reconciled', 'mark_wallet_reconciled', 'mark_wallet_reconciled']);
    expect(db.marked.map((m) => m.user)).toEqual(['u1', 'u2']);
    expect(r).toMatchObject({ verified: 2, marked: 2, failed: 0 });
  });
});
