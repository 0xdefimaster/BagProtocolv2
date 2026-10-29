import { describe, expect, it } from 'vitest';
import { auditSettlementEvents, needsReview, type SettledEventRecord, type SettlementIntentRecord } from '../settlement-event-audit';

const NOW = 1_800_000_000;
const WALLET = '0x' + 'a'.repeat(40);
const event = (over: Partial<SettledEventRecord> = {}): SettledEventRecord => ({
  redemptionId: '0x' + '1'.repeat(64),
  txHash: '0x' + 'f'.repeat(64),
  blockTimestampSec: NOW - 7200,
  user: WALLET,
  received: '1000000',
  fee: '0',
  ...over,
});
const intent = (over: Partial<SettlementIntentRecord> = {}): SettlementIntentRecord => ({
  redemptionId: '0x' + '1'.repeat(64),
  intentId: 'intent-1',
  walletAddress: WALLET,
  bookedTxHash: '0x' + 'f'.repeat(64),
  ...over,
});

describe('auditSettlementEvents', () => {
  it('BOOKED when the intent was booked from this transaction (case-insensitive)', () => {
    const [row] = auditSettlementEvents([event({ txHash: '0x' + 'F'.repeat(64) })], [intent()], NOW);
    expect(row).toMatchObject({ status: 'BOOKED', intentId: 'intent-1' });
    expect(needsReview(row)).toBe(false);
  });

  it('PENDING while recent and not booked; UNBOOKED after the grace period', () => {
    const unbooked = intent({ bookedTxHash: null });
    expect(auditSettlementEvents([event({ blockTimestampSec: NOW - 60 })], [unbooked], NOW)[0].status).toBe('PENDING');
    const [old] = auditSettlementEvents([event()], [unbooked], NOW);
    expect(old.status).toBe('UNBOOKED');
    expect(needsReview(old)).toBe(true);
  });

  it('UNBOOKED when the intent was booked from another transaction, however recent', () => {
    const [row] = auditSettlementEvents([event({ blockTimestampSec: NOW - 10 })], [intent({ bookedTxHash: '0x' + 'e'.repeat(64) })], NOW);
    expect(row.status).toBe('UNBOOKED');
  });

  it('USER_MISMATCH when the event paid another wallet than the intent', () => {
    const [row] = auditSettlementEvents([event({ user: '0x' + 'b'.repeat(40) })], [intent()], NOW);
    expect(row).toMatchObject({ status: 'USER_MISMATCH', intentId: 'intent-1' });
    expect(needsReview(row)).toBe(true);
  });

  it('UNKNOWN_REDEMPTION when no intent carries the redemption id', () => {
    const [row] = auditSettlementEvents([event({ redemptionId: '0x' + '2'.repeat(64) })], [intent()], NOW);
    expect(row).toMatchObject({ status: 'UNKNOWN_REDEMPTION', intentId: null });
    expect(needsReview(row)).toBe(true);
  });
});
