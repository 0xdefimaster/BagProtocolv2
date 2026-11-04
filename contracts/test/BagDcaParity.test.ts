import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAbiItem } from 'viem/utils';
import { keccak256, type Hex } from 'viem';
import {
  DCA_AUTHORIZATION_TYPES,
  DCA_EXECUTOR_ABI,
  dcaAuthorizationId,
  dcaCeilingMinimums,
  dcaCompositionHash,
  dcaLegAmounts,
  dcaRunDue,
  verifyDcaReceipt,
  type DcaAuthorization,
  type DcaReceiptClient,
} from '../../packages/bag-sdk/src/dca';
import { DCA_TYPES } from './helpers/dca-types';
import { clone, DAY, rng, setup, USDG, type Asset } from './helpers/dca-fixture';

// -----------------------------------------------------------------------------
// LOCAL (Hardhat EVM) parity between contracts/dca/BagDcaExecutor.sol and
// packages/bag-sdk/src/dca.ts: same ABI, same authorization id, same split,
// same ceiling minimums, same composition hash, same calendar, and the SDK
// receipt verifier accepts the contract's real receipts. Not a fork test.
// -----------------------------------------------------------------------------

/** OpenZeppelin library items that bubble from the executor; not part of the DCA interface the SDK documents. */
const LIBRARY_ITEMS = /^(EIP712DomainChanged|InvalidShortString|StringTooLong|ECDSA\w+|MathOverflowedMulDiv|StringsInsufficientHexLength|AddressEmptyCode|FailedCall|FailedInnerCall|AddressInsufficientBalance)\(/;
const sig = (abi: readonly any[], type: string) =>
  new Set(abi.filter((x) => x.type === type).map((x) => formatAbiItem(x as never)));

describe('BagDcaExecutor ↔ SDK parity', () => {
  it('the SDK ABI and EIP-712 types are exactly the compiled contract’s', async () => {
    const c = await setup();
    for (const type of ['event', 'error']) {
      const built = sig(c.executor.abi, type);
      for (const s of sig(DCA_EXECUTOR_ABI, type)) {
        assert.ok(built.has(s), `SDK ${s} is in the build`);
      }
      for (const s of built) if (!LIBRARY_ITEMS.test(s)) assert.ok(sig(DCA_EXECUTOR_ABI, type).has(s), `build ${s} is in the SDK`);
    }
    const builtFns = sig(c.executor.abi, 'function');
    for (const s of sig(DCA_EXECUTOR_ABI, 'function')) assert.ok(builtFns.has(s), `SDK ${s} is in the build`);
    assert.deepEqual(DCA_AUTHORIZATION_TYPES, DCA_TYPES);
  });

  it('property: authorizationIdOf, legAmounts, ceilingMinimums and compositionHashOf agree for random authorizations', async () => {
    const c = await setup();
    const deployment = { chainId: c.chainId, executor: c.executor.address };
    const r = rng(0xa11ce);
    for (let k = 0; k < 40; k++) {
      const n = r.int(1, 10);
      const weights: number[] = [];
      let left = 10_000;
      for (let i = 0; i < n - 1; i++) {
        const w = r.int(1, left - (n - 1 - i));
        weights.push(w);
        left -= w;
      }
      weights.push(left);
      const assets: Asset[] = weights.map((w, i) => ({
        asset: `0x${(r.big(160) | 1n).toString(16).padStart(40, '0')}` as Hex,
        symbol: `S${i}${'x'.repeat(r.int(0, 20))}é`,
        weightBps: w,
        decimals: r.int(0, 36),
        maxPriceRaw: r.big(r.int(1, 200)) + 1n,
      }));
      const a: DcaAuthorization = {
        ...clone(c.auth),
        assets,
        nonce: r.big(256),
        schedule: { amountPerRun: r.big(r.int(4, 120)) + 1n, totalBudget: 0n, maxRuns: r.int(1, 1000), startsAt: BigInt(r.int(1, 2 ** 31)), periodSeconds: BigInt(r.int(1, 10 ** 7)), expiresAt: 0n },
        route: { ...c.auth.route, allowedFees: [[100], [500, 3000], [100, 500, 3000, 10000]][k % 3] },
      };
      a.schedule.totalBudget = a.schedule.amountPerRun * BigInt(a.schedule.maxRuns);
      a.schedule.expiresAt = a.schedule.startsAt + a.schedule.periodSeconds * BigInt(a.schedule.maxRuns);
      assert.equal(await c.executor.read.authorizationIdOf([a]), dcaAuthorizationId(a, deployment), `id case ${k}`);
      assert.deepEqual(await c.executor.read.legAmounts([a.schedule.amountPerRun, assets]), dcaLegAmounts(a), `split case ${k}`);
      assert.deepEqual(await c.executor.read.ceilingMinimums([a.schedule.amountPerRun, assets]), dcaCeilingMinimums(a), `min case ${k}`);
      assert.equal(await c.executor.read.compositionHashOf([assets]), dcaCompositionHash('robinhood', assets), `composition case ${k}`);
    }
  });

  it('property: over random block times the contract accepts a run exactly when the SDK calendar says DUE', async () => {
    const c = await setup();
    const a = clone(c.auth);
    a.schedule = { ...a.schedule, maxRuns: 8, totalBudget: USDG(80), periodSeconds: 3600n, expiresAt: a.schedule.startsAt + 8n * 3600n };
    await c.usdgAsOwner.write.approve([c.executor.address, USDG(80)]);
    const signature = await c.sign(a);
    const r = rng(0xca1e);
    let t = a.schedule.startsAt - 600n;
    for (let step = 0; step < 45; step++) {
      t += BigInt(r.int(1, 5400));
      if (t > a.schedule.expiresAt + 3600n) break;
      const st = await c.state(a);
      const sdk = dcaRunDue(a, { runs: st.runs, spent: st.spent, lastWindow: st.lastWindow, lastRunAt: st.lastRunAt, revoked: st.revoked }, t);
      await c.at(t);
      let ok = true;
      try {
        await c.execute(a, signature, { window: sdk.window ?? (t >= a.schedule.startsAt ? (t - a.schedule.startsAt) / 3600n : 0n) });
      } catch {
        ok = false;
        await c.testClient.mine({ blocks: 1 });
      }
      assert.equal(ok, sdk.state === 'DUE', `step ${step}: SDK says ${sdk.state} at +${t - a.schedule.startsAt}s`);
    }
  });

  it('verifyDcaReceipt: VERIFIED on the contract’s real receipt (with the executor code hash); FAILED for a reverted run', async () => {
    const c = await setup();
    const a = c.auth;
    const deployment = { chainId: c.chainId, executor: c.executor.address };
    const signature = await c.sign(a);
    await c.at(a.schedule.startsAt + DAY * 2n + 7n);
    const receipt = await c.execute(a, signature);
    const code = (await c.publicClient.getCode({ address: c.executor.address }))!;
    const client = c.publicClient as unknown as DcaReceiptClient;
    const v = await verifyDcaReceipt({ client, transactionHash: receipt.transactionHash, auth: a, deployment, executionIndex: 0n, expectedExecutorCodeHash: keccak256(code) });
    assert.deepEqual(v.issues, []);
    assert.equal(v.status, 'VERIFIED');
    assert.equal(v.window, 2n);
    assert.equal(v.deliveries.length, 2);
    // the receipt of another authorization's run does not verify this one
    const b = clone(a);
    b.nonce = 99n;
    const vb = await verifyDcaReceipt({ client, transactionHash: receipt.transactionHash, auth: b, deployment, expectedExecutorCodeHash: keccak256(code) });
    assert.equal(vb.status, 'FAILED');
    // a mined, reverted run
    await c.router.write.setRate([c.tsla.address, 10n ** 18n, USDG(1000)]);
    await c.at(a.schedule.startsAt + DAY * 3n + 7n);
    // Hardhat mines a reverted transaction and then throws; the receipt is read from the latest block.
    await assert.rejects(c.executor.write.execute([a, { authorizationId: c.idOf(a), window: 3n, deadline: a.schedule.startsAt + DAY * 4n, fees: [3000, 3000], minOutFloors: [] }, signature], { account: c.keeper.account, gas: 3_000_000n }));
    const latest = await c.publicClient.getBlock({ blockTag: 'latest' });
    const hash = latest.transactions[0] as Hex;
    assert.equal((await c.publicClient.getTransactionReceipt({ hash })).status, 'reverted');
    const failed = await verifyDcaReceipt({ client, transactionHash: hash, auth: a, deployment, expectedExecutorCodeHash: keccak256(code) });
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(failed.issues.map((i) => i.code), ['TRANSACTION_REVERTED']);
  });
});
