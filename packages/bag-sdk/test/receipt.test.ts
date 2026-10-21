import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import {
  compileBag, parseBag, verifyPurchaseReceipt, NATIVE_TOKEN,
  type Hex, type PurchaseReceiptClient, type PurchaseReceiptLog,
  type PurchaseReceiptTransaction, type PurchaseTransactionReceipt,
} from '../src';
import { externalBag } from './helpers';

const hex = (digit: string, length: number) => ('0x' + digit.repeat(length)) as Hex;
const SIGNER = hex('5', 40);
const ROUTER = hex('7', 40);
const INPUT = hex('c', 40);
const OTHER = hex('9', 40);
const HASH = hex('1', 64);
const BLOCK = hex('2', 64);
const EVENT = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const word = (address: Hex) => ('0x' + address.slice(2).padStart(64, '0')) as Hex;

function transfer(token: Hex, amount: bigint, index: number, from = ROUTER, to = SIGNER): PurchaseReceiptLog {
  return {
    address: token, topics: [EVENT, word(from), word(to)],
    data: ('0x' + amount.toString(16).padStart(64, '0')) as Hex,
    logIndex: index, transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), removed: false,
  };
}

async function setup(native = false, kept = false) {
  const raw = externalBag();
  if (kept) { raw.definition.assets[0].address = INPUT; delete raw.metadata; }
  const parsed = parseBag(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const compiled = await compileBag(parsed.bag, {
    inputToken: native ? NATIVE_TOKEN : INPUT, amountRaw: BigInt(10_000_000), inputTokenDecimals: 6, signer: SIGNER,
  }, {
    provider: {
      name: 'fixture',
      async compile(request) {
        return {
          transaction: { to: ROUTER, data: '0x12345678', value: native ? String(request.amountRaw) : '0', chainId: request.chainId },
          executor: null, approvals: [], priceImpactBps: 1, gasLimit: null, fees: [],
          legs: request.legs.map(leg => ({ token: leg.token, expectedOutRaw: '1000', minOutRaw: '990' })),
        };
      },
    },
    trust: { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] },
  });
  const minimumReceived = compiled.quote.plan.legs.map(leg => ({ token: leg.token, amountRaw: BigInt(80) }));
  const transaction: PurchaseReceiptTransaction = {
    hash: HASH, from: SIGNER, to: ROUTER, input: compiled.transaction.data,
    value: compiled.transaction.value, chainId: 4663, blockHash: BLOCK, blockNumber: BigInt(10),
  };
  const receipt: PurchaseTransactionReceipt = {
    transactionHash: HASH, from: SIGNER, to: ROUTER, blockHash: BLOCK, blockNumber: BigInt(10), status: 'success',
    logs: minimumReceived.map((output, i) => transfer(output.token as Hex, BigInt(100), i)),
  };
  const client = {
    getChainId: vi.fn(async () => 4663),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: BLOCK })),
    getBlockNumber: vi.fn(async () => BigInt(12)),
  } satisfies PurchaseReceiptClient;
  const run = (overrides: Partial<Parameters<typeof verifyPurchaseReceipt>[1]> = {}) =>
    verifyPurchaseReceipt(compiled, { client, transactionHash: HASH, minimumReceived, ...overrides });
  return { compiled, transaction, receipt, client, minimumReceived, run };
}

describe('verifyPurchaseReceipt', () => {
  it('binds the direct call and reports net event delivery against caller wallet minimums, not the provider floor', async () => {
    const f = await setup();
    const result = await f.run({ confirmations: 3 });
    expect(result.status).toBe('VERIFIED');
    expect(result.confirmations).toBe(BigInt(3));
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs.every(output => output.netReceivedRaw === BigInt(100) && output.minimumRaw === BigInt(80))).toBe(true);
    expect(result.evidence).toBe('TRANSACTION_AND_TRANSFER_LOGS');
    expect(result.accounting).toBe('NOT_BAG_ACCOUNTED');
    expect(f.compiled.quote.legs[0].minOutRaw).toBe('990');
    expect(f.client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });

  it('sums multiple transfers, subtracts outgoing transfers and cancels self-transfers', async () => {
    const f = await setup();
    const token = f.minimumReceived[0].token as Hex;
    f.receipt.logs = [
      transfer(token, BigInt(60), 0), transfer(token, BigInt(40), 1), transfer(token, BigInt(20), 2, SIGNER, OTHER),
      transfer(token, BigInt(999), 3, SIGNER, SIGNER), transfer(f.minimumReceived[1].token as Hex, BigInt(100), 4),
    ];
    const result = await f.run();
    expect(result.status).toBe('VERIFIED');
    expect(result.outputs[0]).toMatchObject({ receivedRaw: BigInt(1099), sentRaw: BigInt(1019), netReceivedRaw: BigInt(80) });
    f.receipt.logs = [...f.receipt.logs, transfer(token, BigInt(1), 5, SIGNER, OTHER)];
    expect((await f.run()).status).toBe('FAILED');
  });

  it.each(['missing', 'wrong recipient', 'wrong emitter', 'zero'] as const)('rejects %s delivery', async (kind) => {
    const f = await setup();
    const token = f.minimumReceived[0].token as Hex;
    const first = transfer(kind === 'wrong emitter' ? OTHER : token, kind === 'zero' ? BigInt(0) : BigInt(100), 0, ROUTER, kind === 'wrong recipient' ? OTHER : SIGNER);
    f.receipt.logs = [...(kind === 'missing' ? [] : [first]), transfer(f.minimumReceived[1].token as Hex, BigInt(100), 1)];
    const result = await f.run();
    expect(result.status).toBe('FAILED');
    expect(result.issues[0].code).toBe('OUTPUT_BELOW_MINIMUM');
    expect(result.outputs[0].satisfied).toBe(false);
  });

  it('stops at a wrong RPC chain before reading transaction evidence', async () => {
    const f = await setup(); f.client.getChainId.mockResolvedValue(1);
    expect((await f.run()).issues[0].code).toBe('RPC_CHAIN_MISMATCH');
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it.each(['hash', 'from', 'input', 'value', 'chainId'] as const)('rejects mismatched transaction %s', async (field) => {
    const f = await setup();
    if (field === 'value') f.transaction[field] = BigInt(99);
    else if (field === 'chainId') f.transaction.chainId = 1;
    else f.transaction[field] = field === 'input' ? '0xabcdef12' : field === 'from' ? OTHER : hex('f', 64);
    expect((await f.run()).status).toBe('FAILED');
  });

  it('does not infer batch execution from embedded expected calldata', async () => {
    const f = await setup();
    f.transaction.to = SIGNER; f.receipt.to = SIGNER;
    f.transaction.input = ('0x12345678' + ROUTER.slice(2) + f.compiled.transaction.data.slice(2)) as Hex;
    const result = await f.run();
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('UNSUPPORTED_TRANSACTION_ENVELOPE');
  });

  it('distinguishes missing receipts from RPC failures without leaking endpoint details', async () => {
    const f = await setup();
    f.client.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' }));
    expect((await f.run()).issues[0].code).toBe('NOT_MINED');
    f.client.getTransactionReceipt.mockRejectedValue(new Error('secret signed RPC URL'));
    const result = await f.run();
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('RPC_ERROR');
    expect(JSON.stringify(result.issues)).not.toContain('secret');
  });

  it('checks canonical block hash, fresh depth and a reverted outcome', async () => {
    const f = await setup();
    f.transaction.blockHash = hex('f', 64);
    expect((await f.run()).issues[0].code).toBe('NON_CANONICAL_RECEIPT');
    f.transaction.blockHash = BLOCK;
    f.client.getBlock.mockResolvedValue({ hash: hex('f', 64) });
    expect((await f.run()).issues[0].code).toBe('NON_CANONICAL_RECEIPT');
    f.client.getBlock.mockResolvedValue({ hash: BLOCK });
    expect((await f.run({ confirmations: 4 })).issues[0].code).toBe('INSUFFICIENT_CONFIRMATIONS');
    f.client.getBlockNumber.mockResolvedValue(BigInt(9));
    expect((await f.run()).issues[0].code).toBe('NON_CANONICAL_RECEIPT');
    f.client.getBlockNumber.mockResolvedValue(BigInt(12));
    f.receipt.status = 'reverted';
    expect((await f.run()).issues[0].code).toBe('TRANSACTION_REVERTED');
  });

  it.each(['duplicate', 'removed', 'transactionHash', 'blockHash', 'blockNumber', 'topic', 'data', 'nft'] as const)('does not trust %s log evidence', async (kind) => {
    const f = await setup();
    const log = { ...f.receipt.logs[0], topics: [...f.receipt.logs[0].topics] };
    if (kind === 'duplicate') f.receipt.logs = [...f.receipt.logs, { ...log }];
    else {
      if (kind === 'removed') log.removed = true;
      if (kind === 'transactionHash' || kind === 'blockHash') log[kind] = hex('f', 64);
      if (kind === 'blockNumber') log.blockNumber = BigInt(99);
      if (kind === 'topic') log.topics[1] = hex('f', 64);
      if (kind === 'data') log.data = '0x01';
      if (kind === 'nft') log.topics.push(hex('0', 64));
      f.receipt.logs = [log, f.receipt.logs[1]];
    }
    const result = await f.run();
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('INVALID_RECEIPT_LOGS');
  });

  it('does not count unrelated-token donations as planned outputs', async () => {
    const f = await setup();
    f.receipt.logs = [transfer(OTHER, BigInt(1000000), 0)];
    expect((await f.run()).status).toBe('FAILED');
  });

  it('checks native value and explicitly leaves the planned kept share unmeasured', async () => {
    const native = await setup(true);
    expect((await native.run()).status).toBe('VERIFIED');
    native.transaction.value += BigInt(1);
    expect((await native.run()).status).toBe('FAILED');
    const kept = await setup(false, true);
    const result = await kept.run();
    expect(result.status).toBe('VERIFIED');
    expect(result.kept).toEqual(kept.compiled.quote.plan.kept);
    expect(result.keptBalanceVerified).toBe(false);
    expect(result.outputs.some(output => output.token === INPUT)).toBe(false);
  });

  it('validates a complete, positive caller policy before any RPC access', async () => {
    const f = await setup();
    const policies = [
      [], [f.minimumReceived[0]], [...f.minimumReceived, f.minimumReceived[0]],
      [{ token: OTHER, amountRaw: BigInt(80) }, f.minimumReceived[1]],
      f.minimumReceived.map(item => ({ ...item, amountRaw: BigInt(0) })),
      f.minimumReceived.map(item => ({ ...item, amountRaw: -BigInt(1) })),
      f.minimumReceived.map(item => ({ ...item, amountRaw: BigInt(2) ** BigInt(256) })),
    ];
    for (const minimumReceived of policies) await expect(f.run({ minimumReceived })).rejects.toThrow();
    for (const confirmations of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(f.run({ confirmations })).rejects.toThrow();
    }
    await expect(f.run({ transactionHash: '0x01' })).rejects.toThrow();
    expect(f.client.getChainId).not.toHaveBeenCalled();
  });

  it('normalizes token identities and accepts case-insensitive policy addresses', async () => {
    const f = await setup();
    const minimumReceived = f.minimumReceived.map(item => ({ ...item, token: '0x' + item.token.slice(2).toUpperCase() }));
    expect((await f.run({ minimumReceived })).status).toBe('VERIFIED');
  });
});
