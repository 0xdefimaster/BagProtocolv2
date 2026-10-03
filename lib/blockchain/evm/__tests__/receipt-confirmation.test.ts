import { describe, expect, it, vi } from 'vitest';
import type { Hex, TransactionReceipt } from 'viem';
import { ReceiptConfirmationClient, waitForConfirmedReceipt } from '../receipt-confirmation';

// Deterministic unit tests for the bounded receipt/depth poller: a virtual
// clock (`now`/`sleep`) replaces real time, and a scripted client replaces RPC.

const HASH: Hex = `0x${'ab'.repeat(32)}`;
const named = (name: string) => Object.assign(new Error(name), { name });
const receiptAt = (blockNumber: bigint, hash: Hex = HASH) => ({ transactionHash: hash, blockNumber, status: 'success', logs: [] }) as unknown as TransactionReceipt;

/** `receipts[i]` / `heads[i]` answer the i-th poll (last value repeats). `null` receipt = not found. */
function scripted(receipts: (TransactionReceipt | null | Error)[], heads: bigint[] = [BigInt(0)]) {
  let r = 0;
  let h = 0;
  const getTransactionReceipt = vi.fn(async () => {
    const v = receipts[Math.min(r++, receipts.length - 1)];
    if (v instanceof Error) throw v;
    if (v === null) throw named('TransactionReceiptNotFoundError');
    return v;
  });
  const getBlockNumber = vi.fn(async () => heads[Math.min(h++, heads.length - 1)]);
  return { client: { getTransactionReceipt, getBlockNumber } as unknown as ReceiptConfirmationClient, getTransactionReceipt, getBlockNumber };
}

function virtualClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('waitForConfirmedReceipt', () => {
  it('already mined, confirmations=1 → CONFIRMED on the first poll without reading the head or sleeping', async () => {
    const { client, getBlockNumber } = scripted([receiptAt(BigInt(10))]);
    const clock = virtualClock();
    const r = await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 1, timeoutMs: 5000, ...clock });
    expect(r).toMatchObject({ status: 'CONFIRMED', depth: BigInt(1) });
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('depth is head - receiptBlock + 1, read UNCACHED; waits until the required depth exists', async () => {
    const { client, getBlockNumber } = scripted([receiptAt(BigInt(10))], [BigInt(10), BigInt(11), BigInt(12)]);
    const clock = virtualClock();
    const r = await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 3, timeoutMs: 10_000, pollIntervalMs: 1000, ...clock });
    expect(r).toMatchObject({ status: 'CONFIRMED', depth: BigInt(3) });
    expect(getBlockNumber).toHaveBeenCalledTimes(3);
    expect(getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });

  it('BOUNDED: never mined → NOT_MINED after exactly ceil(timeout/interval)+1 polls; total sleep == timeout', async () => {
    const { client, getTransactionReceipt } = scripted([null]);
    const clock = virtualClock();
    const r = await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 1, timeoutMs: 2500, pollIntervalMs: 1000, ...clock });
    expect(r).toEqual({ status: 'NOT_MINED' });
    expect(clock.sleeps).toEqual([1000, 1000, 500]);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(4);
  });

  it('BOUNDED: mined but never deep enough → INSUFFICIENT_DEPTH with the observed depth (never accepted early)', async () => {
    const { client } = scripted([receiptAt(BigInt(10))], [BigInt(11)]);
    const clock = virtualClock();
    const r = await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 5, timeoutMs: 1500, pollIntervalMs: 1000, ...clock });
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DEPTH', depth: BigInt(2) });
  });

  it('timeoutMs 0 → exactly one poll, no sleep', async () => {
    const { client, getTransactionReceipt } = scripted([null]);
    const clock = virtualClock();
    expect(await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 1, timeoutMs: 0, ...clock })).toEqual({ status: 'NOT_MINED' });
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('REORG: a receipt seen earlier is never trusted — dropped then re-mined in a later block, depth counts from the NEW block', async () => {
    // poll 1: in block 10 (head 10, depth 1); poll 2: reorged out; poll 3: re-mined in block 12, head 12 (depth 1); poll 4: head 13 (depth 2).
    const { client } = scripted([receiptAt(BigInt(10)), null, receiptAt(BigInt(12)), receiptAt(BigInt(12))], [BigInt(10), BigInt(12), BigInt(13)]);
    const clock = virtualClock();
    const r = await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 2, timeoutMs: 10_000, pollIntervalMs: 1000, ...clock });
    expect(r.status).toBe('CONFIRMED');
    if (r.status === 'CONFIRMED') expect(r.receipt.blockNumber).toBe(BigInt(12));
  });

  it('a head BEHIND the receipt block (lagging load-balanced RPC) counts as depth 0, not negative/huge', async () => {
    const { client } = scripted([receiptAt(BigInt(10))], [BigInt(9)]);
    const r = await waitForConfirmedReceipt(client, { hash: HASH, confirmations: 2, timeoutMs: 0, ...virtualClock() });
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DEPTH', depth: BigInt(0) });
  });

  it('an RPC outage propagates unchanged — it is NOT "pending"', async () => {
    const outage = new Error('connect ECONNREFUSED');
    const { client } = scripted([outage]);
    await expect(waitForConfirmedReceipt(client, { hash: HASH, confirmations: 1, timeoutMs: 5000, ...virtualClock() })).rejects.toBe(outage);
  });

  it('a receipt for a DIFFERENT hash is a malformed RPC answer and throws', async () => {
    const { client } = scripted([receiptAt(BigInt(10), `0x${'cd'.repeat(32)}`)]);
    await expect(waitForConfirmedReceipt(client, { hash: HASH, confirmations: 1, timeoutMs: 0, ...virtualClock() })).rejects.toThrow(/receipt for/);
  });

  it('hash comparison is case-insensitive (uppercase input)', async () => {
    const { client, getTransactionReceipt } = scripted([receiptAt(BigInt(10))]);
    const upper = `0x${'AB'.repeat(32)}` as Hex;
    expect((await waitForConfirmedReceipt(client, { hash: upper, confirmations: 1, timeoutMs: 0 })).status).toBe('CONFIRMED');
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it('CONCURRENT: many simultaneous AND staggered waits for one hash on ONE client all resolve independently (the viem observer failure mode)', async () => {
    const { client } = scripted([receiptAt(BigInt(10))], [BigInt(10)]);
    const wait = () => waitForConfirmedReceipt(client, { hash: HASH, confirmations: 1, timeoutMs: 50, pollIntervalMs: 10 });
    const first = await Promise.all(Array.from({ length: 8 }, wait));
    // Late arrivals — started only after the earlier ones finished — must not be affected by them.
    const late = await Promise.all(Array.from({ length: 8 }, wait));
    expect([...first, ...late].every((r) => r.status === 'CONFIRMED')).toBe(true);
  });
});
