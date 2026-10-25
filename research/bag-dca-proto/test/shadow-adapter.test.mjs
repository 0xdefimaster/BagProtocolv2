// Adversarial tests for shadow/contracts/ShadowAdapters.sol (ShadowV4Adapter) on a plain local EDR
// chain against MockPoolManager, which returns whatever swap delta the test sets, can re-enter the
// adapter mid-swap and can call the callback outside of an unlock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v, compileProto, createLocalChain, reasonOf } from '../lib/fork-env.mjs';

const { art } = compileProto(['shadow/contracts/ShadowAdapters.sol', 'shadow/contracts/test/AdapterMocks.sol'], { keepPaths: true });
const A = art('ShadowV4Adapter'), PM = art('MockPoolManager'), TOK = art('MockToken');
const IN = 1_000_000n, OUT = 990_000n;

const L = await createLocalChain({ out: mkdtempSync(join(tmpdir(), 'shadow-adapter-')) });
test.after(() => L.close());
const deploy = async (w, a, args = []) => (await L.client.waitForTransactionReceipt({ hash: await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress;
const send = async (w, address, abi, functionName, args = []) => {
  const r = await L.client.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName, args, gas: 3_000_000n }) });
  assert.equal(r.status, 'success'); return r;
};
const read = (address, abi, functionName, args = []) => L.client.readContract({ address, abi, functionName, args });
/** Runs a call that must revert and returns the decoded error name (or the raw revert text). */
const reverts = async (w, address, abi, functionName, args) => {
  try { await w.writeContract({ address, abi, functionName, args, gas: 3_000_000n }); } catch (e) {
    const raw = reasonOf(e).match(/return data: (0x[0-9a-fA-F]+)/)?.[1] ?? e?.cause?.data?.data ?? e?.data;
    if (e?.cause?.data?.errorName) return e.cause.data.errorName;
    if (raw) try { return v.decodeErrorResult({ abi: A.abi, data: raw }).errorName; } catch {}
    return reasonOf(e);
  }
  assert.fail(`${functionName} did not revert`);
};

async function setup() {
  const deployer = await L.wallet(), payer = await L.wallet(), other = await L.wallet();
  const pm = await deploy(deployer, PM), adapter = await deploy(deployer, A, [pm]);
  let t0 = await deploy(deployer, TOK), t1 = await deploy(deployer, TOK);
  if (BigInt(t0) > BigInt(t1)) [t0, t1] = [t1, t0];
  for (const t of [t0, t1]) { await send(deployer, t, TOK.abi, 'mint', [payer.account.address, 10n * IN]); await send(deployer, t, TOK.abi, 'mint', [pm, 10n * IN]); }
  for (const t of [t0, t1]) await send(payer, t, TOK.abi, 'approve', [adapter, 2n ** 255n]);
  const key = { currency0: t0, currency1: t1, fee: 3000, tickSpacing: 60, hooks: v.zeroAddress };
  const bal = (t, a) => read(t, TOK.abi, 'balanceOf', [a]);
  const snapshot = async () => Object.fromEntries(await Promise.all([['payer', payer.account.address], ['other', other.account.address], ['pm', pm], ['adapter', adapter]]
    .flatMap(([n, a]) => [[n + '0', t0, a], [n + '1', t1, a]]).map(async ([n, t, a]) => [n, await bal(t, a)])));
  return { deployer, payer, other, pm, adapter, t0, t1, key, bal, snapshot };
}

test('exact input both directions: payer pays exactly amountIn and receives the output; the adapter keeps nothing', async () => {
  const s = await setup();
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-IN, OUT]);
  let b = await s.snapshot();
  await send(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, IN, OUT]);
  let a = await s.snapshot();
  assert.equal(b.payer0 - a.payer0, IN); assert.equal(a.payer1 - b.payer1, OUT);
  assert.equal(a.pm0 - b.pm0, IN); assert.equal(b.pm1 - a.pm1, OUT);
  assert.equal(a.adapter0 + a.adapter1, 0n); assert.equal(a.other0 + a.other1, 0n);
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [OUT, -IN]);
  b = await s.snapshot();
  await send(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, false, IN, OUT]);
  a = await s.snapshot();
  assert.equal(b.payer1 - a.payer1, IN); assert.equal(a.payer0 - b.payer0, OUT); assert.equal(a.adapter0 + a.adapter1, 0n);
});

test('partial fill reverts the whole swap (PartialFill) and nothing moves', async () => {
  const s = await setup();
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-(IN - 1n), OUT]);
  const b = await s.snapshot();
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, IN, 0n]), 'PartialFill');
  assert.deepEqual(await s.snapshot(), b);
});

test('wrong-signed or zero deltas revert (BadDelta)', async () => {
  const s = await setup();
  for (const [d0, d1] of [[IN, OUT], [0n, OUT], [-IN, 0n], [-IN, -OUT]]) {
    await send(s.deployer, s.pm, PM.abi, 'setDelta', [d0, d1]);
    assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, IN, 0n]), 'BadDelta', `${d0},${d1}`);
  }
  // direction matters: a zeroForOne-shaped delta used for oneForZero is wrong-signed
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-IN, OUT]);
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, false, IN, 0n]), 'BadDelta');
});

test('output below minOut reverts (MinOut)', async () => {
  const s = await setup();
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-IN, OUT]);
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, IN, OUT + 1n]), 'MinOut');
});

test('amount bounds and native currency are refused (AmountOutOfRange, NativeUnsupported)', async () => {
  const s = await setup();
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, 0n, 0n]), 'AmountOutOfRange');
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, 2n ** 127n, 0n]), 'AmountOutOfRange');
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [{ ...s.key, currency0: v.zeroAddress }, true, IN, 0n]), 'NativeUnsupported');
});

test('callback: only the PoolManager, and only inside our own unlock (NotPoolManager, NotActive)', async () => {
  const s = await setup();
  const ctx = v.encodeAbiParameters([{ type: 'tuple', components: [{ name: 'key', type: 'tuple', components: A.abi.find(x => x.name === 'swapExactIn').inputs[0].components }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint256' }, { name: 'payer', type: 'address' }] }],
    [{ key: s.key, zeroForOne: true, amountIn: IN, payer: s.payer.account.address }]);
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-IN, OUT]);
  // an attacker tries to pull the payer's approved tokens by calling the callback directly
  assert.equal(await reverts(s.other, s.adapter, A.abi, 'unlockCallback', [ctx]), 'NotPoolManager');
  const b = await s.snapshot();
  assert.equal(await reverts(s.other, s.pm, PM.abi, 'callbackDirect', [s.adapter, ctx]), 'NotActive');
  assert.deepEqual(await s.snapshot(), b);
});

test('re-entering swapExactIn during the swap is refused (Reentered)', async () => {
  const s = await setup();
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-IN, OUT]);
  await send(s.deployer, s.pm, PM.abi, 'setReenter', [s.adapter, v.encodeFunctionData({ abi: A.abi, functionName: 'swapExactIn', args: [s.key, true, IN, 0n] })]);
  assert.equal(await reverts(s.payer, s.adapter, A.abi, 'swapExactIn', [s.key, true, IN, 0n]), 'Reentered');
});

test('payer binding: a caller can only spend its own tokens; another approver is never charged', async () => {
  const s = await setup();
  await send(s.deployer, s.pm, PM.abi, 'setDelta', [-IN, OUT]);
  const b = await s.snapshot(); // payer approved the adapter; `other` holds nothing and approved nothing
  const r = await reverts(s.other, s.adapter, A.abi, 'swapExactIn', [s.key, true, IN, 0n]);
  assert(!['PartialFill', 'BadDelta', 'MinOut'].includes(r), r); // fails on other's own transferFrom (no allowance/balance)
  assert.deepEqual(await s.snapshot(), b);
});
