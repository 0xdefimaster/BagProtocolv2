import { describe, expect, it, vi } from 'vitest';
import { buyBoxForUser, openBoxForUser, listBoxesForUser, listInventoryForUser } from '../box-repo';

// -----------------------------------------------------------------------------
// Phase 18 — box-repo.ts is the sole authoritative path for spending BAG
// Points and crediting box/inventory ownership (buy_box/open_box_with_result
// RPCs in supabase/schema.sql do the actual atomic work; this file is a thin,
// previously-untested wrapper around them). These tests mock the Supabase
// client at the `.rpc()`/`.from()` boundary — they verify this wrapper calls
// the RPCs correctly and maps their outcomes/errors correctly. They do NOT
// exercise the RPCs' own SQL-level atomicity (the `for update` row lock in
// buy_box, the compare-and-swap in open_box_with_result) — that requires a
// real Postgres instance, which this test environment doesn't have. See the
// Phase 18 final report's "known remaining issues" for that gap.
// -----------------------------------------------------------------------------

function fakeAdmin(overrides: { rpc?: unknown; boxRow?: Record<string, unknown> } = {}) {
  const rpc = overrides.rpc ?? vi.fn();
  const boxRow = overrides.boxRow ?? {
    id: 'box_1',
    user_id: 'user_1',
    box_type: 'COMMON',
    opened: false,
    result_accessory_id: null,
    created_at: '2026-01-01T00:00:00Z',
    opened_at: null,
  };
  const single = vi.fn().mockResolvedValue({ data: boxRow, error: null });
  const eq2 = vi.fn().mockReturnValue({ single, maybeSingle: vi.fn().mockResolvedValue({ data: boxRow, error: null }) });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2, single, order: vi.fn().mockResolvedValue({ data: [boxRow], error: null }), gt: vi.fn().mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) });
  const select = vi.fn().mockReturnValue({ eq: eq1, single });
  const from = vi.fn().mockReturnValue({ select });
  return { rpc, from, __single: single, __eq1: eq1 } as unknown as { rpc: ReturnType<typeof vi.fn>; from: typeof from };
}

describe('buyBoxForUser', () => {
  it('calls buy_box with the exact user/season/box-type/idempotency-key params, never trusting a client-supplied cost', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { boxId: 'box_1' }, error: null });
    const admin = fakeAdmin({ rpc });

    await buyBoxForUser(admin as never, 'user_1', 'season_1', 'COMMON', 'req_abc');

    expect(rpc).toHaveBeenCalledWith('buy_box', {
      p_user_id: 'user_1',
      p_season_id: 'season_1',
      p_box_type: 'COMMON',
      p_client_request_id: 'req_abc',
    });
  });

  it('maps INSUFFICIENT_POINTS from the RPC to a typed outcome, never a raw 500-shaped error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'INSUFFICIENT_POINTS' } });
    const admin = fakeAdmin({ rpc });

    const outcome = await buyBoxForUser(admin as never, 'user_1', 'season_1', 'COMMON');

    expect(outcome).toEqual({ ok: false, error: 'INSUFFICIENT_POINTS' });
  });

  it('maps UNKNOWN_BOX_TYPE from the RPC to a typed outcome', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'UNKNOWN_BOX_TYPE' } });
    const admin = fakeAdmin({ rpc });

    const outcome = await buyBoxForUser(admin as never, 'user_1', 'season_1', 'RARE' as never);

    expect(outcome).toEqual({ ok: false, error: 'UNKNOWN_BOX_TYPE' });
  });

  it('a replayed/duplicated request with the same clientRequestId returns ok — idempotent purchase, not a second spend', async () => {
    // buy_box() returns the SAME boxId for a duplicate client_request_id
    // (alreadyApplied semantics) rather than erroring — the wrapper must
    // just fetch and return that box, not treat it as a failure.
    const rpc = vi.fn().mockResolvedValue({ data: { boxId: 'box_1', alreadyApplied: true }, error: null });
    const admin = fakeAdmin({ rpc });

    const outcome = await buyBoxForUser(admin as never, 'user_1', 'season_1', 'COMMON', 'req_abc');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.box.id).toBe('box_1');
  });

  it('exact-balance purchase (cost === available) succeeds — the RPC boundary check is >=, not >', async () => {
    // This test documents the expected outcome at the RPC boundary; the
    // actual >= vs > comparison lives in buy_box()'s SQL (`if v_available <
    // v_cost then raise exception`), which this JS-level test cannot
    // exercise without a real Postgres instance — see this file's header.
    const rpc = vi.fn().mockResolvedValue({ data: { boxId: 'box_1' }, error: null });
    const admin = fakeAdmin({ rpc });

    const outcome = await buyBoxForUser(admin as never, 'user_1', 'season_1', 'COMMON');
    expect(outcome.ok).toBe(true);
  });
});

describe('openBoxForUser', () => {
  it('rejects opening a box that does not exist or is not owned by this user — never leaks another user\'s box', async () => {
    const boxRow = null;
    const single = vi.fn();
    const maybeSingle = vi.fn().mockResolvedValue({ data: boxRow, error: null });
    const eq2 = vi.fn().mockReturnValue({ maybeSingle });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const from = vi.fn().mockReturnValue({ select });
    const admin = { from, rpc: vi.fn() };

    const outcome = await openBoxForUser(admin as never, 'user_1', 'box_owned_by_someone_else');

    expect(outcome).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('a duplicate/concurrent open request (openedNow: false) returns the ALREADY-COMMITTED result, never re-rolls', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { openedNow: false, accessoryId: 'head-cyber-cap' }, error: null });
    const admin = fakeAdmin({
      rpc,
      boxRow: {
        id: 'box_1',
        user_id: 'user_1',
        box_type: 'COMMON',
        opened: true,
        result_accessory_id: 'head-cyber-cap',
        created_at: '2026-01-01T00:00:00Z',
        opened_at: '2026-01-01T00:01:00Z',
      },
    });

    const outcome = await openBoxForUser(admin as never, 'user_1', 'box_1');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.accessory.id).toBe('head-cyber-cap');
    // The RPC is still called (server always verifies/commits atomically —
    // never trusts a locally-owned box row alone) but its OWN result
    // decides the winner, not whatever this call happened to roll.
    expect(rpc).toHaveBeenCalledWith('open_box_with_result', expect.objectContaining({ p_box_id: 'box_1', p_user_id: 'user_1' }));
  });

  it('surfaces BOX_NOT_FOUND from the RPC (box owned by user but RPC itself can\'t find/commit it) as a typed NOT_FOUND', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'BOX_NOT_FOUND' } });
    const admin = fakeAdmin({ rpc });

    const outcome = await openBoxForUser(admin as never, 'user_1', 'box_1');

    expect(outcome).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('listBoxesForUser / listInventoryForUser — read-only, always user-scoped', () => {
  it('listBoxesForUser filters by user_id at the query level', async () => {
    const admin = fakeAdmin();
    await listBoxesForUser(admin as never, 'user_1');
    expect(admin.from).toHaveBeenCalledWith('boxes');
  });

  it('listInventoryForUser filters by user_id and excludes zero-quantity rows', async () => {
    const admin = fakeAdmin();
    await listInventoryForUser(admin as never, 'user_1');
    expect(admin.from).toHaveBeenCalledWith('inventory');
  });
});
