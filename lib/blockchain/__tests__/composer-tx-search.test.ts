import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi } from 'viem';
import { COMPOSER_SEARCH_CHUNK_BLOCKS, findComposerTransactionFromWallet, findTokenSaleTransactionFromWallet } from '../composer-tx-search';

const WALLET = '0x1111111111111111111111111111111111111111';
const VM = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const expected = { to: VM, data: '0xdeadbeef', value: '0' };
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;

/** A chain where block N has timestamp 1000 + N. */
function fakeClient(opts: {
  latest?: bigint;
  pending?: number;
  mined?: number;
  logs?: { block: bigint; hash: `0x${string}`; value?: bigint }[];
  txs?: Record<string, { from: string; to: string | null; input: string; value: bigint }>;
  failLogs?: boolean;
}) {
  const latest = opts.latest ?? BigInt(50_000);
  const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
    if (opts.failLogs) throw new Error('rpc down');
    return (opts.logs ?? []).filter((l) => l.block >= fromBlock && l.block <= toBlock).map((l) => ({ transactionHash: l.hash, args: { value: l.value } }));
  });
  return {
    getLogs,
    client: {
      getBlockNumber: async () => latest,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(1000) + blockNumber }),
      getLogs,
      getTransaction: async ({ hash }: { hash: string }) => opts.txs?.[hash] ?? { from: WALLET, to: '0xother', input: '0x', value: BigInt(0) },
      getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === 'pending' ? (opts.pending ?? 5) : (opts.mined ?? 5)),
    } as never,
  };
}
// Intent created at block 20_000 (timestamp 21_000).
const since = new Date(21_000 * 1000);
const run = (client: never) => findComposerTransactionFromWallet({ chain: 'robinhood', wallet: WALLET, soldTokens: [TOKEN], expected, since, client });

describe('findComposerTransactionFromWallet', () => {
  it('finds the exact built transaction among the wallet’s outgoing transfers after the intent was created', async () => {
    const { client } = fakeClient({
      logs: [
        { block: BigInt(20_500), hash: h(1) }, // some other transfer from the wallet
        { block: BigInt(31_000), hash: h(2) }, // the sale, in the second chunk
      ],
      txs: { [h(2)]: { from: WALLET.toUpperCase().replace('0X', '0x'), to: VM, input: '0xDEADBEEF', value: BigInt(0) } },
    });
    expect(await run(client)).toEqual({ kind: 'FOUND', txHash: h(2) });
  });

  it('starts at the intent’s creation block: an identical transaction before it is not this intent’s', async () => {
    const { client, getLogs } = fakeClient({
      logs: [{ block: BigInt(19_999), hash: h(3) }],
      txs: { [h(3)]: { from: WALLET, to: VM, input: '0xdeadbeef', value: BigInt(0) } },
    });
    expect(await run(client)).toEqual({ kind: 'NOT_FOUND' });
    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: BigInt(20_000), args: { from: WALLET }, address: [TOKEN] });
    expect(getLogs.mock.calls[0][0].toBlock - getLogs.mock.calls[0][0].fromBlock + BigInt(1)).toBe(COMPOSER_SEARCH_CHUNK_BLOCKS);
  });

  it('a transaction to the same target with different calldata or value does not count', async () => {
    const { client } = fakeClient({
      logs: [{ block: BigInt(20_100), hash: h(4) }, { block: BigInt(20_200), hash: h(5) }],
      txs: {
        [h(4)]: { from: WALLET, to: VM, input: '0xcafe', value: BigInt(0) },
        [h(5)]: { from: WALLET, to: VM, input: '0xdeadbeef', value: BigInt(1) },
      },
    });
    expect(await run(client)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('finds a wallet batch (the wallet calling itself) that carries the exact built call; a batch without it does not count', async () => {
    const batch = (data: `0x${string}`) =>
      encodeFunctionData({ abi: parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']), functionName: 'executeBatch', args: [[{ target: VM, value: BigInt(0), data }]] });
    const { client } = fakeClient({
      logs: [{ block: BigInt(20_100), hash: h(6) }, { block: BigInt(20_200), hash: h(7) }],
      txs: {
        [h(6)]: { from: WALLET, to: WALLET, input: batch('0xcafebabe'), value: BigInt(0) },
        [h(7)]: { from: WALLET, to: WALLET, input: batch('0xdeadbeef'), value: BigInt(0) },
      },
    });
    expect(await run(client)).toEqual({ kind: 'FOUND', txHash: h(7) });
  });

  it('finds the wallet\'s redeemDelegations transaction (MetaMask smart account) carrying the exact built call; another wallet\'s does not count', async () => {
    const redeem = (data: `0x${string}`) =>
      encodeFunctionData({
        abi: parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']),
        functionName: 'redeemDelegations',
        args: [['0x'], [pad('0x01', { dir: 'right', size: 32 })], [encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }], [[[VM, BigInt(0), data]]])]],
      });
    const DELEGATION_MANAGER = '0xdb9b1e94b5b69df7e401ddbede43491141047db3';
    const { client } = fakeClient({
      logs: [{ block: BigInt(20_100), hash: h(6) }, { block: BigInt(20_200), hash: h(7) }],
      txs: {
        [h(6)]: { from: '0x9999999999999999999999999999999999999999', to: DELEGATION_MANAGER, input: redeem('0xdeadbeef'), value: BigInt(0) },
        [h(7)]: { from: WALLET, to: DELEGATION_MANAGER, input: redeem('0xdeadbeef'), value: BigInt(0) },
      },
    });
    expect(await run(client)).toEqual({ kind: 'FOUND', txHash: h(7) });
  });

  it('a wallet transaction still pending: UNKNOWN (it could be this sale), nothing searched', async () => {
    const { client, getLogs } = fakeClient({ pending: 6, mined: 5 });
    expect((await run(client)).kind).toBe('UNKNOWN');
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('an RPC failure: UNKNOWN, never NOT_FOUND', async () => {
    const { client } = fakeClient({ failLogs: true });
    expect(await run(client)).toEqual({ kind: 'UNKNOWN', reason: 'rpc down' });
  });

  it('nothing to search by: UNKNOWN', async () => {
    const { client } = fakeClient({});
    expect((await findComposerTransactionFromWallet({ chain: 'robinhood', wallet: WALLET, soldTokens: [], expected, since, client })).kind).toBe('UNKNOWN');
  });
});

describe('findTokenSaleTransactionFromWallet (a per-asset swap whose report was lost)', () => {
  const find = (client: never, extra: { exclude?: string[] } = {}) =>
    findTokenSaleTransactionFromWallet({ chain: 'robinhood', wallet: WALLET, token: TOKEN, amountRaw: '500', since, client, ...extra });

  it('finds the wallet\'s own transaction that moved exactly the sold amount; other amounts and other senders do not count', async () => {
    const { client } = fakeClient({
      logs: [
        { block: BigInt(20_100), hash: h(1), value: BigInt(499) },
        { block: BigInt(20_200), hash: h(2), value: BigInt(500) },
        { block: BigInt(20_300), hash: h(3), value: BigInt(500) },
      ],
      txs: {
        [h(2)]: { from: '0x9999999999999999999999999999999999999999', to: VM, input: '0x', value: BigInt(0) },
        [h(3)]: { from: WALLET, to: '0xdb9b1e94b5b69df7e401ddbede43491141047db3', input: '0xcef6d209', value: BigInt(0) },
      },
    });
    expect(await find(client)).toEqual({ kind: 'FOUND', txHash: h(3) });
  });

  it('a hash already attributed to another step is skipped', async () => {
    const { client } = fakeClient({ logs: [{ block: BigInt(20_100), hash: h(4), value: BigInt(500) }], txs: { [h(4)]: { from: WALLET, to: VM, input: '0x', value: BigInt(0) } } });
    expect(await find(client, { exclude: [h(4)] })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('a pending wallet transaction or an RPC failure is UNKNOWN, never NOT_FOUND', async () => {
    expect((await find(fakeClient({ pending: 6, mined: 5 }).client)).kind).toBe('UNKNOWN');
    expect((await find(fakeClient({ failLogs: true }).client)).kind).toBe('UNKNOWN');
  });
});
