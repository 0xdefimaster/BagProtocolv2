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
    verifyPurchaseReceipt(compiled, { client, transactionHash: HASH, minimumReceived, verification: 'TRANSFER_LOGS', ...overrides });
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

describe('purchase balance evidence and smart-account calls', () => {
  async function balances(kept = false) {
    const f = await setup(false, kept);
    const proof = {
      transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), owner: SIGNER,
      scope: 'TRANSACTION' as const,
      balances: [
        ...f.minimumReceived.map(output => ({ token: output.token, beforeRaw: BigInt(25), afterRaw: BigInt(125) })),
        { token: INPUT, beforeRaw: f.compiled.quote.plan.amountRaw, afterRaw: f.compiled.quote.plan.kept?.amountRaw ?? BigInt(0) },
      ],
    };
    const client: PurchaseReceiptClient = { ...f.client, getPurchaseBalanceChanges: vi.fn(async () => proof) };
    const run = () => f.run({ client, verification: 'BALANCE_DELTA' });
    return { ...f, proof, client, run };
  }

  it('defaults to real balance evidence without silently downgrading to events', async () => {
    const f = await setup();
    const result = await f.run({ verification: undefined });
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('BALANCE_EVIDENCE_UNAVAILABLE');
  });

  it('checks actual before/after balances and the retained input share', async () => {
    const f = await balances(true);
    const result = await f.run();
    expect(result.status).toBe('VERIFIED');
    expect(result.evidence).toBe('TRANSACTION_AND_BALANCE_DELTAS');
    expect(result.outputs[0]).toMatchObject({ balanceBeforeRaw: BigInt(25), balanceAfterRaw: BigInt(125), balanceDeltaRaw: BigInt(100) });
    expect(result.spentInputRaw).toBe(f.compiled.quote.plan.swapAmountRaw);
    expect(result.keptBalanceVerified).toBe(true);
  });

  it('does not turn generous or missing Transfer events into fabricated wallet balances', async () => {
    const f = await balances();
    f.proof.balances[0].afterRaw = BigInt(26);
    expect((await f.run()).issues[0].code).toBe('OUTPUT_BELOW_MINIMUM');
    f.proof.balances[0].afterRaw = BigInt(125);
    f.receipt.logs = [];
    expect((await f.run()).status).toBe('VERIFIED');
  });

  it.each(['owner', 'blockHash', 'transactionHash', 'missing', 'duplicate', 'negative', 'overflow'] as const)('refuses %s balance evidence', async kind => {
    const f = await balances();
    if (kind === 'owner') f.proof.owner = OTHER;
    if (kind === 'blockHash' || kind === 'transactionHash') f.proof[kind] = hex('f', 64);
    if (kind === 'missing') f.proof.balances.pop();
    if (kind === 'duplicate') f.proof.balances[1] = { ...f.proof.balances[0] };
    if (kind === 'negative') f.proof.balances[0].beforeRaw = BigInt(-1);
    if (kind === 'overflow') f.proof.balances[0].afterRaw = BigInt(2) ** BigInt(256);
    expect((await f.run()).issues[0].code).toBe('INVALID_BALANCE_EVIDENCE');
  });

  it('refuses excessive input spending and insufficient starting input', async () => {
    const f = await balances(true);
    const input = f.proof.balances.find(entry => entry.token === INPUT)!;
    input.afterRaw -= BigInt(1);
    expect((await f.run()).issues[0].code).toBe('INPUT_SPEND_EXCEEDS_PLAN');
    input.beforeRaw = BigInt(0); input.afterRaw = BigInt(0);
    expect((await f.run()).issues[0].code).toBe('INPUT_BALANCE_BELOW_PLAN');
  });

  it('refuses changes in canonical inclusion during evidence reads', async () => {
    const f = await balances();
    f.client.getPurchaseBalanceChanges = async () => {
      f.client.getBlock = async () => ({ hash: hex('f', 64) });
      return f.proof;
    };
    expect((await f.run()).issues[0].code).toBe('NON_CANONICAL_RECEIPT');
  });

  async function batch() {
    const f = await balances();
    const call = { type: 'CALL', from: SIGNER, to: ROUTER, input: f.compiled.transaction.data, value: '0x0' };
    f.transaction.to = OTHER; f.receipt.to = OTHER;
    f.transaction.input = '0xabcdef12';
    const root = { type: 'CALL', from: SIGNER, to: OTHER, input: '0xabcdef12', value: '0x0', calls: [call] };
    const trace = { transactionHash: HASH, blockHash: BLOCK, call: root };
    f.client.tracePurchaseCall = vi.fn(async () => trace);
    return { ...f, call, root, trace };
  }

  it('verifies an exact successful wallet call inside a delegated/batched transaction', async () => {
    const f = await batch();
    const result = await f.run();
    expect(result.status).toBe('VERIFIED');
    expect(result.transactionBinding).toBe('CALL_TRACE');
    expect(result.balanceScope).toBe('TRANSACTION');
  });

  it('supports a relayed outer transaction only when the proven inner CALL comes from the wallet', async () => {
    const f = await batch();
    f.transaction.from = INPUT; f.receipt.from = INPUT; f.root.from = INPUT;
    expect((await f.run()).status).toBe('VERIFIED');
    f.call.from = INPUT;
    expect((await f.run()).issues[0].code).toBe('COMPILED_CALL_NOT_EXECUTED');
  });

  it.each(['reverted', 'ancestor reverted', 'delegatecall', 'different data', 'wrong value', 'duplicate', 'wrong block', 'wrong root'] as const)('refuses %s batch proof', async kind => {
    const f = await batch();
    if (kind === 'reverted') Object.assign(f.call, { error: 'execution reverted' });
    if (kind === 'ancestor reverted') f.root.calls = [{ type: 'CALL', from: SIGNER, to: OTHER, input: '0x', value: '0x0', error: 'execution reverted', calls: [f.call] } as unknown as typeof f.call];
    if (kind === 'delegatecall') f.call.type = 'DELEGATECALL';
    if (kind === 'different data') f.call.input = '0x12345679';
    if (kind === 'wrong value') f.call.value = '0x1';
    if (kind === 'duplicate') f.root.calls.push({ ...f.call });
    if (kind === 'wrong block') f.trace.blockHash = hex('f', 64);
    if (kind === 'wrong root') f.root.input = '0x12345678';
    expect((await f.run()).status).not.toBe('VERIFIED');
  });
});
