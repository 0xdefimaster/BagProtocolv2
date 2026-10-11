import { describe, expect, it } from 'vitest';
import {
  ExecutionInput,
  SettledSaleInput,
  VERIFICATION_STALE_MS,
  VaultCreditInput,
  recentEvents,
  summarizeExecutions,
  summarizeMoney,
  summarizeTvl,
  verificationState,
} from '@/lib/domain/proof/protocol-proof';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

describe('verificationState', () => {
  it('verified within the window, stale after it, pending on an outflow, unverified without a check', () => {
    expect(verificationState({ checkedAt: iso(60_000), pendingOutflows: 0 }, NOW)).toBe('VERIFIED');
    expect(verificationState({ checkedAt: iso(VERIFICATION_STALE_MS + 1), pendingOutflows: 0 }, NOW)).toBe('STALE');
    expect(verificationState({ checkedAt: iso(60_000), pendingOutflows: 1 }, NOW)).toBe('PENDING_OUTFLOW');
    expect(verificationState({ checkedAt: null, pendingOutflows: 0 }, NOW)).toBe('UNVERIFIED');
    expect(verificationState({ checkedAt: 'not a date', pendingOutflows: 0 }, NOW)).toBe('UNVERIFIED');
    expect(verificationState(undefined, NOW)).toBe('UNVERIFIED');
  });
});

describe('summarizeTvl', () => {
  it('splits TVL by state, drops Bags without value, sorts by TVL', () => {
    const { tvl, bags } = summarizeTvl(
      [
        { id: 'a', name: 'A', tvl: 100, return7d: 1, return30d: 2, verification: { checkedAt: iso(1000), pendingOutflows: 0 } },
        { id: 'b', name: 'B', tvl: 300, return7d: null, return30d: null, verification: { checkedAt: iso(1000), pendingOutflows: 2 } },
        { id: 'c', name: 'C', tvl: 50, return7d: null, return30d: null },
        { id: 'd', name: 'D', tvl: 0, return7d: null, return30d: null },
        { id: 'e', name: 'E', tvl: Number.NaN, return7d: null, return30d: null },
      ],
      NOW
    );
    expect(tvl.total).toBe(450);
    expect(tvl.byState).toEqual({ VERIFIED: 100, STALE: 0, PENDING_OUTFLOW: 300, UNVERIFIED: 50 });
    expect(tvl.bagsByState).toEqual({ VERIFIED: 1, STALE: 0, PENDING_OUTFLOW: 1, UNVERIFIED: 1 });
    expect(bags.map((b) => [b.id, b.state])).toEqual([
      ['b', 'PENDING_OUTFLOW'],
      ['a', 'VERIFIED'],
      ['c', 'UNVERIFIED'],
    ]);
  });
});

describe('summarizeExecutions', () => {
  const ex = (kind: ExecutionInput['kind'], outcome: ExecutionInput['outcome']): ExecutionInput => ({ kind, id: Math.random().toString(), bagId: 'b', outcome, at: iso(0), txs: [] });

  it('counts per kind; the rate is succeeded over finished, pending excluded', () => {
    const s = summarizeExecutions([ex('PURCHASE', 'SUCCEEDED'), ex('PURCHASE', 'SUCCEEDED'), ex('PURCHASE', 'PENDING'), ex('REDEEM', 'FAILED'), ex('REDEEM', 'PARTIAL'), ex('REDEEM', 'UNKNOWN')]);
    expect(s.purchases).toEqual({ succeeded: 2, partial: 0, failed: 0, pending: 1 });
    expect(s.redeems).toEqual({ succeeded: 0, partial: 1, failed: 1, pending: 0 });
    expect(s.successRateBps).toBe(5000);
  });

  it('null rate when nothing finished', () => {
    expect(summarizeExecutions([ex('PURCHASE', 'PENDING')]).successRateBps).toBeNull();
    expect(summarizeExecutions([]).successRateBps).toBeNull();
  });

  it('rounds the rate down', () => {
    expect(summarizeExecutions([ex('PURCHASE', 'SUCCEEDED'), ex('PURCHASE', 'SUCCEEDED'), ex('PURCHASE', 'FAILED')]).successRateBps).toBe(6666);
  });
});

const sale = (o: Partial<SettledSaleInput> = {}): SettledSaleInput => ({
  intentId: 'i',
  bagId: 'b',
  txHash: hash(1),
  at: iso(0),
  token: USDG,
  decimals: 6,
  receivedRaw: '1000000',
  feeRaw: '20000',
  userProceedsRaw: '980000',
  consumedBasisRaw: '800000',
  ...o,
});
const credit = (o: Partial<VaultCreditInput> = {}): VaultCreditInput => ({
  id: 'c',
  bagId: 'b',
  rewardType: 'FORK_ROYALTY',
  txHash: hash(2),
  at: iso(0),
  token: USDG.toLowerCase(),
  decimals: 6,
  amountRaw: '15000',
  ...o,
});

describe('summarizeMoney', () => {
  it('sums per token in raw units; net realized is signed', () => {
    const [m, ...rest] = summarizeMoney(
      [sale(), sale({ receivedRaw: '500000', feeRaw: '0', userProceedsRaw: '500000', consumedBasisRaw: '900000' })],
      [credit(), credit({ rewardType: 'PERFORMANCE_FEE', amountRaw: '1' })]
    );
    expect(rest).toEqual([]);
    expect(m.token).toBe(USDG.toLowerCase());
    expect(m.performanceFeesPaidRaw).toBe('20000');
    expect(m.vaultCreditsRaw).toEqual({ FORK_ROYALTY: '15000', PERFORMANCE_FEE: '1' });
    expect(m.exits).toEqual({ count: 2, grossProceedsRaw: '1500000', costBasisRaw: '1700000', feesRaw: '20000', netRealizedPnlRaw: '-220000' });
  });

  it('exact beyond float precision', () => {
    const big = '123456789012345678901234567890';
    const [m] = summarizeMoney([sale({ receivedRaw: big, feeRaw: '1', consumedBasisRaw: '0' }), sale({ receivedRaw: big, feeRaw: '1', consumedBasisRaw: '0' })], []);
    expect(m.exits.grossProceedsRaw).toBe('246913578024691357802469135780');
    expect(m.exits.netRealizedPnlRaw).toBe('246913578024691357802469135778');
  });

  it('leaves malformed rows out', () => {
    expect(summarizeMoney([sale({ feeRaw: '1.5' }), sale({ txHash: '0x12' })], [credit({ amountRaw: '-1' }), credit({ txHash: 'nope' })])).toEqual([]);
  });
});

describe('recentEvents', () => {
  it('newest first, last valid tx of an execution, fee events only when a fee was paid, capped', () => {
    const events = recentEvents(
      [
        { kind: 'PURCHASE', id: 'p', bagId: 'b', outcome: 'SUCCEEDED', at: iso(3000), txs: [{ chain: 'robinhood', txHash: hash(10) }, { chain: 'robinhood', txHash: hash(11) }] },
        { kind: 'REDEEM', id: 'r', bagId: 'b', outcome: 'FAILED', at: iso(1000), txs: [{ chain: 'robinhood', txHash: 'bad' }] },
      ],
      [sale({ at: iso(2000) }), sale({ feeRaw: '0', txHash: hash(3) })],
      [credit({ at: iso(500) })],
      { settlement: 'robinhood' },
      10
    );
    expect(events.map((e) => [e.type, e.tx.txHash])).toEqual([
      ['VAULT_CREDIT', hash(2)],
      ['FEE_PAID', hash(1)],
      ['EXECUTION', hash(11)],
    ]);
    expect(recentEvents([], [sale(), sale({ txHash: hash(5) })], [credit()], { settlement: 'robinhood' }, 2)).toHaveLength(2);
  });
});
