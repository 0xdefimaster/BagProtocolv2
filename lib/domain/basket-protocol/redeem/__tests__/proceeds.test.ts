import { describe, expect, it } from 'vitest';
import { estimatedProceedsRaw, minimumProceedsRaw, summarizeSale } from '../proceeds';

const swap = (status: string, out: string | null, min: string | null = out) => ({ action: 'SWAP' as const, status, inputAmountRaw: '1', outputAmountRaw: out, minOutputRaw: min });
const keep = (qty: string) => ({ action: 'KEEP' as const, status: 'NOT_NEEDED', inputAmountRaw: qty, outputAmountRaw: null });

describe('estimated vs minimum proceeds (quote, never booked)', () => {
  it('sums SWAP quotes and KEEP legs', () => {
    expect(estimatedProceedsRaw([swap('PENDING', '100', '97'), keep('5')])).toBe('105');
    expect(minimumProceedsRaw([swap('PENDING', '100', '97'), keep('5')])).toBe('102');
  });
  it('a hole in the quote is no estimate', () => {
    expect(estimatedProceedsRaw([swap('PENDING', '100'), swap('PENDING', null)])).toBeNull();
    expect(minimumProceedsRaw([swap('PENDING', '100', null)])).toBeNull();
  });
  it('a one-transaction (Composer) leg reports its on-chain enforced minimum', () => {
    expect(minimumProceedsRaw([{ ...swap('PENDING', '100', null), providerEnforcedMinOutputRaw: '98' }, keep('2')])).toBe('100');
  });
});

describe('summarizeSale', () => {
  it('SOLD only when every SWAP leg verified', () => {
    expect(summarizeSale([swap('COMPLETED', '1'), swap('COMPLETED', '1'), keep('1')]).outcome).toBe('SOLD');
  });
  it('one leg failed next to a sold one is PARTIAL, never SOLD', () => {
    expect(summarizeSale([swap('COMPLETED', '1'), swap('FAILED', null)])).toEqual({ outcome: 'PARTIAL', soldLegs: 1, failedLegs: 1, pendingLegs: 0 });
  });
  it('every leg failed is FAILED; any leg in flight is PENDING', () => {
    expect(summarizeSale([swap('FAILED', null), swap('FAILED', null)]).outcome).toBe('FAILED');
    expect(summarizeSale([swap('COMPLETED', '1'), swap('CONFIRMING', '1')]).outcome).toBe('PENDING');
  });
});
