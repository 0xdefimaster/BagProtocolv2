import { describe, expect, it } from 'vitest';
import { describeActivity, loadUserActivity, parseActivityAction } from '../user-activity';

const BAG = '11111111-1111-4111-8111-111111111111';
const INTENT = '22222222-2222-4222-8222-222222222222';

describe('parseActivityAction / describeActivity', () => {
  it('reads every accounting code and never invents an amount', () => {
    const p = parseActivityAction(`PURCHASE_EXECUTED:${INTENT}:${BAG}`);
    expect(p).toEqual({ kind: 'PURCHASE', intentId: INTENT, bagId: BAG, amount: null });
    expect(describeActivity({ action: '' }, p, 'asdasdad', '4')).toBe('Bought $4.00 of asdasdad');
    expect(describeActivity({ action: '' }, p, 'asdasdad', null)).toBe('Bought asdasdad');
    expect(describeActivity({ action: '' }, parseActivityAction(`REDEEM_EXECUTED:${INTENT}:${BAG}`), 'X', null)).toBe('Redeemed from X');
    expect(describeActivity({ action: '' }, parseActivityAction(`FORK_ROYALTY_EARNED:0.06:${BAG}`), 'Root', null)).toBe('Earned $0.06 fork royalty from Root');
    expect(describeActivity({ action: '' }, parseActivityAction(`PERFORMANCE_FEE_EARNED:1.5:${BAG}`), 'Mine', null)).toBe('Earned $1.50 performance fee from Mine');
    expect(describeActivity({ action: 'BOX_OPENED:x:y' }, parseActivityAction('BOX_OPENED:x:y'), null, null)).toBe('Opened a box');
  });

  it('a malformed row is shown generically, never with fabricated ids or amounts', () => {
    expect(parseActivityAction('PURCHASE_EXECUTED:not-a-uuid:also-not')).toEqual({ kind: 'PURCHASE', intentId: null, bagId: null, amount: null });
    expect(parseActivityAction('FORK_ROYALTY_EARNED:abc:' + BAG).amount).toBeNull();
    expect(describeActivity({ action: 'WEIRD' }, parseActivityAction('WEIRD'), null, null)).toBe('Account activity');
  });
});

describe('loadUserActivity', () => {
  function fakeAdmin(tables: Record<string, unknown[]>, calls: { table: string; filters: [string, unknown][] }[]) {
    return {
      from(table: string) {
        const entry = { table, filters: [] as [string, unknown][] };
        calls.push(entry);
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => (entry.filters.push([c, v]), q),
          in: (c: string, v: unknown) => (entry.filters.push([c, v]), q),
          order: () => q,
          limit: () => q,
          then: (r: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(r),
        };
        return q;
      },
    } as never;
  }

  it("reads only the user's own rows, names the Bag and shows the recorded purchase amount", async () => {
    const calls: { table: string; filters: [string, unknown][] }[] = [];
    const admin = fakeAdmin(
      {
        activities: [{ id: 'a1', action: `PURCHASE_EXECUTED:${INTENT}:${BAG}`, created_at: '2026-10-03T16:40:00Z' }],
        bags: [{ id: BAG, name: 'asdasdad' }],
        purchase_intents: [{ id: INTENT, deposit_amount: '4' }],
      },
      calls
    );
    const items = await loadUserActivity(admin, 'user-1');
    expect(items).toEqual([{ id: 'a1', action: 'Bought $4.00 of asdasdad', timestamp: Date.parse('2026-10-03T16:40:00Z'), kind: 'PURCHASE', bagId: BAG }]);
    expect(calls.find((c) => c.table === 'activities')!.filters).toContainEqual(['user_id', 'user-1']);
    expect(calls.find((c) => c.table === 'purchase_intents')!.filters).toContainEqual(['user_id', 'user-1']);
  });
});
