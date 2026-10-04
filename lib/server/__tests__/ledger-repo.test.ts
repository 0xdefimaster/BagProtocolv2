import { describe, expect, it, vi } from 'vitest';
import { findLedgerMismatches, listLedgerEventsForUser } from '../ledger-repo';

function fakeAdmin(rows: Record<string, unknown>[]) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'lt']) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return q;
    };
  }
  (q as unknown as PromiseLike<unknown>).then = ((resolve: (v: unknown) => void) => resolve({ data: rows, error: null })) as never;
  return { admin: { from: () => q } as never, calls };
}
const row = (seq: number) => ({ seq, bag_id: 'b', kind: 'PURCHASE_FILL', legs: [], quote: {}, source: { intentId: 'i' }, strategy_version: 1, created_at: 't' });

describe('listLedgerEventsForUser', () => {
  it('newest first, one extra row to know there is a next page, cursor = last seq returned', async () => {
    const { admin, calls } = fakeAdmin([row(9), row(8), row(7)]);
    const page = await listLedgerEventsForUser(admin, 'u1', { limit: 2, bagId: 'b', before: '10' });
    expect(page.events.map((e) => e.seq)).toEqual(['9', '8']);
    expect(page.nextBefore).toBe('8');
    expect(calls).toEqual(
      expect.arrayContaining([
        ['eq', ['user_id', 'u1']],
        ['order', ['seq', { ascending: false }]],
        ['limit', [3]],
        ['eq', ['bag_id', 'b']],
        ['lt', ['seq', '10']],
      ])
    );
    expect(page.events[0]).toEqual({ seq: '9', bagId: 'b', kind: 'PURCHASE_FILL', legs: [], quote: {}, source: { intentId: 'i' }, strategyVersion: 1, createdAt: 't' });
  });

  it('last page has no cursor; limit is clamped to 1-100', async () => {
    const { admin, calls } = fakeAdmin([row(1)]);
    expect((await listLedgerEventsForUser(admin, 'u1', { limit: 500 })).nextBefore).toBeNull();
    expect(calls).toContainEqual(['limit', [101]]);
  });
});

describe('findLedgerMismatches', () => {
  it('maps rows and keeps numbers as strings', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: [{ scope: 'HOLDING', user_id: 'u', bag_id: 'b', chain: 'robinhood', address: '0xa', ledger_value: 2, stored_value: '5' }], error: null })) };
    expect(await findLedgerMismatches(admin as never)).toEqual([{ scope: 'HOLDING', userId: 'u', bagId: 'b', chain: 'robinhood', address: '0xa', ledgerValue: '2', storedValue: '5' }]);
    expect(admin.rpc).toHaveBeenCalledWith('ledger_projection_mismatches');
  });
});
