import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, erc20Abi, keccak256, type Hex } from 'viem';
import { defaultRpcLogger, JsonRpcError, ResilientRpc, RpcLogger, RpcUnavailableError, TransactionBroadcastUnknownError } from '../resilient-rpc';
import { RpcEndpoint } from '../endpoints';
import { BAG_CHAINS } from '@/lib/config/chains';

// Scripted JSON-RPC endpoints (no network). Each endpoint maps a method to a
// result, a JSON-RPC error, an HTTP status or a hang (timeout).

type Reply = { result: unknown } | { error: { code: number; message: string } } | number | 'hang';
type Handler = (method: string, params: unknown[]) => Reply;

const EP: RpcEndpoint[] = [
  { tier: 'primary', provider: 'alchemy', url: 'https://robinhood-mainnet.g.alchemy.com/v2/SECRET' },
  { tier: 'secondary', provider: 'custom', url: 'https://secondary.example/key' },
  { tier: 'public', provider: 'public', url: 'https://rpc.mainnet.chain.robinhood.com' },
];

function setup(handlers: Handler[], opts: Partial<ConstructorParameters<typeof ResilientRpc>[0]> = {}) {
  let t = 0;
  const calls: { endpoint: number; method: string }[] = [];
  const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const logger: RpcLogger = (level, event, fields) => events.push({ level, event, fields });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const i = EP.findIndex((e) => e.url === url);
    const { method, params, id } = JSON.parse(init.body as string);
    calls.push({ endpoint: i, method });
    const r = handlers[i](method, params);
    if (r === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    if (typeof r === 'number') return new Response('upstream', { status: r });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...r }), { status: 200 });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const rpc = new ResilientRpc({
    chain: 'robinhood',
    endpoints: EP.slice(0, handlers.length),
    fetchImpl,
    timeoutMs: 20,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    logger,
    ...opts,
  });
  return { rpc, calls, events, sleeps, advance: (ms: number) => (t += ms) };
}
const ok = (result: unknown): Reply => ({ result });

describe('reads: failover, deterministic errors, bounded retry', () => {
  it('RPC connectivity: primary answers eth_chainId', async () => {
    const s = setup([() => ok('0x1237'), () => ok('0x0')]);
    expect(await s.rpc.request('eth_chainId')).toBe('0x1237');
    expect(s.calls).toEqual([{ endpoint: 0, method: 'eth_chainId' }]);
  });

  it.each([
    ['HTTP 503', 503 as Reply],
    ['HTTP 429', 429 as Reply],
    ['timeout', 'hang' as Reply],
    ['rate-limit JSON-RPC error', { error: { code: -32005, message: 'limit exceeded' } } as Reply],
    ['node behind', { error: { code: -32000, message: 'header not found' } } as Reply],
  ])('%s on primary → secondary answers', async (_l, failure) => {
    const s = setup([() => failure, () => ok('0x10')]);
    expect(await s.rpc.request('eth_blockNumber')).toBe('0x10');
    expect(s.calls.map((c) => c.endpoint)).toEqual([0, 1]);
    expect(s.events.find((e) => e.event === 'rpc.request.failed')?.fields.endpoint).toBe('https://robinhood-mainnet.g.alchemy.com/…'); // key redacted
  });

  it('a deterministic JSON-RPC error (revert) is returned immediately, no failover', async () => {
    const s = setup([() => ({ error: { code: 3, message: 'execution reverted' } }), () => ok('0x')]);
    await expect(s.rpc.request('eth_call', [{}])).rejects.toBeInstanceOf(JsonRpcError);
    expect(s.calls).toHaveLength(1);
  });

  it('bounded retry: maxRounds passes with exponential backoff, then RpcUnavailableError', async () => {
    const s = setup([() => 503, () => 'hang'], { maxRounds: 3, backoffBaseMs: 100 });
    await expect(s.rpc.request('eth_blockNumber')).rejects.toBeInstanceOf(RpcUnavailableError);
    expect(s.calls).toHaveLength(6);
    expect(s.sleeps).toEqual([100, 200]);
  });

  it('no endpoint configured → RpcUnavailableError without a request', async () => {
    const rpc = new ResilientRpc({ chain: 'ethereum', endpoints: [] });
    await expect(rpc.request('eth_chainId')).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});

describe('circuit breaker and health', () => {
  it('opens after N consecutive failures, skips the endpoint, probes again after cooldown', async () => {
    let primaryUp = false;
    const s = setup([() => (primaryUp ? ok('0x1') : 503), () => ok('0x2')], { circuitFailureThreshold: 2, circuitCooldownMs: 1000, maxRounds: 1 });
    await s.rpc.request('eth_blockNumber');
    await s.rpc.request('eth_blockNumber');
    expect(s.events.some((e) => e.event === 'rpc.circuit.open')).toBe(true);
    expect(s.rpc.healthSnapshot()[0].circuit).toBe('open');
    s.calls.length = 0;
    await s.rpc.request('eth_blockNumber');
    expect(s.calls.map((c) => c.endpoint)).toEqual([1]); // primary skipped
    s.advance(1001);
    primaryUp = true;
    s.calls.length = 0;
    expect(await s.rpc.request('eth_blockNumber')).toBe('0x1');
    expect(s.calls.map((c) => c.endpoint)).toEqual([0]);
    expect(s.rpc.healthSnapshot()[0]).toMatchObject({ circuit: 'closed', consecutiveFailures: 0, url: 'https://robinhood-mainnet.g.alchemy.com/…' });
  });

  it('stale RPC detection: an endpoint far behind the best block is demoted', async () => {
    let primaryFails = true;
    const s = setup([() => (primaryFails ? 503 : ok('0x64')), () => ok('0x3e8')], { staleBlockLag: 20 }); // 100 vs 1000
    await s.rpc.request('eth_blockNumber'); // primary 503 → secondary reports 1000
    primaryFails = false;
    await s.rpc.request('eth_blockNumber'); // primary answers 100 → stale
    expect(s.rpc.healthSnapshot().map((h) => h.stale)).toEqual([true, false]);
    expect(s.events.some((e) => e.event === 'rpc.endpoint.stale')).toBe(true);
    s.calls.length = 0;
    await s.rpc.request('eth_getBalance', ['0x0', 'latest']);
    expect(s.calls[0].endpoint).toBe(1); // fresh endpoint first
  });
});

describe('transactions: never blindly re-broadcast', () => {
  const RAW = '0x02f86b8212378001018252089400000000000000000000000000000000000000000180c0' as Hex;
  const HASH = keccak256(RAW);

  it('primary accepts → hash returned, sent once', async () => {
    const s = setup([() => ok(HASH), () => ok(HASH)]);
    expect(await s.rpc.request('eth_sendRawTransaction', [RAW])).toBe(HASH);
    expect(s.calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('primary times out but the tx is found by hash → NOT sent again', async () => {
    const s = setup([(m) => (m === 'eth_sendRawTransaction' ? 'hang' : ok({ hash: HASH })), () => ok(HASH)]);
    expect(await s.rpc.request('eth_sendRawTransaction', [RAW])).toBe(HASH);
    expect(s.calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(s.events.some((e) => e.event === 'rpc.tx.found_after_error')).toBe(true);
  });

  it('primary fails and no node knows the hash → secondary, hash checked again before the final fallback', async () => {
    const s = setup([
      (m) => (m === 'eth_sendRawTransaction' ? 503 : ok(null)),
      (m) => (m === 'eth_sendRawTransaction' ? 'hang' : ok(null)),
      (m) => (m === 'eth_sendRawTransaction' ? ok(HASH) : ok(null)),
    ]);
    expect(await s.rpc.request('eth_sendRawTransaction', [RAW])).toBe(HASH);
    const seq = s.calls.map((c) => `${c.endpoint}:${c.method === 'eth_sendRawTransaction' ? 'send' : 'lookup'}`);
    expect(seq).toEqual(['0:send', '0:lookup', '1:lookup', '2:lookup', '1:send', '0:lookup', '1:lookup', '2:lookup', '2:send']);
  });

  it('"already known" means accepted', async () => {
    const s = setup([() => ({ error: { code: -32000, message: 'already known' } })]);
    expect(await s.rpc.request('eth_sendRawTransaction', [RAW])).toBe(HASH);
  });

  it('"nonce too low" + found by hash → our tx was already mined', async () => {
    const s = setup([(m) => (m === 'eth_sendRawTransaction' ? { error: { code: -32000, message: 'nonce too low' } } : ok({ hash: HASH }))]);
    expect(await s.rpc.request('eth_sendRawTransaction', [RAW])).toBe(HASH);
  });

  it('a deterministic rejection (insufficient funds) is thrown, not sent elsewhere', async () => {
    const s = setup([() => ({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } }), () => ok(HASH)]);
    await expect(s.rpc.request('eth_sendRawTransaction', [RAW])).rejects.toBeInstanceOf(JsonRpcError);
    expect(s.calls.every((c) => c.endpoint === 0)).toBe(true);
  });

  it('every endpoint ambiguous → TransactionBroadcastUnknownError carrying the hash', async () => {
    const s = setup([() => 503, () => 'hang']);
    const err = (await s.rpc.request('eth_sendRawTransaction', [RAW]).catch((e) => e)) as TransactionBroadcastUnknownError;
    expect(err).toBeInstanceOf(TransactionBroadcastUnknownError);
    expect(err.txHash).toBe(HASH);
  });
});

describe('viem PublicClient over the resilient transport (balances, calls, allowance, logs, receipts)', () => {
  const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const OWNER = '0x000000000000000000000000000000000000dEaD';
  const TXH = `0x${'ab'.repeat(32)}` as Hex;
  const handler: Handler = (method, params) => {
    switch (method) {
      case 'eth_chainId':
        return ok('0x1237');
      case 'eth_blockNumber':
        return ok('0x2a');
      case 'eth_getBalance':
        return ok('0xde0b6b3a7640000'); // 1 ETH
      case 'eth_call': {
        const data = (params[0] as { data: string }).data;
        const amount = data.startsWith('0x70a08231') ? BigInt(1_500_000) : BigInt(42); // balanceOf vs allowance
        return ok(encodeAbiParameters([{ type: 'uint256' }], [amount]));
      }
      case 'eth_getLogs':
        return ok([{ address: TOKEN, topics: [], data: '0x', blockNumber: '0x2a', transactionHash: TXH, transactionIndex: '0x0', blockHash: TXH, logIndex: '0x0', removed: false }]);
      case 'eth_getTransactionReceipt':
        return ok({ blockHash: TXH, blockNumber: '0x2a', contractAddress: null, cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', from: OWNER, gasUsed: '0x5208', logs: [], logsBloom: `0x${'0'.repeat(512)}`, status: '0x1', to: TOKEN, transactionHash: TXH, transactionIndex: '0x0', type: '0x2' });
      case 'eth_estimateGas':
        return ok('0x5208');
      default:
        return { error: { code: -32601, message: 'method not found' } };
    }
  };

  it('primary down: every read transparently served by the secondary', async () => {
    const s = setup([() => 503, handler], { circuitFailureThreshold: 100 });
    const client = createPublicClient({ chain: BAG_CHAINS.robinhood.viemChain, transport: custom({ request: ({ method, params }) => s.rpc.request(method, params) }, { retryCount: 0 }) });
    expect(await client.getChainId()).toBe(4663);
    expect(await client.getBlockNumber()).toBe(BigInt(42));
    expect(await client.getBalance({ address: OWNER })).toBe(BigInt('1000000000000000000'));
    expect(await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [OWNER] })).toBe(BigInt(1_500_000));
    expect(await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'allowance', args: [OWNER, TOKEN] })).toBe(BigInt(42));
    expect(await client.estimateGas({ account: OWNER, to: TOKEN })).toBe(BigInt(21000));
    expect((await client.getLogs({ address: TOKEN, fromBlock: BigInt(1), toBlock: BigInt(42) }))[0].transactionHash).toBe(TXH);
    expect((await client.getTransactionReceipt({ hash: TXH })).status).toBe('success');
  });
});

it('the default logger writes warnings only, as JSON', () => {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  defaultRpcLogger('info', 'rpc.tx.sent', { chain: 'x' });
  defaultRpcLogger('warn', 'rpc.request.failed', { chain: 'x' });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ level: 'warn', event: 'rpc.request.failed', chain: 'x' });
  spy.mockRestore();
});
