import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { createBagVersion } from '@/lib/server/bag-repo';
import { getDeployedOnChainBagId } from '@/lib/server/bag-deployment-repo';
import { confirmBagDeployment, getBagDeploymentState, prepareBagDeployment, DeploymentSession } from '@/lib/server/deploy-bag';
import { ChainId } from '@/types/basket-protocol';
import { FAKE_CHAIN_ID, FAKE_FACTORY, FakeChain, decodeCreateBag } from './fake-chain';
import { TestDatabase, bagRow, createDraftBag, createTestDatabase, deploymentRows, insertUser, validRecipeInput } from './pg-harness';

// -----------------------------------------------------------------------------
// INTEGRATION (real PostgreSQL + REAL orchestrator code) with a FAKE CHAIN.
// prepareBagDeployment / confirmBagDeployment / bag-repo / bag-deployment-repo
// and every RPC and constraint below are the production code and schema. Only
// "what the blockchain answers" is a test double (see fake-chain.ts) — so this
// proves the application + database behaviour, NOT that a real chain accepts the
// transaction (that is bag-deployment-local-evm.integration.test.ts, and, for a
// real network, not available in this environment).
// -----------------------------------------------------------------------------

let db: TestDatabase;
let chain: FakeChain;
const resolvedChains: ChainId[] = [];
const deps = () => ({
  resolveAdapter: (c: ChainId) => {
    resolvedChains.push(c);
    return chain;
  },
});

beforeAll(async () => {
  db = await createTestDatabase({ mode: 'fresh' });
});
afterAll(async () => {
  await db?.drop();
});
afterEach(() => {
  resolvedChains.length = 0;
});

let n = 0;
async function scenario() {
  chain = new FakeChain();
  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const userId = await insertUser(db, wallet);
  const { bag, version } = await createDraftBag(db, userId);
  const session: DeploymentSession = { userId, walletAddress: wallet };
  const offChainRef = computeOnChainBagId(bag.id);
  const compositionHash = computeOnChainCompositionHash(version.recipe.assets);
  /** What the person's wallet does after prepare: signs + sends createBag, returns the tx hash. */
  const userSends = (o: Partial<Parameters<FakeChain['submit']>[0]> = {}) => chain.submit({ from: wallet, offChainRef, compositionHash, ...o });
  return { bag, version, userId, wallet, session, offChainRef, compositionHash, userSends, seq: ++n };
}

const expectNoDeploymentState = async (bagId: string) => {
  expect(await deploymentRows(db, bagId)).toEqual([]);
  expect((await bagRow(db, bagId)).status).toBe('DRAFT');
};

// ------------------------------------------------------------------ Scenario A
describe('A. prepare — stateless, and the Bag stays DRAFT', () => {
  it('returns calldata for the CORRECT factory/chain/args and writes nothing (no row, no DEPLOYING, no status change)', async () => {
    const s = await scenario();
    const r = await prepareBagDeployment(db.client, s.session, s.bag.id, deps());
    if (!r.ok) throw new Error(JSON.stringify(r));

    expect(r.chain).toBe('robinhood'); // derived from the Bag, not from the caller
    expect(resolvedChains).toEqual(['robinhood']);
    expect(r.transaction.to).toBe(FAKE_FACTORY);
    expect(r.transaction.chainId).toBe(FAKE_CHAIN_ID);
    expect(r.factoryAddress).toBe(FAKE_FACTORY);
    expect(r.wallet).toBe(s.wallet); // the ONLY sender confirm will accept
    expect(decodeCreateBag(r.transaction.data)).toEqual({
      functionName: 'createBag',
      offChainRef: s.offChainRef,
      compositionHash: s.compositionHash,
      metadataURI: `bag:${s.bag.id}`,
      isMutable: true, // bags.mutability, recorded on-chain (an IMMUTABLE Bag can never record a new version)
    });
    expect(r.offChainRef).toBe(s.offChainRef);
    expect(r.compositionHash).toBe(s.compositionHash);

    await expectNoDeploymentState(s.bag.id);
  });

  it('is repeatable and leaves nothing behind however often it is called', async () => {
    const s = await scenario();
    for (let i = 0; i < 4; i++) expect((await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).ok).toBe(true);
    await expectNoDeploymentState(s.bag.id);
  });

  it('an unauthorised (non-owner) session is FORBIDDEN and gets no calldata', async () => {
    const s = await scenario();
    const intruderWallet = `0x${crypto.randomBytes(20).toString('hex')}`;
    const intruder = { userId: await insertUser(db, intruderWallet), walletAddress: intruderWallet };
    expect(await prepareBagDeployment(db.client, intruder, s.bag.id, deps())).toEqual({ ok: false, error: 'FORBIDDEN' });
    await expectNoDeploymentState(s.bag.id);
  });

  it('a session with no valid wallet address is refused', async () => {
    const s = await scenario();
    for (const walletAddress of ['', 'nope', '0x12']) {
      expect(await prepareBagDeployment(db.client, { userId: s.userId, walletAddress }, s.bag.id, deps())).toEqual({ ok: false, error: 'NO_WALLET_ON_SESSION' });
    }
  });

  it('unknown Bag → BAG_NOT_FOUND; archived Bag → BAG_ARCHIVED', async () => {
    const s = await scenario();
    expect(await prepareBagDeployment(db.client, s.session, '00000000-0000-0000-0000-00000000f00d', deps())).toEqual({ ok: false, error: 'BAG_NOT_FOUND' });
    await db.admin.query(`update bags set status = 'ARCHIVED' where id = $1`, [s.bag.id]);
    expect(await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).toEqual({ ok: false, error: 'BAG_ARCHIVED' });
  });

  it('FAILS CLOSED when the chain is not configured — no mock fallback in ANY environment', async () => {
    const s = await scenario();
    const saved = { f: process.env.FACTORY_ADDRESS_ROBINHOOD, n: process.env.NODE_ENV };
    delete process.env.FACTORY_ADDRESS_ROBINHOOD;
    try {
      for (const env of ['test', 'development', 'production']) {
        (process.env as Record<string, string>).NODE_ENV = env;
        const r = await prepareBagDeployment(db.client, s.session, s.bag.id); // default (real) resolver, no injection
        expect(r).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
        const c = await confirmBagDeployment(db.client, s.session, s.bag.id, `0x${'ab'.repeat(32)}`);
        expect(c).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
      }
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.n;
      if (saved.f !== undefined) process.env.FACTORY_ADDRESS_ROBINHOOD = saved.f;
    }
    await expectNoDeploymentState(s.bag.id);
  });

  it('refuses to hand out a transaction that would only revert (a Bag for this wallet already exists on-chain)', async () => {
    const s = await scenario();
    s.userSends(); // an earlier, never-confirmed success
    expect(await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).toEqual({ ok: false, error: 'ALREADY_CREATED_ON_CHAIN' });
    await expectNoDeploymentState(s.bag.id);
  });
});

// ------------------------------------------------------------------ Scenario B
describe('B. successful confirmation: DRAFT → DEPLOYED → ACTIVE, and ONLY then', () => {
  it('prepare → wallet sends → confirm: deployment recorded from the CHAIN, Bag finalized in the same step', async () => {
    const s = await scenario();
    expect((await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).ok).toBe(true);
    expect((await bagRow(db, s.bag.id)).status).toBe('DRAFT'); // prepare succeeded — still DRAFT

    const txHash = s.userSends();
    expect((await bagRow(db, s.bag.id)).status).toBe('DRAFT'); // wallet signed + sent, hash exists — still DRAFT
    expect(await getDeployedOnChainBagId(db.client, s.bag.id, 'robinhood')).toBeNull();

    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps());
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.alreadyConfirmed).toBe(false);
    expect(r.deployment).toMatchObject({ status: 'DEPLOYED', chain: 'robinhood', txHash, onChainCreator: s.wallet, factoryAddress: FAKE_FACTORY });
    expect(r.bag).toMatchObject({ status: 'ACTIVE', registryId: 'robinhood' });

    expect(await bagRow(db, s.bag.id)).toMatchObject({ status: 'ACTIVE', registry_id: 'robinhood', contract_address: r.deployment.contractAddress });
    expect(await deploymentRows(db, s.bag.id)).toHaveLength(1);
    // execution reads the PERSISTED on-chain id, which came from the chain's event, not from a derivation
    expect(await getDeployedOnChainBagId(db.client, s.bag.id, 'robinhood')).toBe(r.deployment.onChainBagId);
  });

  it('the read-state endpoint logic reports the authoritative state (owner only)', async () => {
    const s = await scenario();
    expect(await getBagDeploymentState(db.client, s.session, s.bag.id)).toMatchObject({ ok: true, bagStatus: 'DRAFT', deployment: null });
    await confirmBagDeployment(db.client, s.session, s.bag.id, s.userSends(), deps());
    expect(await getBagDeploymentState(db.client, s.session, s.bag.id)).toMatchObject({ ok: true, bagStatus: 'ACTIVE', deployment: { status: 'DEPLOYED' } });
    const stranger = { userId: await insertUser(db, `0x${crypto.randomBytes(20).toString('hex')}`), walletAddress: s.wallet };
    expect(await getBagDeploymentState(db.client, stranger, s.bag.id)).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('a non-owner cannot confirm someone else\'s transaction for a Bag they do not own', async () => {
    const s = await scenario();
    const txHash = s.userSends();
    const intruder = { userId: await insertUser(db, `0x${crypto.randomBytes(20).toString('hex')}`), walletAddress: s.wallet };
    expect(await confirmBagDeployment(db.client, intruder, s.bag.id, txHash, deps())).toEqual({ ok: false, error: 'FORBIDDEN' });
    // Rejected by the application layer BEFORE any chain read — not merely caught later by the RPC's own in-transaction
    // creator check (which also exists, and is covered in bag-deployment-db.integration.test.ts).
    expect(chain.verifyCalls).toBe(0);
    await expectNoDeploymentState(s.bag.id);
  });
});

describe('B2. nothing but a verified deployment can make a Bag ACTIVE (and failures leave no trace)', () => {
  it('USER REJECTION: prepare, then the wallet prompt is rejected — no row, still DRAFT, and prepare can simply be retried', async () => {
    const s = await scenario();
    expect((await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).ok).toBe(true);
    // …the person rejects the signature: nothing is sent, nothing else is called.
    await expectNoDeploymentState(s.bag.id);
    expect((await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).ok).toBe(true);
    await expectNoDeploymentState(s.bag.id);
  });

  it('WALLET SWITCHING: a transaction sent from a different wallet than the session wallet is rejected — the sender is never "repaired"', async () => {
    const s = await scenario();
    const otherWallet = `0x${crypto.randomBytes(20).toString('hex')}`;
    const txHash = s.userSends({ from: otherWallet });
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps());
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/sender/) });
    await expectNoDeploymentState(s.bag.id);
  });

  it('a REVERTED transaction is rejected', async () => {
    const s = await scenario();
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, s.userSends({ status: 'reverted' }), deps())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    await expectNoDeploymentState(s.bag.id);
  });

  it('a transaction sent to the WRONG contract is rejected', async () => {
    const s = await scenario();
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, s.userSends({ to: `0x${'12'.repeat(20)}` }), deps())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    await expectNoDeploymentState(s.bag.id);
  });

  it('a transaction for a DIFFERENT Bag (wrong offChainRef) is rejected', async () => {
    const s = await scenario();
    const other = await createDraftBag(db, s.userId);
    const txForOtherBag = chain.submit({ from: s.wallet, offChainRef: computeOnChainBagId(other.bag.id), compositionHash: s.compositionHash });
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txForOtherBag, deps())).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED' });
    await expectNoDeploymentState(s.bag.id);
  });

  it('PENDING is not failure: an un-mined transaction answers PENDING, writes nothing, and the SAME confirm succeeds once it is mined', async () => {
    const s = await scenario();
    const txHash = s.userSends({ mined: false });
    for (let i = 0; i < 3; i++) {
      expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps())).toMatchObject({ ok: false, error: 'PENDING' });
      await expectNoDeploymentState(s.bag.id); // pending ≠ deployed ≠ ACTIVE
    }
    chain.mine(txHash);
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps())).toMatchObject({ ok: true, alreadyConfirmed: false });
    expect((await bagRow(db, s.bag.id)).status).toBe('ACTIVE');
  });

  it('an unknown / invalid tx hash is rejected without touching the chain or the database', async () => {
    const s = await scenario();
    for (const bad of ['', 'nope', '0x1234', `0x${'zz'.repeat(32)}`]) {
      expect(await confirmBagDeployment(db.client, s.session, s.bag.id, bad, deps())).toEqual({ ok: false, error: 'INVALID_TX_HASH' });
    }
    expect(chain.verifyCalls).toBe(0);
    await expectNoDeploymentState(s.bag.id);
    expect(await confirmBagDeployment(db.client, s.session, s.bag.id, `0x${'cd'.repeat(32)}`, deps())).toMatchObject({ ok: false, error: 'PENDING' });
  });

  it('STALE RECIPE: the composition hash is re-derived from the CURRENT database version at confirm time, not taken from prepare', async () => {
    const s = await scenario();
    const prepared = await prepareBagDeployment(db.client, s.session, s.bag.id, deps());
    if (!prepared.ok) throw new Error('prepare failed');
    const txHash = s.userSends(); // signed against the v1 composition…

    // …then the creator edits the recipe (a REAL new version, through the real repository/RPC).
    const edited = validRecipeInput({
      assets: [
        { chain: 'robinhood', address: '0x11111111111111111111111111111111111111aa', symbol: 'BTC', decimals: 18, weightBps: 5000 },
        { chain: 'robinhood', address: '0x22222222222222222222222222222222222222bb', symbol: 'ETH', decimals: 18, weightBps: 5000 },
      ],
    });
    const v2 = await createBagVersion(db.client, { bagId: s.bag.id, recipe: edited, createdBy: s.userId, reason: 'edit before confirm' });
    expect(v2.ok).toBe(true);
    expect(computeOnChainCompositionHash(edited.assets)).not.toBe(s.compositionHash);

    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps());
    expect(r).toMatchObject({ ok: false, error: 'VERIFICATION_FAILED', message: expect.stringMatching(/compositionHash/) });
    await expectNoDeploymentState(s.bag.id);
  });
});

// ------------------------------------------------------------------ Scenario C
describe('C. duplicate confirmation is idempotent (refresh, retry, double-click)', () => {
  it('DEPLOYED → DEPLOYED: the same confirmation N times, in any hash casing, succeeds with ONE row and no rewrite', async () => {
    const s = await scenario();
    const txHash = s.userSends();
    const first = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps());
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first.alreadyConfirmed).toBe(false);
    const stored = (await deploymentRows(db, s.bag.id))[0];

    for (const casing of [txHash, `0x${txHash.slice(2).toUpperCase()}`, txHash]) {
      const again = await confirmBagDeployment(db.client, s.session, s.bag.id, casing, deps());
      if (!again.ok) throw new Error(JSON.stringify(again));
      expect(again.alreadyConfirmed).toBe(true);
      expect(again.deployment.id).toBe(first.deployment.id);
      expect(again.bag.status).toBe('ACTIVE');
    }
    const rows = await deploymentRows(db, s.bag.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toEqual(stored.updated_at);
  });

  it('after it is deployed, prepare refuses with ALREADY_DEPLOYED (no second transaction is ever offered)', async () => {
    const s = await scenario();
    await confirmBagDeployment(db.client, s.session, s.bag.id, s.userSends(), deps());
    expect(await prepareBagDeployment(db.client, s.session, s.bag.id, deps())).toMatchObject({ ok: false, error: 'ALREADY_DEPLOYED' });
  });
});

// ------------------------------------------------------------------ Scenario D
describe('D. conflicting confirmation is rejected and never overwrites the original', () => {
  it('DEPLOYED → conflict: a DIFFERENT (even chain-valid) transaction for the same Bag is refused; the original stands', async () => {
    const s = await scenario();
    const original = s.userSends();
    const first = await confirmBagDeployment(db.client, s.session, s.bag.id, original, deps());
    if (!first.ok) throw new Error(JSON.stringify(first));
    const before = await deploymentRows(db, s.bag.id);

    const second = s.userSends(); // a second tx the (fake) chain considers valid
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, second, deps());
    expect(r).toMatchObject({ ok: false, error: 'CONFLICTING_DEPLOYMENT', deployment: { txHash: original } });

    const after = await deploymentRows(db, s.bag.id);
    expect(after).toEqual(before); // byte-for-byte untouched
    expect(chain.verifyCalls).toBe(1); // the conflict was decided from our own record, no second chain call needed
  });
});

// ------------------------------------------------------------------ Scenario E
describe('E. concurrent confirmations — only one deployment becomes authoritative', () => {
  it('10 simultaneous confirms of the SAME tx (fresh connections racing) → all succeed, exactly one is the writer, ONE row', async () => {
    for (let round = 0; round < 4; round++) {
      const s = await scenario();
      const txHash = s.userSends();
      const results = await Promise.all(Array.from({ length: 10 }, () => confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps())));
      for (const r of results) expect(r.ok).toBe(true);
      const writers = results.filter((r) => r.ok && !r.alreadyConfirmed);
      expect(writers).toHaveLength(1);
      expect(await deploymentRows(db, s.bag.id)).toHaveLength(1);
      expect((await bagRow(db, s.bag.id)).status).toBe('ACTIVE');
    }
  });

  it('10 simultaneous confirms of DIFFERENT valid transactions → exactly one wins, the rest CONFLICT, the winner is what is stored', async () => {
    for (let round = 0; round < 4; round++) {
      const s = await scenario();
      const hashes = Array.from({ length: 10 }, () => s.userSends());
      const results = await Promise.all(hashes.map((h) => confirmBagDeployment(db.client, s.session, s.bag.id, h, deps()).then((r) => ({ r, h }))));
      const winners = results.filter((x) => x.r.ok);
      expect(winners).toHaveLength(1);
      expect(results.filter((x) => !x.r.ok && (x.r as { error: string }).error === 'CONFLICTING_DEPLOYMENT')).toHaveLength(9);
      const rows = await deploymentRows(db, s.bag.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tx_hash).toBe(winners[0].h);
    }
  });
});

// ------------------------------------------------------------------ trust boundary
describe('trust boundary — the client controls only txHash', () => {
  it('the deployment API of the orchestrator has no client-supplied wallet or chain parameter at all', () => {
    // prepare(admin, session, bagId, deps?) / confirm(admin, session, bagId, txHash, deps?) — `deps` is a server-side seam, never request data.
    expect(prepareBagDeployment.length).toBeLessThanOrEqual(4);
    expect(confirmBagDeployment.length).toBeLessThanOrEqual(5);
  });

  it('the chain used is ALWAYS the Bag\'s own (a base-chain Bag resolves the adapter for base, not for anything the caller could say)', async () => {
    chain = new FakeChain();
    const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
    const userId = await insertUser(db, wallet);
    const { bag } = await createDraftBag(db, userId, validRecipeInput({ chain: 'base', assets: validRecipeInput().assets.map((a) => ({ ...a, chain: 'base' as const })) }));
    await prepareBagDeployment(db.client, { userId, walletAddress: wallet }, bag.id, deps());
    expect(resolvedChains).toEqual(['base']);
  });
});

// ------------------------------------------------------------------ legacy vs Bag Router eligibility
// Reproduces migration 0024's own backfill (`on_chain_bag_id = '0x' || lpad(replace(bag_id,'-',''),64,'0')`,
// `on_chain_creator` left NULL) directly against the database, exactly as a pre-user-signed-flow DEPLOYED row
// looks today, WITHOUT going through confirmBagDeployment (which can never itself produce such a row any more).
describe('F. legacy (creator-less) deployments never resolve an on-chain id for the Bag Router', () => {
  it('a legacy DEPLOYED row (on_chain_creator IS NULL) is invisible to getDeployedOnChainBagId — the Bag Router path falls back, it never gets handed the legacy id', async () => {
    const s = await scenario();
    const legacyOnChainBagId = `0x${s.bag.id.replace(/-/g, '').padStart(64, '0')}`;
    // Same "DEPLOYED deployment + ACTIVE bag" invariant migration 0024's own deferred constraint triggers
    // enforce (assert_deployed_bag_not_draft) — set inside the SAME transaction, on the SAME connection, as
    // the deployment insert (the way the real confirm_bag_deployment RPC does — the trigger is deferred to
    // COMMIT), so this fixture is itself a valid legacy-shaped state rather than one the schema would reject.
    // `db.admin` is a pool: BEGIN/COMMIT must share one checked-out connection, not one per `.query()` call.
    const conn = await db.admin.connect();
    try {
      await conn.query('begin');
      await conn.query(
        `insert into bag_deployments (bag_id, chain, status, factory_address, contract_address, tx_hash, block_number, on_chain_bag_id, on_chain_creator)
         values ($1, 'robinhood', 'DEPLOYED', $2, $2, $3, 1, $4, NULL)`,
        [s.bag.id, `0x${'aa'.repeat(20)}`, `0x${'bb'.repeat(32)}`, legacyOnChainBagId]
      );
      await conn.query(`update bags set status = 'ACTIVE', registry_id = 'robinhood', contract_address = $2 where id = $1`, [s.bag.id, `0x${'aa'.repeat(20)}`]);
      await conn.query('commit');
    } catch (err) {
      await conn.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }

    // The row genuinely exists and is DEPLOYED (so the Bag itself is ACTIVE, execution is otherwise normal) —
    // it's specifically the creator-bound on-chain id lookup that must refuse it.
    expect(await deploymentRows(db, s.bag.id)).toHaveLength(1);
    expect(await getDeployedOnChainBagId(db.client, s.bag.id, 'robinhood')).toBeNull();
  });

  it('a real user-signed (creator-bound) DEPLOYED row DOES resolve an on-chain id — the positive case is unaffected', async () => {
    const s = await scenario();
    const txHash = s.userSends();
    const r = await confirmBagDeployment(db.client, s.session, s.bag.id, txHash, deps());
    if (!r.ok) throw new Error(JSON.stringify(r));

    expect(r.deployment.onChainCreator).toBe(s.wallet);
    expect(await getDeployedOnChainBagId(db.client, s.bag.id, 'robinhood')).toBe(r.deployment.onChainBagId);
  });
});
