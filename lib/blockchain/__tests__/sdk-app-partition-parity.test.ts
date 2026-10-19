import { describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// One planner, two callers. For the same strategy and deposit, BAG's PRODUCTION purchase path
// (calculateDepositAllocation → buildExecutionPlan → buildPurchaseIntentSteps) and the SDK's planPurchase must
// produce the same Composer legs: same tokens in the same order, same whole-bp weights, same swapped amount, same
// partition nodes — or both refuse the single-transaction route. Only the network call (buildComposerPurchase) is
// replaced: it records what BAG would compile and refuses, so no Composer API is reached.
// -----------------------------------------------------------------------------

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
import { parseBag, planPartition, planPurchase, PurchasePlanError, type BagDocument, type PurchasePlan } from '@/packages/bag-sdk/src';
import type { BasketRecipe } from '@/types/basket-protocol';

const USDG = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '7'.repeat(40);
// Mixed-case addresses, deliberately not in sorted order.
const addr = (i: number) => ('0x' + ((i * 2654435761) % 0xffffff).toString(16).padStart(6, '0') + 'aB'.repeat(17)).slice(0, 42);

let seed = 20261019;
const rand = (m: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % m);

function weights(n: number, spread: number): number[] | null {
  const raw = Array.from({ length: n }, () => 1 + rand(spread));
  const s = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => Math.max(1, Math.floor((x * 10000) / s)));
  w[0] += 10000 - w.reduce((a, b) => a + b, 0);
  return w.every((x) => x > 0) ? w : null;
}

function recipe(assets: { address: string; decimals: number; weightBps: number }[]): BasketRecipe {
  return {
    id: 'r', bagId: 'b', name: 'n', symbol: 'S', description: '', chain: 'robinhood', strategyType: 'STATIC_BASKET',
    assets: assets.map((a, i) => ({ chain: 'robinhood' as const, address: a.address, symbol: `S${i}`, decimals: a.decimals, weightBps: a.weightBps })),
    rebalanceRule: { frequency: 'MANUAL' } as BasketRecipe['rebalanceRule'], minInvestment: 0, maxAssets: 100, minWeightBps: 0, maxWeightBps: 10000,
    mutability: 'MUTABLE', version: 1, createdAt: '2026-10-19T00:00:00Z',
  };
}

function bagJson(assets: { address: string; decimals: number; weightBps: number }[]): BagDocument {
  const r = parseBag({
    bagJson: 1,
    definition: {
      kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'MUTABLE',
      assets: assets.map((a) => ({ chain: 'robinhood', address: a.address, decimals: a.decimals, weightBps: a.weightBps })),
      rules: { weightBounds: { minBps: 1, maxBps: 10000 }, maxAssets: 100, minInvestment: null, swapSlippageBps: 100, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: null },
    },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
}

type Side = { kind: 'COMPOSER'; legs: { address: string; weightBps: number }[]; inputAmountRaw: string } | { kind: 'REFUSED' };

async function appSide(assets: { address: string; decimals: number; weightBps: number }[], deposit: bigint): Promise<Side> {
  const plan = calculateDepositAllocation({ bagId: 'b', inputAsset: { chain: 'robinhood', address: USDG }, amountRaw: deposit.toString() }, recipe(assets));
  const exec = buildExecutionPlan(plan);
  captured.length = 0;
  await buildPurchaseIntentSteps(exec.steps, SIGNER, 6, { apiKey: 'test', slippageBps: 100, resolveOutputDecimals: () => 18 });
  if (captured.length === 0) return { kind: 'REFUSED' };
  return { kind: 'COMPOSER', legs: captured[0].legs.map((l) => ({ address: l.address.toLowerCase(), weightBps: l.weightBps })), inputAmountRaw: captured[0].inputAmountRaw };
}

function sdkSide(assets: { address: string; decimals: number; weightBps: number }[], deposit: bigint): { side: Side; plan: PurchasePlan | null } {
  try {
    const plan = planPurchase(bagJson(assets), { inputToken: USDG, amountRaw: deposit, signer: SIGNER });
    return { side: { kind: 'COMPOSER', legs: plan.legs.map((l) => ({ address: l.token, weightBps: l.legBps })), inputAmountRaw: plan.swapAmountRaw.toString() }, plan };
  } catch (e) {
    if (e instanceof PurchasePlanError && e.issues.every((i) => i.code === 'AMOUNT_TOO_SMALL')) return { side: { kind: 'REFUSED' }, plan: null };
    throw e;
  }
}

async function expectParity(assets: { address: string; decimals: number; weightBps: number }[], deposit: bigint) {
  const app = await appSide(assets, deposit);
  const { side: sdk, plan } = sdkSide(assets, deposit);
  expect(app).toEqual(sdk);
  if (app.kind === 'COMPOSER' && plan) {
    // The nodes BAG's adapter builds from these legs are the SDK plan's partition.
    expect(planPartition(app.legs.map((l) => l.weightBps))).toEqual(plan.partition);
  }
  return app.kind;
}

describe('SDK planPurchase ↔ BAG purchase path: same Composer legs and partition', () => {
  it('random baskets of 2–16 assets and arbitrary deposits', async () => {
    let composer = 0;
    for (let t = 0; t < 300; t++) {
      const w = weights(2 + rand(15), 3000);
      if (!w) continue;
      const assets = w.map((weightBps, i) => ({ address: addr(t * 100 + i), decimals: 18, weightBps }));
      if ((await expectParity(assets, BigInt(1_000_000 + rand(2_000_000_000)) * BigInt(1 + rand(997)))) === 'COMPOSER') composer++;
    }
    expect(composer).toBeGreaterThan(250);
  });

  it('baskets above 16 assets (two partition levels), up to the 100-asset limit', async () => {
    for (const n of [17, 23, 40, 100]) {
      const w = weights(n, 500)!;
      const assets = w.map((weightBps, i) => ({ address: addr(n * 1000 + i), decimals: 18, weightBps }));
      expect(await expectParity(assets, BigInt(123_456_789_012))).toBe('COMPOSER');
    }
  });

  it('a part kept in the input asset (USDG is one of the assets) is never swapped, on both sides', async () => {
    for (let t = 0; t < 100; t++) {
      const w = weights(3 + rand(10), 2000);
      if (!w) continue;
      const assets = w.map((weightBps, i) => ({ address: i === 0 ? USDG : addr(5000 + t * 50 + i), decimals: i === 0 ? 6 : 18, weightBps }));
      await expectParity(assets, BigInt(10_000_000 + rand(1_000_000_000)));
    }
  });

  it('many 1 bp assets next to a large one', async () => {
    const w = [...Array(15).fill(1), 10000 - 15];
    const assets = w.map((weightBps, i) => ({ address: addr(9000 + i), decimals: 18, weightBps }));
    expect(await expectParity(assets, BigInt(123_456_789))).toBe('COMPOSER');
  });

  // Not the planner: what happens BEFORE it when a deposit gives an asset 0 raw units. BAG drops that asset from
  // the purchase (execution-plan.ts skips a zero allocation) and buys the rest; the SDK refuses the whole purchase
  // (AMOUNT_TOO_SMALL). Pinned here so the difference stays visible until one policy is chosen for both.
  it('KNOWN DIFFERENCE (open decision): a deposit that gives an asset nothing', async () => {
    const w = [...Array(15).fill(1), 10000 - 15];
    const assets = w.map((weightBps, i) => ({ address: addr(9000 + i), decimals: 18, weightBps }));
    const app = await appSide(assets, BigInt(5_000));
    expect(app.kind === 'COMPOSER' && app.legs.length).toBeLessThan(assets.length);
    expect(sdkSide(assets, BigInt(5_000)).side).toEqual({ kind: 'REFUSED' });
  });
});
