import { describe, expect, it } from 'vitest';
import { usMarketStatus } from '../market-hours';

// New York is UTC-5 in November (EST) and UTC-4 in July (EDT).
describe('usMarketStatus', () => {
  it.each([
    ['2026-11-19T14:29:00Z', 'CLOSED_OVERNIGHT'], // Thu 09:29 EST
    ['2026-11-19T14:30:00Z', 'OPEN'], // Thu 09:30 EST
    ['2026-11-19T20:59:00Z', 'OPEN'], // Thu 15:59 EST
    ['2026-11-19T21:00:00Z', 'CLOSED_OVERNIGHT'], // Thu 16:00 EST
    ['2026-11-19T01:30:00Z', 'CLOSED_OVERNIGHT'], // Wed 20:30 EST (04:30 in Istanbul on Thursday)
    ['2026-11-21T15:00:00Z', 'CLOSED_WEEKEND'], // Saturday
    ['2026-11-22T15:00:00Z', 'CLOSED_WEEKEND'], // Sunday
    ['2026-07-15T13:30:00Z', 'OPEN'], // Wed 09:30 EDT
    ['2026-07-15T13:29:00Z', 'CLOSED_OVERNIGHT'], // Wed 09:29 EDT
  ] as const)('%s → %s', (iso, expected) => {
    expect(usMarketStatus(new Date(iso))).toBe(expected);
  });
});
