import { describe, expect, it } from 'vitest';
import { getBagVerification } from '../bag-verification';

function admin(o: { holdings: unknown[]; state: unknown[]; records: unknown[] }) {
  return {
    from: (table: string) => ({
      select: () => ({
        in: (_c: string, _v: string[]) => {
          if (table === 'bag_investor_holdings') return Promise.resolve({ data: o.holdings, error: null });
          if (table === 'wallet_reconciliation_state') return Promise.resolve({ data: o.state, error: null });
          return { gte: async () => ({ data: o.records, error: null }) };
        },
      }),
    }),
  } as never;
}

describe('getBagVerification', () => {
  it('the oldest holder check is the Bag’s; an open drift naming the Bag counts its holder once; a never-checked holder leaves it unverified', async () => {
    const out = await getBagVerification(
      admin({
        holdings: [
          { bag_id: 'a', user_id: 'u1', quantity_raw: '5' },
          { bag_id: 'a', user_id: 'u2', quantity_raw: '7' },
          { bag_id: 'a', user_id: 'u3', quantity_raw: '0' },
          { bag_id: 'b', user_id: 'u4', quantity_raw: '1' },
        ],
        state: [
          { user_id: 'u1', last_checked_at: '2026-10-11T10:00:00Z' },
          { user_id: 'u2', last_checked_at: '2026-10-11T09:55:00Z' },
        ],
        records: [
          { id: 'r1', user_id: 'u2', status: 'DRIFT', confirms_record_id: null, allocation: [{ bagId: 'a', allocatedRaw: '2' }, { bagId: 'c', allocatedRaw: '0' }] },
          { id: 'r2', user_id: 'u2', status: 'DRIFT', confirms_record_id: null, allocation: [{ bagId: 'a', allocatedRaw: '1' }] },
          { id: 'r3', user_id: 'u1', status: 'DRIFT', confirms_record_id: null, allocation: [{ bagId: 'a', allocatedRaw: '3' }] },
          { id: 'r4', user_id: 'u1', status: 'RESOLVED', confirms_record_id: 'r3', allocation: [] },
        ],
      }),
      ['a', 'b', 'c']
    );
    expect(out.get('a')).toEqual({ checkedAt: '2026-10-11T09:55:00Z', pendingOutflows: 1 });
    expect(out.get('b')).toEqual({ checkedAt: null, pendingOutflows: 0 });
    expect(out.get('c')).toEqual({ checkedAt: null, pendingOutflows: 0 });
  });
});
