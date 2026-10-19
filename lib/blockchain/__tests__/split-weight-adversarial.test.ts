import { describe, expect, it, vi } from 'vitest';

// Split-weight regression (found in the Phase 1 evidence run, fixed by the SDK partition planner). Drives the PRODUCTION purchase path — calculateDepositAllocation →
// buildExecutionPlan → buildPurchaseIntentSteps (tryBuildComposerSteps) — and captures the leg weights it hands to
// Composer. Only the network call (buildComposerPurchase) is replaced: it records the request and refuses, so no
// Composer API is reached. What a leg then receives on chain is modelled with simulatePartition, i.e. the documented
// core.partition rule (floor per share, last share takes the remainder; @lifi/composer-sdk 0.11.3 doc comment). The
// on-chain behaviour of core.partition is NOT observed here.
//
// Tolerance under test: packages/bag-sdk/src/split.ts — an on-chain bps splitter may deviate from the normative
// target (splitByWeight / distributeExactByWeight) by LESS than V1_EXECUTION_TOLERANCE_BPS (2) of the deposit per asset.

const captured: { legs: { address: string; weightBps: number }[]; inputAmountRaw: string }[] = [];
vi.mock('@/lib/blockchain/lifi-composer-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blockchain/lifi-composer-adapter')>();
  return {
    ...actual,
    buildComposerPurchase: async (req: { legs: { address: string; weightBps: number }[]; inputAmountRaw: string }) => {
      captured.push({ legs: req.legs.map((l) => ({ address: l.address, weightBps: l.weightBps })), inputAmountRaw: req.inputAmountRaw });
      throw new Error('test: captured, not compiled');
    },
  };
});

import { calculateDepositAllocation } from '@/lib/domain/basket-protocol/deposit/allocation';
import { buildExecutionPlan } from '@/lib/domain/basket-protocol/deposit/execution-plan';
import { buildPurchaseIntentSteps } from '@/lib/blockchain/lifi-purchase-quote';
import { simulatePartition } from '@/lib/blockchain/lifi-composer-adapter';
import { V1_EXECUTION_TOLERANCE_BPS } from '@/packages/bag-sdk/src/split';
import type { BasketRecipe } from '@/types/basket-protocol';

const USDG = '0x' + '0'.repeat(39) + '1';
const addr = (i: number) => '0x' + (0xa000 + i).toString(16).padStart(40, '0');

function recipe(weights: number[], keepWeight = 0): BasketRecipe {
  const assets = weights.map((w, i) => ({ chain: 'robinhood' as const, address: addr(i), symbol: `S${i}`, decimals: 18, weightBps: w }));
  if (keepWeight > 0) assets.push({ chain: 'robinhood', address: USDG, symbol: 'USDG', decimals: 6, weightBps: keepWeight });
  return {
    id: 'r', bagId: 'b', name: 'n', symbol: 'S', description: '', chain: 'robinhood', strategyType: 'STATIC_BASKET', assets,
    rebalanceRule: { frequency: 'MANUAL' } as BasketRecipe['rebalanceRule'], minInvestment: 0, maxAssets: 100, minWeightBps: 0, maxWeightBps: 10000,
    mutability: 'MUTABLE', version: 1, createdAt: '2026-10-19T00:00:00Z',
  };
}

/** The rule production now uses (bag-sdk largestRemainderBps), recomputed independently here as a cross-check. */
function largestRemainderBps(amounts: bigint[]): number[] {
  const total = amounts.reduce((a, b) => a + b, BigInt(0));
  const exact = amounts.map((a) => a * BigInt(10000));
  const bps = exact.map((x) => Number(x / total));
  let left = 10000 - bps.reduce((a, b) => a + b, 0);
  const order = exact.map((x, k) => ({ k, r: x % total })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.k - b.k));
  for (let j = 0; left > 0; j++, left--) bps[order[j].k] += 1;
  return bps;
}

type Outcome = { path: 'COMPOSER' | 'NOT_COMPOSER' | 'FEWER_THAN_TWO_SWAPS'; worst: number; candidateWorst: number; conserved: boolean };

/** Worst per-asset deviation (bps of the deposit) between what each swap leg receives on chain and its exact target. */
async function worstDeviationBps(weights: number[], deposit: bigint, keepWeight = 0): Promise<Outcome> {
  const plan = calculateDepositAllocation({ bagId: 'b', inputAsset: { chain: 'robinhood', address: USDG }, amountRaw: deposit.toString() }, recipe(weights, keepWeight));
  const exec = buildExecutionPlan(plan);
  captured.length = 0;
  await buildPurchaseIntentSteps(exec.steps, '0x' + '7'.repeat(40), 6, { apiKey: 'test', slippageBps: 100, resolveOutputDecimals: () => 18 });
  const swaps = exec.steps.filter((s) => s.action === 'SWAP');
  const targets = swaps.map((s) => BigInt(s.route.inputAmountRaw));
  const total = targets.reduce((a, b) => a + b, BigInt(0));
  const dev = (executed: bigint[]) => Math.max(...executed.map((e, i) => (Math.abs(Number(e - targets[i])) / Number(deposit)) * 10000));
  const candidateWorst = swaps.length < 2 ? 0 : dev(simulatePartition(total, largestRemainderBps(targets)));
  if (swaps.length < 2) return { path: 'FEWER_THAN_TWO_SWAPS', worst: 0, candidateWorst, conserved: true };
  // Composer was not attempted: tryBuildComposerSteps returned null (a leg's derived bps floored to 0) → sequential path.
  if (captured.length === 0) return { path: 'NOT_COMPOSER', worst: 0, candidateWorst, conserved: true };
  const { legs, inputAmountRaw } = captured[0];
  const executed = simulatePartition(BigInt(inputAmountRaw), legs.map((l) => l.weightBps));
  const conserved = executed.reduce((a, b) => a + b, BigInt(0)) === BigInt(inputAmountRaw) && BigInt(inputAmountRaw) === total;
  return { path: 'COMPOSER', worst: dev(executed), candidateWorst, conserved };
}

let seed = 20261019;
const rand = (m: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % m);
const stats = (rs: Outcome[]) => ({
  composer: rs.filter((r) => r.path === 'COMPOSER').length,
  notComposer: rs.filter((r) => r.path === 'NOT_COMPOSER').length,
  worst: Math.max(0, ...rs.map((r) => r.worst)),
  candidateWorst: Math.max(0, ...rs.map((r) => r.candidateWorst)),
});
const report = (label: string, rs: Outcome[]) => {
  const st = stats(rs);
  console.log(`${label}: ${rs.length} cases, Composer ${st.composer}, fell back to per-asset ${st.notComposer}; worst ${st.worst.toFixed(3)} bps (current), ${st.candidateWorst.toFixed(3)} bps (candidate)`);
  return st;
};
const randomWeights = (n: number, spread: number) => {
  const raw = Array.from({ length: n }, () => 1 + rand(spread));
  const s = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => Math.max(1, Math.floor((x * 10000) / s)));
  w[0] += 10000 - w.reduce((a, b) => a + b, 0);
  return w.every((x) => x > 0) ? w : null;
};

describe('split-weight drift on the production Composer purchase path', () => {
  it('conserves the whole swap input and stays within the v1 tolerance for uneven weights and arbitrary amounts', async () => {
    const rs: Outcome[] = [];
    for (let t = 0; t < 400; t++) {
      const w = randomWeights(2 + rand(15), 3000);
      if (!w) continue;
      const deposit = BigInt(1_000_000 + rand(2_000_000_000)) * BigInt(1 + rand(997)); // ≥ $1 of a 6-decimal stablecoin
      rs.push(await worstDeviationBps(w, deposit));
    }
    const st = report('uneven weights, arbitrary amounts', rs);
    expect(rs.every((r) => r.conserved)).toBe(true);
    expect(st.notComposer).toBe(0);
    expect(st.worst).toBeLessThan(V1_EXECUTION_TOLERANCE_BPS);
  });

  it('stays within tolerance when part of the deposit is KEPT in the input asset', async () => {
    const rs: Outcome[] = [];
    for (let t = 0; t < 400; t++) {
      const keep = 500 + rand(4000);
      const w = randomWeights(2 + rand(15), 3000);
      if (!w) continue;
      const scaled = w.map((x) => Math.max(1, Math.floor((x * (10000 - keep)) / 10000)));
      scaled[0] += 10000 - keep - scaled.reduce((a, b) => a + b, 0);
      if (scaled.some((x) => x <= 0)) continue;
      const deposit = BigInt(1_000_000 + rand(2_000_000_000)) * BigInt(1 + rand(997));
      rs.push(await worstDeviationBps(scaled, deposit, keep));
    }
    const st = report('with a KEEP leg', rs);
    expect(rs.every((r) => r.conserved)).toBe(true);
    expect(st.notComposer).toBe(0);
    expect(st.worst).toBeLessThan(V1_EXECUTION_TOLERANCE_BPS);
  });

  it('stays within tolerance with many 1 bp legs next to large ones', async () => {
    const w = [...Array(15).fill(1), 10000 - 15];
    const rs = [await worstDeviationBps(w, BigInt(123_456_789)), await worstDeviationBps([...w].reverse(), BigInt(987_654_321)), await worstDeviationBps(w, BigInt(10) ** BigInt(18) + BigInt(7))];
    const st = report('fifteen 1 bp legs + one large', rs);
    expect(st.notComposer).toBe(0);
    expect(st.worst).toBeLessThan(V1_EXECUTION_TOLERANCE_BPS);
  });

  it('stays within tolerance at rounding boundaries (amounts one unit either side of exact divisibility)', async () => {
    const rs: Outcome[] = [];
    for (const base of [BigInt(1_000_000), BigInt(10) ** BigInt(9), BigInt(10) ** BigInt(18)]) {
      for (const d of [-BigInt(1), BigInt(0), BigInt(1)]) rs.push(await worstDeviationBps([3333, 3333, 3334], base * BigInt(3) + d));
    }
    for (const base of [BigInt(9_999) * BigInt(1_000_003), BigInt(10_001) * BigInt(999_983)]) rs.push(await worstDeviationBps([1, 2, 9997], base));
    const st = report('rounding boundaries', rs);
    expect(st.notComposer).toBe(0);
    expect(st.worst).toBeLessThan(V1_EXECUTION_TOLERANCE_BPS);
  });

  it('characterises tiny deposits (below 2 bps per raw unit), where no bps-based split can meet a bps tolerance', async () => {
    const rows: string[] = [];
    for (const deposit of [BigInt(3), BigInt(99), BigInt(4_999), BigInt(30_000)]) {
      const r = await worstDeviationBps([3333, 3333, 3334], deposit);
      rows.push(`${deposit} raw: ${r.path}, current ${r.worst.toFixed(1)} bps, candidate ${r.candidateWorst.toFixed(1)} bps`);
      expect(r.conserved).toBe(true);
    }
    console.log(`tiny deposits (informational): ${rows.join('; ')}`);
  });
});
