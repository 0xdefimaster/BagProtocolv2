import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBag, createBagVersion, getBagById } from '@/lib/server/bag-repo';
import { TestDatabase, createTestDatabase, validRecipeInput } from './pg-harness';
import { feeLock, feeSettlements, newWallet, position, purchase, redeem } from './economics-harness';

// -----------------------------------------------------------------------------
// Performance fee is IMMUTABLE after the first EXTERNAL investment (migration
// 0033) — proven against a real PostgreSQL through the production RPCs,
// triggers and bag-repo code, including every direct-write bypass a script
// with service-role access could attempt.
// -----------------------------------------------------------------------------

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});

const E18 = BigInt(10) ** BigInt(18);
const shares = (n: number) => (BigInt(n) * E18).toString();
let slug = 0;

async function bagWithFee(feeBps: number) {
  const creator = await newWallet(db);
  const created = await createBag(db.client, {
    slug: `fee-lock-${Date.now()}-${slug++}`,
    creatorId: creator.userId,
    mutability: 'MUTABLE',
    recipe: validRecipeInput({ performanceFeeBps: feeBps }),
    reason: 'test',
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return { creator, bag: created.bag, version: created.version };
}

const newVersion = (bagId: string, createdBy: string, feeBps: number, assets = validRecipeInput().assets) =>
  createBagVersion(db.client, { bagId, createdBy, reason: 'edit', recipe: validRecipeInput({ performanceFeeBps: feeBps, assets }) });

/** A composition that differs from validRecipeInput()'s (weights swapped) — for "composition change, same fee" cases. */
function otherAssets() {
  const a = validRecipeInput().assets.map((x) => ({ ...x }));
  const w = a[0].weightBps;
  a[0].weightBps = a[1].weightBps;
  a[1].weightBps = w;
  return a;
}

describe('before the first external investment', () => {
  it('the creator may change the fee (a fee-only version is a real change, not NO_COMPOSITION_CHANGE)', async () => {
    const { creator, bag } = await bagWithFee(1000);
    const up = await newVersion(bag.id, creator.userId, 2000);
    expect(up.ok).toBe(true);
    const down = await newVersion(bag.id, creator.userId, 0);
    expect(down.ok).toBe(true);
    expect((await feeLock(db, bag.id)).performance_fee_locked_at).toBeNull();
  });

  it('creator-only activity (the creator buying into their own Bag) does NOT lock the fee', async () => {
    const { creator, bag } = await bagWithFee(1000);
    await purchase(db, { ...creator, bagId: bag.id, sharesRaw: shares(10), costBasis: '100' });
    expect(await feeLock(db, bag.id)).toEqual({ performance_fee_locked_at: null, performance_fee_bps_locked: null });
    expect((await newVersion(bag.id, creator.userId, 2500)).ok).toBe(true);
  });

  it('fee 0 is a valid fee and changes freely', async () => {
    const { creator, bag } = await bagWithFee(0);
    expect((await newVersion(bag.id, creator.userId, 500)).ok).toBe(true);
  });
});

describe('after the first external investment', () => {
  async function lockedBag(feeBps: number) {
    const s = await bagWithFee(feeBps);
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: s.bag.id, sharesRaw: shares(10), costBasis: '100' });
    return { ...s, investor };
  }

  it('locks at the fee in force at that moment', async () => {
    const { bag } = await lockedBag(1500);
    const lock = await feeLock(db, bag.id);
    expect(lock.performance_fee_locked_at).not.toBeNull();
    expect(lock.performance_fee_bps_locked).toBe(1500);
    expect((await getBagById(db.client, bag.id))?.performanceFeeBpsLocked).toBe(1500);
  });

  it('a fee INCREASE is rejected', async () => {
    const { creator, bag } = await lockedBag(1000);
    expect(await newVersion(bag.id, creator.userId, 2000)).toEqual({ ok: false, error: 'PERFORMANCE_FEE_LOCKED', lockedBps: 1000 });
  });

  it('a fee DECREASE is rejected too (immutable, not just "no increases")', async () => {
    const { creator, bag } = await lockedBag(1000);
    expect(await newVersion(bag.id, creator.userId, 500)).toEqual({ ok: false, error: 'PERFORMANCE_FEE_LOCKED', lockedBps: 1000 });
    expect(await newVersion(bag.id, creator.userId, 0)).toEqual({ ok: false, error: 'PERFORMANCE_FEE_LOCKED', lockedBps: 1000 });
  });

  it('a composition change that KEEPS the locked fee is still allowed', async () => {
    const { creator, bag } = await lockedBag(1000);
    const r = await newVersion(bag.id, creator.userId, 1000, otherAssets());
    expect(r.ok).toBe(true);
  });

  it('the lock is permanent: it survives every external investor fully redeeming', async () => {
    const { creator, bag, investor } = await lockedBag(1000);
    await redeem(db, { ...investor, bagId: bag.id, creatorId: creator.userId, sharesRaw: shares(10), redeemValueQuote: '100', feeBps: 1000 });
    expect((await position(db, investor.userId, bag.id))?.shares_raw).toBe('0');
    expect(await newVersion(bag.id, creator.userId, 2000)).toMatchObject({ ok: false, error: 'PERFORMANCE_FEE_LOCKED' });
  });
});

describe('database-authoritative: direct writes cannot bypass the lock', () => {
  async function locked() {
    const s = await bagWithFee(1000);
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: s.bag.id, sharesRaw: shares(1), costBasis: '10' });
    return s;
  }
  const rejects = async (sql: string, params: unknown[]) => {
    await expect(db.service.query(sql, params)).rejects.toThrow(/PERFORMANCE_FEE_LOCKED/);
  };

  it('create_bag_version RPC with another fee', async () => {
    const { creator, bag } = await locked();
    await rejects(`select create_bag_version($1, 'h2', $2::jsonb, $3, 'bypass')`, [bag.id, JSON.stringify(validRecipeInput({ performanceFeeBps: 3000 })), creator.userId]);
  });

  it('raw INSERT into bag_versions', async () => {
    const { creator, bag } = await locked();
    await rejects(`insert into bag_versions (bag_id, version, composition_hash, recipe, created_by) values ($1, 99, 'h', $2::jsonb, $3)`, [
      bag.id,
      JSON.stringify({ performanceFeeBps: 0 }),
      creator.userId,
    ]);
  });

  it('raw UPDATE of the current version\'s recipe fee', async () => {
    const { bag } = await locked();
    await rejects(`update bag_versions set recipe = jsonb_set(recipe, '{performanceFeeBps}', '2500') where bag_id = $1`, [bag.id]);
  });

  it('clearing or altering the lock columns', async () => {
    const { bag } = await locked();
    await rejects(`update bags set performance_fee_locked_at = null, performance_fee_bps_locked = null where id = $1`, [bag.id]);
    await rejects(`update bags set performance_fee_bps_locked = 3000 where id = $1`, [bag.id]);
  });

  it('pointing current_version_id back at an older version with a different fee', async () => {
    const creator = await newWallet(db);
    const created = await createBag(db.client, { slug: `fee-roll-${Date.now()}`, creatorId: creator.userId, mutability: 'MUTABLE', recipe: validRecipeInput({ performanceFeeBps: 3000 }), reason: 't' });
    if (!created.ok) throw new Error('create');
    const v1 = created.version.id; // 3000 bps
    expect((await newVersion(created.bag.id, creator.userId, 500)).ok).toBe(true); // v2 = 500 bps, current
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: created.bag.id, sharesRaw: shares(1), costBasis: '10' }); // locks at 500
    await rejects(`update bags set current_version_id = $2 where id = $1`, [created.bag.id, v1]);
  });

  it('an out-of-range fee is refused by the database even on an unlocked Bag', async () => {
    const { creator, bag } = await bagWithFee(0);
    await expect(
      db.service.query(`insert into bag_versions (bag_id, version, composition_hash, recipe, created_by) values ($1, 50, 'h', $2::jsonb, $3)`, [
        bag.id,
        JSON.stringify({ performanceFeeBps: 5000 }),
        creator.userId,
      ])
    ).rejects.toThrow(/INVALID_PERFORMANCE_FEE/);
  });
});

describe('redemption uses the LOCKED rate; existing fee rules unchanged', () => {
  it('the RPC charges the locked rate even if the caller passes another rate', async () => {
    const { creator, bag } = await bagWithFee(1000);
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: bag.id, sharesRaw: shares(10), costBasis: '100' });
    // Sell half for 80 → consumed basis 50 → profit 30 → 10% = 3.00 (a caller-supplied 30% is ignored).
    const r = await redeem(db, { ...investor, bagId: bag.id, creatorId: creator.userId, sharesRaw: shares(5), redeemValueQuote: '80', feeBps: 3000 });
    expect(Number(r.result.feeAmount)).toBe(3);
    expect(await feeSettlements(db, bag.id)).toEqual([{ gross_amount_quote: '3.00', source_redeem_intent_id: r.intentId }]);
    const pos = await position(db, investor.userId, bag.id);
    expect(pos?.shares_raw).toBe(shares(5));
    expect(Number(pos?.cost_basis_quote)).toBe(50); // proportional consumption: half the shares → half the basis
  });

  it('no fee on a loss, no fee at a locked rate of 0, no fee on the creator\'s own redemption', async () => {
    const loss = await bagWithFee(2000);
    const inv = await newWallet(db);
    await purchase(db, { ...inv, bagId: loss.bag.id, sharesRaw: shares(10), costBasis: '100' });
    await redeem(db, { ...inv, bagId: loss.bag.id, creatorId: loss.creator.userId, sharesRaw: shares(10), redeemValueQuote: '60', feeBps: 2000 });
    expect(await feeSettlements(db, loss.bag.id)).toEqual([]);

    const zero = await bagWithFee(0);
    const inv0 = await newWallet(db);
    await purchase(db, { ...inv0, bagId: zero.bag.id, sharesRaw: shares(10), costBasis: '100' });
    await redeem(db, { ...inv0, bagId: zero.bag.id, creatorId: zero.creator.userId, sharesRaw: shares(10), redeemValueQuote: '500', feeBps: 3000 });
    expect(await feeSettlements(db, zero.bag.id)).toEqual([]);

    const own = await bagWithFee(2000);
    const outsider = await newWallet(db);
    await purchase(db, { ...outsider, bagId: own.bag.id, sharesRaw: shares(1), costBasis: '10' }); // locks the fee
    await purchase(db, { ...own.creator, bagId: own.bag.id, sharesRaw: shares(10), costBasis: '100' });
    await redeem(db, { ...own.creator, bagId: own.bag.id, creatorId: own.creator.userId, sharesRaw: shares(10), redeemValueQuote: '300', feeBps: 2000 });
    expect(await feeSettlements(db, own.bag.id)).toEqual([]);
  });
});

describe('fork behavior (explicit)', () => {
  it('a fork is a NEW Bag: unlocked, independent of the parent\'s lock (the fork route also resets its fee to 0)', async () => {
    const parent = await bagWithFee(1000);
    const investor = await newWallet(db);
    await purchase(db, { ...investor, bagId: parent.bag.id, sharesRaw: shares(1), costBasis: '10' });
    expect((await feeLock(db, parent.bag.id)).performance_fee_bps_locked).toBe(1000);

    const forker = await newWallet(db);
    const fork = await createBag(db.client, {
      slug: `fork-${Date.now()}`,
      creatorId: forker.userId,
      mutability: 'MUTABLE',
      recipe: validRecipeInput({ performanceFeeBps: 0 }),
      reason: 'fork',
      parentBagId: parent.bag.id,
      rootBagId: parent.bag.id,
    });
    if (!fork.ok) throw new Error('fork');
    expect(await feeLock(db, fork.bag.id)).toEqual({ performance_fee_locked_at: null, performance_fee_bps_locked: null });
    // The forker can set their own fee until THEIR first external investor…
    expect((await newVersion(fork.bag.id, forker.userId, 700)).ok).toBe(true);
    // …and the parent stays locked regardless.
    expect((await feeLock(db, parent.bag.id)).performance_fee_bps_locked).toBe(1000);
  });
});
