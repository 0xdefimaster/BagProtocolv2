import test from 'node:test';
import assert from 'node:assert/strict';
import { routerDcaReadiness } from '../lib/router-dca-gate.mjs';

const run = (over = {}) => ({ amountUsdg: '5', basket: { status: 'EXECUTED', stage: 'RECEIPT_VERIFIED' }, basketGate: { decision: 'PRICE_POLICY_UNPROVEN', reasons: ['POLICY_NOT_PROVEN'] },
  legs: [{ routerPick: { source: 'uniswap-v3' } }], ...over });

test('a receipt-verified basket alone does not make router DCA ready', () => {
  const r = routerDcaReadiness({ blockMode: { label: 'SINGLE_BLOCK' }, runs: [run()] });
  assert.equal(r.status, 'BLOCKED');
  assert.deepEqual(r.closed, ['PRICE_POLICY', 'PLAN_SIGNER_TRUST', 'ROUTER_PLAN_CONTRACT', 'BAG_REGISTRY']);
  assert.equal(r.gates.find(g => g.id === 'EXECUTION_EVIDENCE').status, 'OPEN');
});

test('non-archive per-unit evidence, failed baskets and v4 picks close more gates', () => {
  const r = routerDcaReadiness({ blockMode: { label: 'NON_ARCHIVE_PER_UNIT' }, runs: [run({ basket: { status: 'REVERTED', stage: 'NONE' }, legs: [{ routerPick: { source: 'uniswap-v4' } }] })] });
  for (const id of ['EXECUTION_EVIDENCE', 'SAME_BLOCK_EVIDENCE', 'V4_ADAPTER']) assert(r.closed.includes(id), id);
});

test('structural gates stay closed even if every measured gate were open', () => {
  const r = routerDcaReadiness({ blockMode: { label: 'SINGLE_BLOCK' }, runs: [run({ basketGate: { decision: 'PASS', reasons: [] } })] });
  assert.equal(r.status, 'BLOCKED'); assert.deepEqual(r.closed, ['PLAN_SIGNER_TRUST', 'ROUTER_PLAN_CONTRACT', 'BAG_REGISTRY']);
});

test('an empty report is blocked', () => assert.equal(routerDcaReadiness({}).status, 'BLOCKED'));
