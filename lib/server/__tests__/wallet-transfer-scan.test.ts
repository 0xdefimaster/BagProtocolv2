import { beforeEach, describe, expect, it, vi } from 'vitest';

// The 5-minute scan covers every holder: a wallet with an outgoing transfer of a tracked token after its last full
// check is re-read in full; every other covered wallet is marked verified at the latest block.

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/wallet-reconciliation', () => ({ reconcileWallet: (...a: unknown[]) => reconcile(...a) }));

const { scanTrackedWalletTransfers } = await import('../wallet-transfer-scan');

const TOKEN = '0x' + 'a'.repeat(40);
const OTHER_TOKEN = '0x' + 'b'.repeat(40);
const W = (n: number) => '0x' + String(n).repeat(40).slice(0, 40);
const asset = (address = TOKEN) => ({ chain: 'robinhood', address, decimals: 18 });

function admin(o: { users: { user_id: string; wallet_address: string; assets: unknown[] }[]; state: Record<string, number | null>; drift?: { id: string; user_id: string; status: string; confirms_record_id: string | null }[] }) {
  const marked: { user: string; block: number }[] = [];
  const db = {
    marked,
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'wallet_reconciliation_due') return { data: o.users, error: null };
      if (name === 'mark_wallet_reconciled') {
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
  it('re-reads only wallets that sent a tracked token after their last check; marks the rest verified at the latest block', async () => {
    const db = admin({
      users: [
        { user_id: 'u1', wallet_address: W(1), assets: [asset()] },
        { user_id: 'u2', wallet_address: W(2), assets: [asset()] },
        { user_id: 'u3', wallet_address: W(3), assets: [asset()] },
      ],
      state: { u1: 1000, u2: 1000, u3: 1500 },
    });
    const c = client(BigInt(2000), [
      { from: W(1), token: TOKEN, block: BigInt(1200) }, // after u1's check: re-read
      { from: W(3), token: TOKEN, block: BigInt(1400) }, // before u3's check (1500): already covered
      { from: W(2), token: OTHER_TOKEN, block: BigInt(1300) }, // not a token u2 holds through BAG
    ]);
    const r = await scanTrackedWalletTransfers(db as never, c);
    expect(reconcile.mock.calls.map((x) => (x[2] as { userId: string }).userId)).toEqual(['u1']);
    expect(db.marked).toEqual([
      { user: 'u2', block: 2000 },
      { user: 'u3', block: 2000 },
    ]);
    expect(r).toMatchObject({ wallets: 3, covered: 3, reconciled: 1, verified: 2, scannedFrom: '1001', scannedTo: '2000' });
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
    await scanTrackedWalletTransfers(resolved as never, client(BigInt(2000), []));
    expect(reconcile).not.toHaveBeenCalled();
    expect(resolved.marked).toEqual([{ user: 'u1', block: 2000 }]);

    const failing = admin({ users, state: { u1: 1000 } });
    await expect(scanTrackedWalletTransfers(failing as never, client(BigInt(2000), [], true))).rejects.toThrow('rpc down');
    expect(failing.marked).toEqual([]);
  });
});
