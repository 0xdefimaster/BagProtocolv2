import { beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import schema from '@/docs/schemas/execution-history.v2.schema.json';

// In-memory intents with the SAME keyset semantics as the repo queries
// (user + Bag + status filter, created_at desc then id asc, strictly after the cursor).
type Row = { id: string; userId: string; bagId: string; createdAt: string; status: string; steps: unknown[]; [k: string]: unknown };
let purchases: Row[] = [];
let redeems: Row[] = [];

function micros(iso: string) {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(iso)!;
  return BigInt(Date.parse(m[1] + m[3])) * BigInt(1000) + BigInt((m[2] ?? '').padEnd(6, '0').slice(3, 6));
}
function keysetList(rows: () => Row[]) {
  return async (_admin: unknown, userId: string, bagId: string, statuses: readonly string[], limit: number, after?: { createdAt: string; id: string }) =>
    rows()
      .filter((r) => r.userId === userId && r.bagId === bagId && statuses.includes(r.status))
      .filter((r) => !after || micros(r.createdAt) < micros(after.createdAt) || (micros(r.createdAt) === micros(after.createdAt) && r.id > after.id))
      .sort((a, b) => (micros(a.createdAt) === micros(b.createdAt) ? (a.id < b.id ? -1 : 1) : micros(a.createdAt) > micros(b.createdAt) ? -1 : 1))
      .slice(0, limit);
}
vi.mock('@/lib/server/purchase-intent-repo', () => ({ listPurchaseIntentsForUserBag: (...a: Parameters<ReturnType<typeof keysetList>>) => keysetList(() => purchases)(...a) }));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ listRedeemIntentsForUserBag: (...a: Parameters<ReturnType<typeof keysetList>>) => keysetList(() => redeems)(...a) }));
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: async () => [] }));

import { decodeCursor, encodeCursor, InvalidCursorError, loadExecutionHistory } from '../execution-receipts';

const admin = {
  from: () => {
    const q = { select: () => q, eq: () => q, in: () => q, then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) };
    return q;
  },
} as never;

const BAG = '11111111-1111-4111-8111-111111111111';
const OTHER_BAG = '22222222-2222-4222-8222-222222222222';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TX = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const step = (txHash: string | null) => ({
  stepIndex: 0, action: 'SWAP', inputAsset: { chain: 'robinhood', address: '0x' + '11'.repeat(20) }, outputAsset: { chain: 'robinhood', address: '0x' + '22'.repeat(20) },
  sourceChain: 'robinhood', destinationChain: 'robinhood', inputAmountRaw: '1', outputAmountRaw: '1', outputDecimals: 18, minOutputRaw: '1',
  lifiStep: null, status: 'COMPLETED', approvalTxHash: null, txHash,
});
function purchase(n: number, createdAt: string, over: Partial<Row> = {}): Row {
  return {
    id: uuid(n), userId: 'alice', bagId: BAG, createdAt, status: 'COMPLETED', walletAddress: '0xw', inputAsset: { chain: 'robinhood', address: '0x' + '11'.repeat(20) },
    inputAmountRaw: '1', sharesRaw: '1', shareDecimals: 18, recipeVersion: 1, compositionHash: 'h', steps: [step(TX(n))],
    composerTransaction: { to: '', data: '', value: '0', chainId: 4663, userProxy: '' }, bagRouterTransaction: null, providerId: null, executionPlanHash: null,
    fallback: null, executedAt: null, ...over,
  };
}
function redeem(n: number, createdAt: string): Row {
  return {
    id: uuid(n), userId: 'alice', bagId: BAG, createdAt, status: 'COMPLETED', walletAddress: '0xw', sharesRaw: '1', shareDecimals: 18,
    outputAsset: { chain: 'robinhood', address: '0x' + '22'.repeat(20) }, outputDecimals: 18, steps: [{ ...step(TX(n)), lifiStep: {} }], executedAt: null,
  };
}
const ids = (r: { executions: { executionId: string }[] }) => r.executions.map((e) => e.executionId);
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

beforeEach(() => {
  // 7 executions across both tables, including a same-timestamp tie (ids 3 and 4) with different fraction lengths,
  // plus rows that must never appear: never-submitted, another user, another Bag.
  purchases = [
    purchase(1, '2026-10-07T10:00:00Z'),
    purchase(3, '2026-10-05T10:00:00.5+00:00'),
    purchase(5, '2026-10-03T10:00:00Z'),
    purchase(7, '2026-10-01T10:00:00Z'),
    purchase(90, '2026-10-06T10:00:00Z', { status: 'FAILED', steps: [step(null)] }),
    purchase(91, '2026-10-06T11:00:00Z', { userId: 'mallory' }),
    purchase(92, '2026-10-06T12:00:00Z', { bagId: OTHER_BAG }),
  ];
  redeems = [redeem(2, '2026-10-06T10:00:00Z'), redeem(4, '2026-10-05T10:00:00.500000Z'), redeem(6, '2026-10-02T10:00:00Z')];
});

describe('execution history pagination', () => {
  it('first page: newest first across purchases and redeems, with hasMore and an opaque cursor', async () => {
    const page = await loadExecutionHistory(admin, BAG, 'alice', { limit: 3 });
    expect(ids(page)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(page).toMatchObject({ schemaVersion: 2, scope: 'VIEWER_OWN_EXECUTIONS', hasMore: true });
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(validate(page)).toBe(true);
  });

  it('next pages continue exactly where the previous ended (ties broken by id) until hasMore is false', async () => {
    const p1 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 3 });
    const p2 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 3, cursor: p1.nextCursor });
    const p3 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 3, cursor: p2.nextCursor });
    expect(ids(p2)).toEqual([uuid(4), uuid(5), uuid(6)]);
    expect(ids(p3)).toEqual([uuid(7)]);
    expect(p3).toMatchObject({ hasMore: false, nextCursor: null });
    // The full walk equals one big page: nothing skipped, nothing repeated.
    const all = await loadExecutionHistory(admin, BAG, 'alice', { limit: 50 });
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(ids(all));
    expect(all).toMatchObject({ hasMore: false, nextCursor: null });
    for (const p of [p2, p3, all]) expect(validate(p)).toBe(true);
  });

  it('is deterministic: the same cursor returns the same page', async () => {
    const p1 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 2 });
    const a = await loadExecutionHistory(admin, BAG, 'alice', { limit: 2, cursor: p1.nextCursor });
    const b = await loadExecutionHistory(admin, BAG, 'alice', { limit: 2, cursor: p1.nextCursor });
    expect(b).toEqual(a);
  });

  it('never returns another user\'s, another Bag\'s or never-submitted intents — on any page', async () => {
    const all = await loadExecutionHistory(admin, BAG, 'alice', { limit: 50 });
    expect(ids(all)).not.toEqual(expect.arrayContaining([uuid(90)]));
    expect(ids(all)).not.toContain(uuid(91));
    expect(ids(all)).not.toContain(uuid(92));
    // A cursor only moves the position: mallory using alice's cursor still sees only her own execution.
    const p1 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 1 });
    const mallory = await loadExecutionHistory(admin, BAG, 'mallory', { limit: 50, cursor: p1.nextCursor });
    expect(ids(mallory)).toEqual([uuid(91)]);
    expect(mallory.executions.every((e) => e.bagId === BAG)).toBe(true);
  });

  it('skips non-executions without short or broken pages', async () => {
    // Many never-submitted intents between real ones.
    for (let i = 0; i < 30; i++) purchases.push(purchase(200 + i, `2026-10-04T0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')}:00Z`, { status: 'FAILED', steps: [step(null)] }));
    const p1 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 5 });
    expect(ids(p1)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]);
    const p2 = await loadExecutionHistory(admin, BAG, 'alice', { limit: 5, cursor: p1.nextCursor });
    expect(ids(p2)).toEqual([uuid(6), uuid(7)]);
    expect(p2.hasMore).toBe(false);
  });
});

describe('cursor tampering', () => {
  it('rejects malformed, foreign-Bag, wrong-version and injection cursors before any query', async () => {
    const good = encodeCursor(BAG, { createdAt: '2026-10-05T10:00:00Z', id: uuid(3) });
    expect(decodeCursor(good, BAG)).toEqual({ createdAt: '2026-10-05T10:00:00Z', id: uuid(3) });
    const bad = [
      'not base64!',
      encodeCursor(OTHER_BAG, { createdAt: '2026-10-05T10:00:00Z', id: uuid(3) }),
      Buffer.from(JSON.stringify({ v: 2, b: BAG, t: '2026-10-05T10:00:00Z', i: uuid(3) })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, b: BAG, t: '2026-10-05T10:00:00Z",id.gt."0', i: uuid(3) })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, b: BAG, t: '2026-10-05T10:00:00Z', i: 'x),or(user_id.neq.null' })).toString('base64url'),
      Buffer.from('{').toString('base64url'),
    ];
    for (const c of bad) {
      expect(() => decodeCursor(c, BAG)).toThrow(InvalidCursorError);
      await expect(loadExecutionHistory(admin, BAG, 'alice', { cursor: c })).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });
});
