import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, parseEventLogs, toHex, zeroAddress, type Hex } from 'viem';
import { DCA_TYPES } from './helpers/dca-types';
import { assertNothingMoved, ceilingMinTs, clone, compositionHash, DAY, E18, legAmountsTs, REVOCATION_TYPES, rng, setup, snapshot, USDG, type Asset, type Auth } from './helpers/dca-fixture';

// -----------------------------------------------------------------------------
// LOCAL CONTRACT TESTS (Hardhat in-process EVM) for contracts/dca/BagDcaExecutor
// and UniswapV3ExactInAdapter. The BAG registry is the REAL BagFactory/Bag and
// StrategyRegistry from this repo; Uniswap and the tokens are local mocks
// (contracts/mocks/dca/DcaV1Mocks.sol). These are NOT fork or mainnet tests;
// the fork test is contracts/test/fork/BagDcaExecutor.fork.test.ts.
// -----------------------------------------------------------------------------

describe('BagDcaExecutor — happy path and events', () => {
  it('pulls exactly one run from the owner, delivers every asset to the signed recipient, emits one AssetDelivered per asset', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt + 10n);
    const before = await snapshot(c, a);
    const receipt = await c.execute(a, sig);

    assert.equal(before.owner - (await c.bal(c.usdg, a.owner)), USDG(10));
    assert.equal(await c.bal(c.usdg, c.executor.address), 0n, 'executor keeps no input');
    assert.equal(await c.bal(c.usdg, c.adapter.address), 0n, 'adapter keeps no input');
    assert.equal(await c.usdg.read.allowance([c.executor.address, c.adapter.address]), 0n);
    assert.equal(await c.usdg.read.allowance([c.adapter.address, c.router.address]), 0n);
    // 5 USDG per leg: NVDA at 200 → 0.025, TSLA at 400 → 0.0125.
    assert.equal((await c.bal(c.nvda, a.recipient)) - before.nvda, 25n * 10n ** 15n);
    assert.equal((await c.bal(c.tsla, a.recipient)) - before.tsla, 125n * 10n ** 14n);
    assert.equal(await c.bal(c.nvda, a.owner), 0n, 'nothing goes to the owner when the recipient differs');

    const logs = parseEventLogs({ abi: c.executor.abi, logs: receipt.logs });
    const delivered = logs.filter((l) => l.eventName === 'AssetDelivered') as any[];
    const executed = logs.filter((l) => l.eventName === 'PurchaseExecuted') as any[];
    assert.equal(delivered.length, 2);
    assert.equal(executed.length, 1);
    const id = c.idOf(a);
    for (const [i, l] of delivered.entries()) {
      const asset = a.assets[i];
      assert.equal(l.args.owner.toLowerCase(), a.owner.toLowerCase());
      assert.equal(l.args.authorizationId, id);
      assert.equal(l.args.executionIndex, 0n);
      assert.equal(l.args.recipient.toLowerCase(), a.recipient.toLowerCase());
      assert.equal(l.args.token.toLowerCase(), asset.asset.toLowerCase());
      assert.equal(l.args.minReceived, ceilingMinTs(USDG(5), asset));
      assert.ok(l.args.balanceAfter - l.args.balanceBefore >= l.args.minReceived);
    }
    assert.equal(executed[0].args.window, 0n);
    assert.equal(executed[0].args.amountIn, USDG(10));
    assert.equal(executed[0].args.assetCount, 2n);
    const st = await c.state(a);
    assert.equal(st.runs, 1);
    assert.equal(st.spent, USDG(10));
    assert.equal(st.lastWindow, 0n);
  });

  it('the authorization id equals the EIP-712 digest (viem) and the domain binds chain id and executor', async () => {
    const c = await setup();
    assert.equal(await c.executor.read.authorizationIdOf([c.auth]), c.idOf(c.auth));
    const other = hashTypedData({ domain: { ...c.domain, chainId: c.chainId + 1 }, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: c.auth });
    assert.notEqual(other, c.idOf(c.auth));
    assert.equal(await c.executor.read.chainLabel(), 'robinhood');
    assert.equal(((await c.executor.read.swapRouter()) as string).toLowerCase(), c.router.address.toLowerCase());
  });

  it('runs once per window over the whole schedule, then stops (Exhausted / Expired)', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    for (let k = 0n; k < 5n; k++) {
      await c.at(a.schedule.startsAt + k * DAY + 5n);
      await c.execute(a, sig);
    }
    const st = await c.state(a);
    assert.equal(st.runs, 5);
    assert.equal(st.spent, a.schedule.totalBudget);
    assert.equal(await c.bal(c.usdg, a.owner), USDG(1000) - USDG(50));
    await c.at(a.schedule.expiresAt - 1n);
    await assert.rejects(c.execute(a, sig, { window: 4n }), /NotDue|Exhausted/);
    await c.at(a.schedule.expiresAt + 1n);
    await assert.rejects(c.execute(a, sig, { window: 5n }), /Expired/);
  });
});

describe('BagDcaExecutor — authorization, signatures, replay, revocation', () => {
  it('rejects a signature by anyone but the owner, and a signature for another chain or executor', async () => {
    const c = await setup();
    const a = c.auth;
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, await c.sign(a, c.other)), /InvalidOwnerSignature/);
    const otherChain = await c.owner.signTypedData({ account: c.owner.account, domain: { ...c.domain, chainId: c.chainId + 1 }, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
    await assert.rejects(c.execute(a, otherChain), /InvalidOwnerSignature/);
    const otherExecutor = await c.owner.signTypedData({ account: c.owner.account, domain: { ...c.domain, verifyingContract: c.router.address }, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
    await assert.rejects(c.execute(a, otherExecutor), /InvalidOwnerSignature/);
  });

  it('a keeper cannot change any signed field: recipient, amounts, price limits, assets, route, nonce', async () => {
    const c = await setup();
    const sig = await c.sign(c.auth);
    await c.at(c.auth.schedule.startsAt + 1n);
    const tamper: ((a: Auth) => void)[] = [
      (a) => (a.recipient = c.other.account.address),
      (a) => (a.schedule.amountPerRun = USDG(11)),
      (a) => (a.assets[1].maxPriceRaw = USDG(10_000)),
      (a) => (a.route.allowedFees = [100, 500, 3000, 10000]),
      (a) => (a.nonce = 2n),
    ];
    for (const t of tamper) {
      const a = clone(c.auth);
      t(a);
      // Keeper passes the id of the ORIGINAL authorization: the recomputed id differs.
      await assert.rejects(c.execute(a, sig, { id: c.idOf(c.auth) }), /AuthorizationMismatch/);
      // Keeper passes the tampered id: the owner never signed it.
      await assert.rejects(c.execute(a, sig), /InvalidOwnerSignature/);
    }
  });

  it('ERC-1271 smart-account owner: valid while the account accepts the signature, refused once it does not', async () => {
    const c = await setup();
    const wallet = await c.viem.deployContract('DcaMock1271Wallet', [c.owner.account.address]);
    const walletAsSigner = await c.viem.getContractAt('DcaMock1271Wallet', wallet.address, { client: { wallet: c.owner } });
    await c.usdg.write.mint([wallet.address, USDG(100)]);
    await walletAsSigner.write.exec([c.usdg.address, encodeFunctionData({ abi: c.usdg.abi, functionName: 'approve', args: [c.executor.address, USDG(50)] })]);
    const a = clone(c.auth);
    a.owner = wallet.address;
    // A 1271 account validates the raw digest: the owner's key signs the EIP-712 digest.
    const sig = await c.owner.signTypedData({ account: c.owner.account, domain: c.domain, types: DCA_TYPES, primaryType: 'DcaAuthorization', message: a });
    await c.at(a.schedule.startsAt + 1n);
    await c.execute(a, sig);
    assert.equal(await c.bal(c.usdg, wallet.address), USDG(90));
    await walletAsSigner.write.setDisabled([true]);
    await c.at(a.schedule.startsAt + DAY + 1n);
    await assert.rejects(c.execute(a, sig), /InvalidOwnerSignature/);
  });

  it('revocation by the owner stops every later run, works before the first run, and others cannot revoke', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    const id = c.idOf(a);
    const asOther = await c.viem.getContractAt('BagDcaExecutor', c.executor.address, { client: { wallet: c.other } });
    await asOther.write.revoke([id]); // revokes (other, id): not the owner's counter
    await c.at(a.schedule.startsAt + 1n);
    await c.execute(a, sig);
    const asOwner = await c.viem.getContractAt('BagDcaExecutor', c.executor.address, { client: { wallet: c.owner } });
    await asOwner.write.revoke([id]);
    await c.at(a.schedule.startsAt + DAY + 1n);
    const before = await snapshot(c, a);
    await assert.rejects(c.execute(a, sig), /RevokedAuthorization/);
    assert.deepEqual({ ...(await snapshot(c, a)) }, before);
    // before first use
    const b = clone(a);
    b.nonce = 9n;
    await asOwner.write.revoke([c.idOf(b)]);
    await assert.rejects(c.execute(b, await c.sign(b)), /RevokedAuthorization/);
  });

  it('revokeBySig: anyone can submit the owner-signed revocation; a forged one is refused', async () => {
    const c = await setup();
    const a = c.auth;
    const id = c.idOf(a);
    const forged = await c.other.signTypedData({ account: c.other.account, domain: c.domain, types: REVOCATION_TYPES, primaryType: 'Revocation', message: { owner: a.owner, authorizationId: id } });
    await assert.rejects(c.executor.write.revokeBySig([a.owner, id, forged]), /InvalidOwnerSignature/);
    const real = await c.owner.signTypedData({ account: c.owner.account, domain: c.domain, types: REVOCATION_TYPES, primaryType: 'Revocation', message: { owner: a.owner, authorizationId: id } });
    await c.executor.write.revokeBySig([a.owner, id, real]);
    assert.equal((await c.state(a)).revoked, true);
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, await c.sign(a)), /RevokedAuthorization/);
  });

  it('replay: the same window twice, and two runs closer than one period across a window boundary, are refused', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt + DAY - 100n); // late in window 0
    await c.execute(a, sig);
    await c.at(a.schedule.startsAt + DAY - 50n);
    await assert.rejects(c.execute(a, sig), /NotDue/);
    await c.at(a.schedule.startsAt + DAY + 10n); // window 1, but only 110 s after the last run
    await assert.rejects(c.execute(a, sig), /NotDue/);
    await c.at(a.schedule.startsAt + 2n * DAY - 100n); // window 1, a full period after
    await c.execute(a, sig);
    assert.equal((await c.state(a)).runs, 2);
  });
});

describe('BagDcaExecutor — schedule and time', () => {
  it('before start NotDue; wrong planned window WrongWindow; past the keeper deadline RunDeadlinePassed', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt - 1n);
    await assert.rejects(c.execute(a, sig, { window: 0n }), /NotDue/);
    await c.at(a.schedule.startsAt + DAY + 1n);
    await assert.rejects(c.execute(a, sig, { window: 0n }), /WrongWindow/); // planned for window 0, landed in 1
    await c.at(a.schedule.startsAt + DAY + 100n);
    await assert.rejects(c.execute(a, sig, { deadline: a.schedule.startsAt + DAY + 99n }), /RunDeadlinePassed/);
  });

  it('no catch-up: windows missed are lost; a later window allows exactly one run', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt + 3n * DAY + 1n); // windows 0, 1, 2 missed
    await c.execute(a, sig);
    await c.at(a.schedule.startsAt + 3n * DAY + 2n);
    await assert.rejects(c.execute(a, sig), /NotDue/);
    await c.at(a.schedule.startsAt + 4n * DAY + 2n);
    await c.execute(a, sig);
    await c.at(a.schedule.expiresAt);
    await assert.rejects(c.execute(a, sig, { window: 5n }), /Expired/);
    const st = await c.state(a);
    assert.equal(st.runs, 2, 'only 2 of 5 runs happened; the rest of the budget stays in the wallet');
    assert.equal(await c.bal(c.usdg, a.owner), USDG(980));
  });

  it('property: over random block times the contract accepts a run exactly when the calendar model says it is due', async () => {
    const c = await setup();
    const a = clone(c.auth);
    a.schedule = { ...a.schedule, maxRuns: 12, totalBudget: USDG(120), expiresAt: a.schedule.startsAt + 12n * DAY };
    await c.usdgAsOwner.write.approve([c.executor.address, USDG(120)]);
    const sig = await c.sign(a);
    const r = rng(0xdca1);
    let t = a.schedule.startsAt - 3600n;
    let runs = 0;
    let lastWindow = -1n;
    let lastRunAt = 0n;
    for (let step = 0; step < 40; step++) {
      t += BigInt(r.int(1, Number(DAY) * 2)) / BigInt(r.int(1, 3));
      if (t >= a.schedule.expiresAt + DAY) break;
      await c.at(t);
      const inRange = t >= a.schedule.startsAt && t < a.schedule.expiresAt;
      const window = inRange ? (t - a.schedule.startsAt) / DAY : 0n;
      const due = inRange && runs < 12 && (runs === 0 || (window > lastWindow && t >= lastRunAt + DAY));
      let ok = true;
      try {
        await c.execute(a, sig, { window });
      } catch {
        ok = false;
        // a failed send still mines no block; advance the clock past it for the next setNextBlockTimestamp
        await c.testClient.mine({ blocks: 1 });
      }
      assert.equal(ok, due, `step ${step} t=${t - a.schedule.startsAt}`);
      if (ok) {
        runs++;
        lastWindow = window;
        lastRunAt = t;
      }
      const st = await c.state(a);
      assert.equal(st.runs, runs);
      assert.equal(st.spent, BigInt(runs) * USDG(10));
    }
    assert.equal(await c.bal(c.usdg, a.owner), USDG(1000) - BigInt(runs) * USDG(10));
  });
});

describe('BagDcaExecutor — BAG binding', () => {
  it('a new BAG version recorded by the creator stops the authorization (BagChanged); the owner must re-sign', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    const asCreator = await c.viem.getContractAt('BagFactory', c.bagFactory.address, { client: { wallet: c.creator } });
    const changed = [{ ...a.assets[0], weightBps: 6000 }, { ...a.assets[1], weightBps: 4000 }];
    await asCreator.write.recordBagVersion([c.ref, 1n, compositionHash('robinhood', changed), 'v2']);
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, sig), /BagChanged/);
  });

  it('a signed asset list that is not the registered composition is refused (CompositionMismatch), even with the right BAG hash', async () => {
    const c = await setup();
    await c.at(c.auth.schedule.startsAt + 1n);
    const variants: ((a: Auth) => void)[] = [
      (a) => ([a.assets[0], a.assets[1]] = [a.assets[1], a.assets[0]]), // order
      (a) => { a.assets[0].weightBps = 6000; a.assets[1].weightBps = 4000; },
      (a) => (a.assets[0].symbol = 'NVDX'),
      (a) => (a.assets[0].asset = c.usdg.address === a.assets[0].asset ? a.assets[0].asset : c.other.account.address),
    ];
    for (const v of variants) {
      const a = clone(c.auth);
      v(a);
      await assert.rejects(c.execute(a, await c.sign(a)), /CompositionMismatch|InvalidTerms/);
    }
  });

  it('unknown BAG id; strategy id without a registered (version, definitionHash)', async () => {
    const c = await setup();
    await c.at(c.auth.schedule.startsAt + 1n);
    const a = clone(c.auth);
    a.bag.bagId = keccak256(toHex('nope'));
    await assert.rejects(c.execute(a, await c.sign(a)), /UnknownBag/);
    const b = clone(c.auth);
    b.bag.strategyId = keccak256(toHex('unregistered'));
    b.bag.strategyVersion = 1;
    await assert.rejects(c.execute(b, await c.sign(b)), /StrategyNotRegistered/);
    const d = clone(c.auth);
    d.bag.strategyVersion = 3; // no strategy id but a version
    await assert.rejects(c.execute(d, await c.sign(d)), /InvalidTerms/);
  });

  it('a registered strategy (version, definitionHash) passes; a wrong definitionHash does not', async () => {
    const c = await setup({ strategy: true });
    await c.at(c.auth.schedule.startsAt + 1n);
    await c.execute(c.auth, await c.sign(c.auth));
    const b = clone(c.auth);
    b.bag.definitionHash = keccak256(toHex('another definition'));
    await assert.rejects(c.execute(b, await c.sign(b)), /StrategyNotRegistered/);
  });
});

describe('BagDcaExecutor — price ceilings and minimums', () => {
  it('one asset above its ceiling reverts the WHOLE run: nothing bought, nothing pulled, window not consumed', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.router.write.setRate([c.tsla.address, E18, USDG(421)]); // TSLA 421 > ceiling 420
    await c.at(a.schedule.startsAt + 10n);
    const before = await snapshot(c, a);
    await assert.rejects(c.execute(a, sig), /Too little received/);
    await assertNothingMoved(c, a, before);
    // same window, price back under the ceiling: the run goes through
    await c.router.write.setRate([c.tsla.address, E18, USDG(419)]);
    await c.at(a.schedule.startsAt + 20n);
    await c.execute(a, sig);
    assert.equal((await c.state(a)).runs, 1);
  });

  it('exactly at the ceiling: passes when the venue output is exact; ceil rounding means it may miss by one raw unit otherwise', async () => {
    const c = await setup();
    const a = clone(c.auth);
    a.assets[0].maxPriceRaw = USDG(200); // = NVDA market; 5 USDG / 200 = 0.025 exactly
    a.assets[1].maxPriceRaw = USDG(400); // = TSLA market; 5 USDG / 400 = 0.0125 exactly
    await c.at(a.schedule.startsAt + 1n);
    await c.execute(a, await c.sign(a));
    // 5 USDG / 420 is not exact: the venue floors, the contract minimum ceils → one unit short → no run
    const b = clone(c.auth);
    b.nonce = 7n;
    await c.router.write.setRate([c.tsla.address, E18, USDG(420)]);
    await c.at(b.schedule.startsAt + 100n);
    await assert.rejects(c.execute(b, await c.sign(b)), /Too little received/);
  });

  it('a keeper floor above the ceiling minimum is enforced; a floor below it is ignored', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt + 1n);
    // market gives 0.025 NVDA; floor 0.026 → revert
    await assert.rejects(c.execute(a, sig, { floors: [26n * 10n ** 15n, 1n] }), /Too little received/);
    await c.at(a.schedule.startsAt + 2n);
    const receipt = await c.execute(a, sig, { floors: [1n, 1n] });
    const delivered = parseEventLogs({ abi: c.executor.abi, logs: receipt.logs, eventName: 'AssetDelivered' }) as any[];
    assert.equal(delivered[0].args.minReceived, ceilingMinTs(USDG(5), a.assets[0]), 'contract minimum used when the floor is lower');
    await c.at(a.schedule.startsAt + DAY + 2n);
    await assert.rejects(c.execute(a, sig, { floors: [1n] }), /BadRunParams/);
  });

  it('fee tier must be one of the signed tiers; the pool must exist in the pinned factory', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, sig, { fees: [3000, 10000] }), /FeeNotAllowed/);
    await assert.rejects(c.execute(a, sig, { fees: [3000] }), /BadRunParams/);
    await c.v3.write.setPool([c.usdg.address, c.tsla.address, 500, zeroAddress]);
    await assert.rejects(c.execute(a, sig, { fees: [3000, 500] }), /PoolNotFound/);
    await c.execute(a, sig, { fees: [500, 3000] });
    assert.equal(await c.router.read.lastFee(), 3000);
  });

  it('decimals: a token whose decimals() changed after signing is refused; > 36 decimals is invalid terms', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.tsla.write.setDecimals([8]);
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, sig), /AssetDecimalsMismatch/);
    const b = clone(a);
    b.assets[0].decimals = 37;
    await assert.rejects(c.execute(b, await c.sign(b)), /InvalidTerms/);
  });

  it('amount too small to give every asset a positive leg: LegTooSmall; zero price: InvalidTerms', async () => {
    const c = await setup();
    await c.at(c.auth.schedule.startsAt + 1n);
    const a = clone(c.auth);
    a.assets[0].weightBps = 9999;
    a.assets[1].weightBps = 1;
    a.bag.compositionHash = compositionHash('robinhood', a.assets);
    // not the registered composition: refused before any amount math — use a dedicated BAG instead
    const ref = keccak256(toHex('bag:tiny-leg'));
    const asCreator = await c.viem.getContractAt('BagFactory', c.bagFactory.address, { client: { wallet: c.creator } });
    await asCreator.write.createBag([ref, a.bag.compositionHash, '', true]);
    a.bag.bagId = (await c.bagFactory.read.deriveBagId([c.creator.account.address, ref])) as Hex;
    a.schedule = { ...a.schedule, amountPerRun: 1n, totalBudget: 5n };
    await assert.rejects(c.execute(a, await c.sign(a)), /LegTooSmall/);
    const z = clone(c.auth);
    z.assets[0].maxPriceRaw = 0n;
    await assert.rejects(c.execute(z, await c.sign(z)), /InvalidTerms/);
  });

  it('property: legAmounts equals the SDK split (largest remainder, ties by address) and sums to the amount', async () => {
    const c = await setup();
    const r = rng(0x5eed);
    for (let k = 0; k < 60; k++) {
      const n = r.int(1, 10);
      const weights: number[] = [];
      let left = 10_000;
      for (let i = 0; i < n - 1; i++) {
        const w = r.int(1, left - (n - 1 - i));
        weights.push(w);
        left -= w;
      }
      weights.push(left);
      const assets: Asset[] = weights.map((w, i) => ({ asset: `0x${(r.big(160) | 1n).toString(16).padStart(40, '0')}` as Hex, symbol: `S${i}`, weightBps: w, decimals: 18, maxPriceRaw: 1n }));
      const amount = k % 3 === 0 ? BigInt(r.int(0, 50)) : r.big(r.int(8, 200));
      const onChain = (await c.executor.read.legAmounts([amount, assets])) as bigint[];
      assert.deepEqual(onChain, legAmountsTs(amount, assets), `case ${k}`);
      assert.equal(onChain.reduce((s, x) => s + x, 0n), amount);
    }
  });

  it('property: ceilingMinimums equals ceil(leg × 10^dec / maxPrice) incl. 0 and 36 decimals, price 1 and 2^256-1, no overflow', async () => {
    const c = await setup();
    const r = rng(0xce11);
    const MAX = (1n << 256n) - 1n;
    for (let k = 0; k < 60; k++) {
      const dec = [0, 6, 8, 18, 36][k % 5];
      const price = k % 7 === 0 ? 1n : k % 11 === 0 ? MAX : r.big(r.int(1, 128)) + 1n;
      const amount = k % 13 === 0 ? 2n : r.big(r.int(2, 160)) + 2n;
      const assets: Asset[] = [
        { asset: '0x0000000000000000000000000000000000000a01', symbol: 'A', weightBps: 5000, decimals: dec, maxPriceRaw: price },
        { asset: '0x0000000000000000000000000000000000000a02', symbol: 'B', weightBps: 5000, decimals: 18, maxPriceRaw: 3n },
      ];
      const legs = legAmountsTs(amount, assets);
      const want = assets.map((a, i) => ceilingMinTs(legs[i], a));
      assert.deepEqual(await c.executor.read.ceilingMinimums([amount, assets]), want, `case ${k}`);
    }
  });
});

describe('BagDcaExecutor — funding, custody and hostile tokens/venues', () => {
  it('allowance or balance below one run: reverts, nothing moves', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    await c.usdgAsOwner.write.approve([c.executor.address, USDG(9)]);
    await c.at(a.schedule.startsAt + 1n);
    const before = await snapshot(c, a);
    await assert.rejects(c.execute(a, sig), /ERC20InsufficientAllowance/);
    await assertNothingMoved(c, a, before);
    await c.usdgAsOwner.write.approve([c.executor.address, USDG(50)]);
    await c.usdgAsOwner.write.transfer([c.other.account.address, USDG(995)]);
    await c.at(a.schedule.startsAt + 100n);
    await assert.rejects(c.execute(a, sig), /ERC20InsufficientBalance/);
  });

  it('the budget is enforced even when the allowance is larger', async () => {
    const c = await setup();
    const a = clone(c.auth);
    a.schedule = { ...a.schedule, maxRuns: 2, totalBudget: USDG(20) };
    await c.usdgAsOwner.write.approve([c.executor.address, USDG(1000)]);
    const sig = await c.sign(a);
    await c.at(a.schedule.startsAt + 1n);
    await c.execute(a, sig);
    await c.at(a.schedule.startsAt + DAY + 1n);
    await c.execute(a, sig);
    await c.at(a.schedule.startsAt + 2n * DAY + 1n);
    await assert.rejects(c.execute(a, sig), /Exhausted/);
    assert.equal(await c.bal(c.usdg, a.owner), USDG(980));
    const bad = clone(a);
    bad.schedule.totalBudget = USDG(21); // must equal amountPerRun × maxRuns
    await assert.rejects(c.execute(bad, await c.sign(bad)), /InvalidTerms/);
  });

  it('tokens sent to the executor or the adapter beforehand are never used and stay where they are', async () => {
    const c = await setup();
    const a = c.auth;
    await c.usdg.write.mint([c.executor.address, USDG(7)]);
    await c.usdg.write.mint([c.adapter.address, USDG(3)]);
    await c.at(a.schedule.startsAt + 1n);
    const ownerBefore = await c.bal(c.usdg, a.owner);
    await c.execute(a, await c.sign(a));
    assert.equal(ownerBefore - (await c.bal(c.usdg, a.owner)), USDG(10), 'the owner pays exactly one run');
    assert.equal(await c.bal(c.usdg, c.executor.address), USDG(7));
    assert.equal(await c.bal(c.usdg, c.adapter.address), USDG(3));
  });

  it('fee-on-transfer INPUT token: FundingMismatch (fail closed)', async () => {
    const c = await setup();
    const fot = await c.viem.deployContract('DcaFeeOnTransferToken', [6]);
    const a = clone(c.auth);
    a.inputToken = fot.address;
    await fot.write.mint([a.owner, USDG(100)]);
    const fotAsOwner = await c.viem.getContractAt('DcaFeeOnTransferToken', fot.address, { client: { wallet: c.owner } });
    await fotAsOwner.write.approve([c.executor.address, USDG(50)]);
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, await c.sign(a)), /FundingMismatch/);
  });

  it('fee-on-transfer OUTPUT token: the adapter sees delivered ≠ reported and reverts (fail closed)', async () => {
    const c = await setup();
    const fot = await c.viem.deployContract('DcaFeeOnTransferToken', [18]);
    await fot.write.mint([c.router.address, 10n ** 30n]);
    await c.router.write.setRate([fot.address, E18, USDG(200)]);
    await c.v3.write.setPool([c.usdg.address, fot.address, 3000, '0x0000000000000000000000000000000000003001']);
    const assets: Asset[] = [{ asset: fot.address, symbol: 'FOT', weightBps: 10_000, decimals: 18, maxPriceRaw: USDG(1000) }];
    const ref = keccak256(toHex('bag:fot'));
    const asCreator = await c.viem.getContractAt('BagFactory', c.bagFactory.address, { client: { wallet: c.creator } });
    await asCreator.write.createBag([ref, compositionHash('robinhood', assets), '', true]);
    const a = clone(c.auth);
    a.assets = assets;
    a.bag.bagId = (await c.bagFactory.read.deriveBagId([c.creator.account.address, ref])) as Hex;
    a.bag.compositionHash = compositionHash('robinhood', assets);
    await c.at(a.schedule.startsAt + 1n);
    await assert.rejects(c.execute(a, await c.sign(a), { fees: [3000] }), /OutputMismatch/);
    assert.equal(await c.bal(c.usdg, c.executor.address), 0n);
  });

  it('router misbehaviour is caught: partial fill, lying about output, output diverted, minimum ignored', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    let t = a.schedule.startsAt;
    const cases: [bigint, bigint, Hex, boolean, RegExp][] = [
      [9_000n, 0n, zeroAddress, true, /InputNotFullySpent/], // takes 90 % of the input (and skips its own minimum check)
      [10_000n, 1n, zeroAddress, false, /OutputMismatch/], // reports 1 more than it paid
      [10_000n, 0n, c.other.account.address, false, /OutputMismatch/], // pays someone else
    ];
    for (const [consume, extra, divert, ignoreMin, re] of cases) {
      await c.router.write.setMisbehaviour([consume, extra, divert, ignoreMin]);
      t += 10n;
      await c.at(t);
      const before = await snapshot(c, a);
      await assert.rejects(c.execute(a, sig), re);
      await assertNothingMoved(c, a, before);
    }
    // ignores the minimum AND the price is above the ceiling: the adapter's own measurement stops it
    await c.router.write.setMisbehaviour([10_000n, 0n, zeroAddress, true]);
    await c.router.write.setRate([c.tsla.address, E18, USDG(800)]);
    t += 10n;
    await c.at(t);
    await assert.rejects(c.execute(a, sig), /OutputBelowMinimum/);
  });

  it('re-entrancy from the venue into execute (or into the adapter) reverts the whole run', async () => {
    const c = await setup();
    const a = c.auth;
    const sig = await c.sign(a);
    const r = { authorizationId: c.idOf(a), window: 0n, deadline: a.schedule.startsAt + 1000n, fees: [3000, 3000], minOutFloors: [] };
    await c.router.write.setReenter([c.executor.address, encodeFunctionData({ abi: c.executor.abi, functionName: 'execute', args: [a, r, sig] })]);
    await c.at(a.schedule.startsAt + 1n);
    const before = await snapshot(c, a);
    await assert.rejects(c.execute(a, sig), /ReentrancyGuardReentrantCall/);
    await assertNothingMoved(c, a, before);
    await c.router.write.setReenter([
      c.adapter.address,
      encodeFunctionData({ abi: c.adapter.abi, functionName: 'swapExactIn', args: [c.usdg.address, c.tsla.address, 1n, 1n, c.other.account.address, encodeAbiParameters([{ type: 'uint256' }], [3000n])] }),
    ]);
    await c.at(a.schedule.startsAt + 2n);
    await assert.rejects(c.execute(a, sig), /ReentrancyGuardReentrantCall/);
  });
});

describe('BagDcaExecutor — the executor does not trust the adapter', () => {
  it('an adapter that leaves allowance unused, under-delivers, or delivers nothing is caught by the executor itself', async () => {
    const c = await setup({ adapter: 'misbehaving' });
    const a = c.auth;
    const sig = await c.sign(a);
    const bad = await c.viem.getContractAt('DcaMisbehavingAdapter', c.adapter.address);
    let t = a.schedule.startsAt;
    for (const [mode, re] of [[1n, /AdapterAllowanceLeft/], [2n, /DeliveryBelowMinimum/], [3n, /DeliveryBelowMinimum/]] as const) {
      await bad.write.setMode([mode]);
      t += 10n;
      await c.at(t);
      await assert.rejects(c.execute(a, sig), re);
    }
    await bad.write.setMode([0n]);
    t += 10n;
    await c.at(t);
    await c.execute(a, sig);
  });

  it('an authorization naming another adapter or venue is invalid terms', async () => {
    const c = await setup();
    await c.at(c.auth.schedule.startsAt + 1n);
    const a = clone(c.auth);
    a.route.adapter = c.other.account.address;
    await assert.rejects(c.execute(a, await c.sign(a)), /InvalidTerms/);
    const b = clone(c.auth);
    b.route.swapRouter = c.other.account.address;
    await assert.rejects(c.execute(b, await c.sign(b)), /InvalidTerms/);
    const d = clone(c.auth);
    d.route.allowedFees = [3000, 3000];
    await assert.rejects(c.execute(d, await c.sign(d)), /InvalidTerms/);
    const e = clone(c.auth);
    e.recipient = c.executor.address;
    await assert.rejects(c.execute(e, await c.sign(e)), /InvalidTerms/);
  });
});

describe('UniswapV3ExactInAdapter', () => {
  it('constructor pins router and factory and refuses a router whose factory() differs', async () => {
    const c = await setup();
    assert.equal(((await c.adapter.read.swapRouter()) as string).toLowerCase(), c.router.address.toLowerCase());
    assert.equal(((await c.adapter.read.poolFactory()) as string).toLowerCase(), c.v3.address.toLowerCase());
    await assert.rejects(c.viem.deployContract('UniswapV3ExactInAdapter', [c.router.address, c.usdg.address]), /RouterFactoryMismatch/);
  });

  it('direct use: pulls only from the caller, pays only the recipient, resets approval, ignores tokens pre-sent to it', async () => {
    const c = await setup();
    const asOwner = await c.viem.getContractAt('UniswapV3ExactInAdapter', c.adapter.address, { client: { wallet: c.owner } });
    await c.usdg.write.mint([c.adapter.address, USDG(4)]);
    await c.usdgAsOwner.write.approve([c.adapter.address, USDG(2)]);
    const fee = encodeAbiParameters([{ type: 'uint256' }], [3000n]);
    await asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(2), 1n, c.recipient.account.address, fee]);
    assert.equal(await c.bal(c.nvda, c.recipient.account.address), 10n ** 16n);
    assert.equal(await c.bal(c.usdg, c.adapter.address), USDG(4));
    assert.equal(await c.usdg.read.allowance([c.adapter.address, c.router.address]), 0n);
    // with no approval it cannot spend the 4 pre-sent USDG for someone else
    const asOther = await c.viem.getContractAt('UniswapV3ExactInAdapter', c.adapter.address, { client: { wallet: c.other } });
    await assert.rejects(asOther.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(4), 1n, c.other.account.address, fee]));
  });

  it('rejects unsupported fee tiers, malformed route data, missing pools, zero amounts, bad recipients', async () => {
    const c = await setup();
    const asOwner = await c.viem.getContractAt('UniswapV3ExactInAdapter', c.adapter.address, { client: { wallet: c.owner } });
    await c.usdgAsOwner.write.approve([c.adapter.address, USDG(10)]);
    const enc = (f: bigint) => encodeAbiParameters([{ type: 'uint256' }], [f]);
    const rcpt = c.recipient.account.address;
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(1), 1n, rcpt, enc(2500n)]), /UnsupportedFee/);
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(1), 1n, rcpt, '0x0bb8']), /InvalidSwap/);
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(1), 1n, rcpt, enc(100n)]), /PoolNotFound/);
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, 0n, 1n, rcpt, enc(3000n)]), /InvalidSwap/);
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(1), 0n, rcpt, enc(3000n)]), /InvalidSwap/);
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.nvda.address, USDG(1), 1n, c.adapter.address, enc(3000n)]), /InvalidSwap/);
    await assert.rejects(asOwner.write.swapExactIn([c.usdg.address, c.usdg.address, USDG(1), 1n, rcpt, enc(3000n)]), /InvalidSwap/);
  });

  it('has no owner, no arbitrary call and no delegatecall in its ABI', async () => {
    const c = await setup();
    const fns = c.adapter.abi.filter((e: any) => e.type === 'function').map((e: any) => e.name).sort();
    assert.deepEqual(fns, ['poolFactory', 'swapExactIn', 'swapRouter']);
    const exFns = c.executor.abi.filter((e: any) => e.type === 'function' && e.stateMutability !== 'view' && e.stateMutability !== 'pure').map((e: any) => e.name).sort();
    assert.deepEqual(exFns, ['execute', 'revoke', 'revokeBySig']);
  });
});
