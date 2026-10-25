// Composer program helpers for a plan contract signer, ported unchanged in behaviour from
// composer/run.mjs (which stays as-is for its recorded evidence).
//   replay: the recorded program (vendor fixture) re-addressed to a signer, ONLY in the slots the
//           signer-dependence analysis identified. Not a Composer response; quotes are stale.
//   live:   a fresh Composer compilation through the SDK's LI.FI adapter (needs LIFI_API_KEY).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { v } from './fork-env.mjs';

export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const COMPOSER_FACTORY = '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae';
export const COMPOSER_DEPLOYMENT = { chainId: 4663, factory: COMPOSER_FACTORY, factoryCodeHash: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5' };
export const FIXTURE_GROSS = 5_000_000n; // the recorded program was compiled for 5 USDG

export async function loadComposer({ vendorDir, sdkDir, bagId = '955df6e0-b6ea-44ba-a5eb-1288a80c0a06' }) {
  const sdk = await import(pathToFileURL(join(sdkDir, 'dist/index.js')).href);
  const { lifiComposer, resolveLifiComposerAccount } = await import(pathToFileURL(join(sdkDir, 'dist/adapters/lifi.js')).href);
  const { withReceiptEvidence } = await import(pathToFileURL(join(sdkDir, 'dist/adapters/evm.js')).href);
  const receiptJs = readFileSync(join(sdkDir, 'dist/receipt.js'), 'utf8');
  if (!receiptJs.includes('DELIVERY_AUTHORIZATION_MISMATCH')) throw new Error('--sdk build has no forwarded-delivery mode (needs #126, e.g. integration dadef00)');
  const { basketWire } = await import(pathToFileURL(join(vendorDir, 'scripts/research/dca-trial/basket-wire.mjs')).href);
  const fixture = JSON.parse(readFileSync(join(vendorDir, 'scripts/research/dca-trial/fixtures', bagId + '.probe-compiled.json'), 'utf8'));
  const parsed = sdk.parseBag(fixture.bag); assert(parsed.ok, 'fixture BAG does not parse');
  assert(sdk.validateBag(parsed.bag).valid, 'fixture BAG is invalid');
  assert.equal(sdk.hashBag(parsed.bag), fixture.bag.definitionHash, 'fixture definitionHash mismatch');
  return { sdk, lifiComposer, resolveLifiComposerAccount, withReceiptEvidence, wire: basketWire(v), fixture, bag: parsed.bag, receiptJs };
}

export function composerOps(C, { client, remote, mode, apiKey }) {
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const legTokens = C.bag.definition.assets.map(a => a.address.toLowerCase()).filter(a => a !== USDG);
  const predictProxy = signer => read(COMPOSER_FACTORY, v.parseAbi(['function predictProxyAddress(address) view returns (address)']), 'predictProxyAddress', [signer]);
  const planFor = (signer, gross) => C.sdk.planPurchase(C.bag, { inputToken: USDG, amountRaw: gross, inputTokenDecimals: 6, signer });

  async function compileFor(signer, gross) {
    if (mode === 'live') {
      const account = await C.resolveLifiComposerAccount({ chainId: 4663, signer, deployment: COMPOSER_DEPLOYMENT, client: remote });
      const provider = C.lifiComposer({ apiKey, baseUrl: 'https://composer.li.quest', account, timeoutMs: 60000 });
      return C.sdk.compileBag(C.bag, { inputToken: USDG, amountRaw: gross, inputTokenDecimals: 6, signer }, { provider, trust: account.trust });
    }
    if (gross !== FIXTURE_GROSS) throw new Error(`replay mode can only use the recorded ${FIXTURE_GROSS} raw USDG program; got ${gross}`);
    const recorded = C.fixture.plan.signer, x = C.wire.decode(C.fixture.compiled.transaction.data);
    assert.equal(x.state[0], v.encodeAbiParameters([{ type: 'address' }], [recorded]));
    const proxy = await predictProxy(signer);
    x.state[0] = v.encodeAbiParameters([{ type: 'address' }], [signer]);
    x.state[1] = C.wire.body(v.encodeFunctionData({ abi: v.parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [proxy] }));
    for (let i = 0; i < x.state.length; i++) { let a; try { a = C.wire.swap(x.state[i]); } catch { continue; } a[3] = proxy; x.state[i] = C.wire.swapBody(a); }
    return { transaction: { chainId: 4663, to: COMPOSER_FACTORY, data: C.wire.encode(x), value: 0n }, quote: { plan: planFor(signer, gross), legs: C.fixture.compiled.quote.legs } };
  }

  // Signer-independent template: derived slots are emptied so the CREATE2 init code cannot name the plan.
  async function template(compiled, signer, gross) {
    const plan = compiled.quote.plan ?? planFor(signer, gross);
    const p = C.wire.profile(compiled, plan, C.sdk.simulatePartition(plan.swapAmountRaw, plan.legs.map(l => l.legBps)), C.bag.definition);
    const proxy = (await predictProxy(signer)).toLowerCase();
    const signerWord = v.encodeAbiParameters([{ type: 'address' }], [signer]).toLowerCase();
    const proxyBalance = C.wire.body(v.encodeFunctionData({ abi: v.parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [proxy] })).toLowerCase();
    const signerSlot = p.state.findIndex(s => s.toLowerCase() === signerWord), proxyBalanceSlot = p.state.findIndex(s => s.toLowerCase() === proxyBalance);
    assert(signerSlot >= 0 && proxyBalanceSlot >= 0, 'signer or proxy-balance slot not found');
    const legSlots = new Set(p.legs.map(l => Number(l.slot)));
    const state = p.state.map((s, i) => (i === signerSlot || i === proxyBalanceSlot || i === Number(p.contextSlot) || legSlots.has(i) ? '0x' : s));
    const leaks = state.map((s, i) => [i, s.toLowerCase()]).filter(([, s]) => s.includes(signer.slice(2).toLowerCase()) || s.includes(proxy.slice(2)));
    assert.equal(leaks.length, 0, 'signer-dependent data outside the derived slots: ' + leaks.map(([i]) => i));
    return { instructions: p.instructions, state, signerSlot: BigInt(signerSlot), proxyBalanceSlot: BigInt(proxyBalanceSlot), contextSlot: p.contextSlot, amountSlot: p.amountSlot,
      legs: p.legs.map(l => ({ token: l.token, weightBps: l.weightBps, input: l.input, net: l.net, minimum: l.minimum, slot: l.slot, feeHash: l.feeHash })), commandsHash: p.commandsHash };
  }
  const comparable = t => JSON.stringify({ ...t, legs: t.legs.map(({ minimum, ...l }) => l) }, (_k, a) => (typeof a === 'bigint' ? a.toString() : a));
  const asProfile = t => ({ instructions: t.instructions.map(([opcode, operand]) => ({ opcode, operand })), state: t.state, signerSlot: t.signerSlot,
    proxyBalanceSlot: t.proxyBalanceSlot, contextSlot: t.contextSlot, amountSlot: t.amountSlot, legs: t.legs });

  // Program for a deployed plan: context set to the plan's own; factory envelope only while its proxy is undeployed.
  async function forPlan(compiled, plan, planAbi, t) {
    const proxy = await read(plan, planAbi, 'proxy'), deployed = (await client.getCode({ address: proxy }))?.length > 2;
    const data = C.wire.normalize(compiled.transaction.data, await read(plan, planAbi, 'context'), deployed, { commandsHash: t.commandsHash, state: t.state, contextSlot: t.contextSlot });
    return { ...compiled, transaction: { ...compiled.transaction, to: deployed ? proxy : COMPOSER_FACTORY, data, value: 0n } };
  }
  return { legTokens, predictProxy, compileFor, template, comparable, asProfile, forPlan, wire: C.wire };
}
