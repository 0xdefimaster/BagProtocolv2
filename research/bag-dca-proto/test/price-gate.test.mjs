import test from 'node:test';
import assert from 'node:assert/strict';
import { priceGate, basketGate, poolFeeBps, PRICE_POLICY, DECISION } from '../lib/price-gate.mjs';

const HOOK = '0x5eb87f69a1b8b9a0c0de11fa7e0e5c3a3a3d7fff';
const good = (over = {}) => ({ source: 'uniswap-v3', stage: 'RECEIPT_VERIFIED', outRaw: 1000n, impactBps: 20, route: { fee: 500 }, ...over });
const peer = (over = {}) => ({ source: 'uniswap-v4', stage: 'RECEIPT_VERIFIED', outRaw: 1000n, route: { fee: 3000, hooks: '0x0000000000000000000000000000000000000000' }, ...over });
const FEED = 'feed:0xfeed@v1';
const proven = { ...PRICE_POLICY, proven: true, userToleranceBps: 100, reference: { ...PRICE_POLICY.reference, source: FEED, maxStalenessSeconds: 300 } };
const ref = (over = {}) => ({ source: FEED, expectedOutRaw: 1000n, timestamp: 1000, ...over });

test('the shipped policy never passes: a clean route is PRICE_POLICY_UNPROVEN, with no reference price', () => {
  const g = priceGate(good(), { peers: [peer()] });
  assert.equal(g.decision, DECISION.UNPROVEN); assert.equal(g.executable, false);
  assert.deepEqual(g.reasons, ['NO_REFERENCE_PRICE', 'POLICY_NOT_PROVEN']);
  assert.equal(PRICE_POLICY.proven, false); assert.equal(PRICE_POLICY.reference.source, null); assert.equal(PRICE_POLICY.reference.usdgReferenceUsd, null);
});

test('a constant high-fee pool fails even when the probe sees no impact', () => {
  for (const fee of [440000, 990000, 10001]) {
    const g = priceGate(good({ impactBps: 0, route: { fee } }), { peers: [peer()] });
    assert.equal(g.decision, DECISION.FAIL); assert(g.reasons.includes('POOL_FEE_TOO_HIGH'), String(fee));
  }
  assert.equal(poolFeeBps({ fee: 10000 }), 100); // exactly 1% is allowed
  assert.equal(priceGate(good({ route: { fee: 10000 } }), { peers: [peer()] }).decision, DECISION.UNPROVEN);
});

test('hooked pools fail unless allowlisted; dynamic fee is unknown, never assumed low', () => {
  const hooked = good({ source: 'uniswap-v4', route: { fee: 0x800000, hooks: HOOK } });
  let g = priceGate(hooked, { peers: [good()] });
  assert.equal(g.decision, DECISION.FAIL); assert(g.reasons.includes('HOOK_NOT_ALLOWLISTED')); assert(g.reasons.includes('POOL_FEE_UNKNOWN'));
  g = priceGate(hooked, { peers: [good()], reference: ref(), nowSeconds: 1000, policy: { ...proven, hookAllowlist: [HOOK] } });
  assert.equal(g.decision, DECISION.UNPROVEN); assert.deepEqual(g.reasons, ['POOL_FEE_UNKNOWN']);
});

test('quote-only, simulated or unverified fork evidence fails', () => {
  for (const stage of ['QUOTED', 'SIMULATED', 'FORK_EXECUTED', 'NONE']) assert.equal(priceGate(good({ stage }), { peers: [peer()] }).decision, DECISION.FAIL, stage);
});

test('thin liquidity or far below another route at the same block fails; peers are never a reference', () => {
  assert(priceGate(good({ impactBps: 501 }), { peers: [peer()] }).reasons.includes('PROBE_IMPACT_TOO_HIGH'));
  const g = priceGate(good({ outRaw: 970n }), { peers: [peer({ outRaw: 1000n })] });
  assert.equal(g.decision, DECISION.FAIL); assert.equal(g.checks.belowBestPeerBps, 300); assert(g.reasons.includes('BELOW_BEST_PEER'));
  assert(priceGate(good(), { peers: [peer({ stage: 'SIMULATED', outRaw: 5000n })] }).checks.belowBestPeerBps === undefined); // only receipt-verified peers count
  // agreeing peers do not stand in for a reference price
  assert(priceGate(good(), { peers: [peer(), peer({ source: 'kyberswap' })], policy: { ...proven, reference: PRICE_POLICY.reference } }).reasons.includes('NO_REFERENCE_PRICE'));
});

test('reference price: stale, wrong source, below tolerance, synthetic, unset tolerance', () => {
  assert(priceGate(good(), { reference: ref({ timestamp: 600 }), nowSeconds: 1000, policy: proven }).reasons.includes('REFERENCE_STALE'));
  assert(priceGate(good(), { reference: ref({ source: 'pool-spot' }), nowSeconds: 1000, policy: proven }).reasons.includes('REFERENCE_SOURCE_MISMATCH'));
  const below = priceGate(good({ outRaw: 980n }), { reference: ref(), nowSeconds: 1000, policy: proven });
  assert.equal(below.decision, DECISION.FAIL); assert.equal(below.checks.belowReferenceBps, 200);
  const synthetic = priceGate(good(), { reference: ref({ synthetic: true }), nowSeconds: 1000, policy: proven });
  assert.equal(synthetic.decision, DECISION.UNPROVEN); assert.deepEqual(synthetic.reasons, ['SYNTHETIC_REFERENCE']);
  assert(priceGate(good(), { reference: ref(), nowSeconds: 1000, policy: { ...proven, userToleranceBps: null } }).reasons.includes('USER_TOLERANCE_UNSET'));
  assert(priceGate(good(), { reference: ref(), policy: proven }).reasons.includes('REFERENCE_STALENESS_UNCHECKED'));
});

test('mechanics: PASS only with a proven policy, a fresh real reference and every check satisfied', () => {
  const g = priceGate(good({ outRaw: 995n }), { peers: [peer()], reference: ref(), nowSeconds: 1100, policy: proven });
  assert.equal(g.decision, DECISION.PASS); assert.equal(g.executable, true); assert.deepEqual(g.reasons, []);
});

test('basket gate: any FAIL fails, any UNPROVEN blocks, empty fails', () => {
  const P = { decision: DECISION.PASS, reasons: [] }, U = { decision: DECISION.UNPROVEN, reasons: ['POLICY_NOT_PROVEN'] }, F = { decision: DECISION.FAIL, reasons: ['HOOK_NOT_ALLOWLISTED'] };
  assert.equal(basketGate([P, P]).decision, DECISION.PASS);
  assert.equal(basketGate([P, U]).decision, DECISION.UNPROVEN); assert.equal(basketGate([P, U]).executable, false);
  assert.equal(basketGate([U, F]).decision, DECISION.FAIL);
  assert.equal(basketGate([]).decision, DECISION.FAIL);
});
