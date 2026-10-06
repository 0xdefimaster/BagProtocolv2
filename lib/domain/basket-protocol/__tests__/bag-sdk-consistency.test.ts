import { describe, expect, it } from 'vitest';
import { V1_DEFAULTS, V1_LIMITS, BAG_V1_CHAINS, splitByWeight, V1_EXECUTION_TOLERANCE_BPS } from '@/packages/bag-sdk/src';
import { computeCascadeSplitBps } from '@/lib/blockchain/lifi-composer-adapter';
import { distributeExactByWeight } from '../exact-allocation';
import { assetIdentityKey } from '../asset-identity';
import {
  DEFAULT_MAX_WEIGHT_BPS,
  DEFAULT_MIN_WEIGHT_BPS,
  DEFAULT_REBALANCE_RULE,
  DEFAULT_STRATEGY_TYPE,
  DEFAULT_UNROUTABLE_POLICY,
  MAX_PERFORMANCE_FEE_BPS,
  defaultMaxAssets,
} from '@/types/basket-protocol';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';
import { MAX_VALIDATE_ASSETS } from '@/lib/server/validate-bag';
import { validateWeightInvariants } from '../validation';
import type { BasketRecipe } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// The SDK's frozen v1 semantics must be what BAG itself applies. If a BAG
// default moves, this fails: either the change is reverted, or it ships as a
// new bag.json version — never as a silent divergence between BAG and the SDK.
// -----------------------------------------------------------------------------

describe('bag.json v1 (SDK) ↔ BAG app', () => {
  it('null defaults are BAG’s defaults', () => {
    expect(V1_DEFAULTS.kind).toBe(DEFAULT_STRATEGY_TYPE);
    expect(V1_DEFAULTS.minWeightBps).toBe(DEFAULT_MIN_WEIGHT_BPS);
    expect(V1_DEFAULTS.maxWeightBps).toBe(DEFAULT_MAX_WEIGHT_BPS);
    expect(Math.max(3, V1_DEFAULTS.maxAssetsFloor)).toBe(defaultMaxAssets(3));
    expect(Math.max(12, V1_DEFAULTS.maxAssetsFloor)).toBe(defaultMaxAssets(12));
    expect(V1_DEFAULTS.rebalanceFrequency).toBe(DEFAULT_REBALANCE_RULE.frequency);
    expect(V1_DEFAULTS.driftThresholdBps).toBe(DEFAULT_REBALANCE_RULE.driftThresholdBps);
    expect(V1_DEFAULTS.swapSlippageBps).toBe(DEFAULT_REBALANCE_RULE.maxSlippageBps);
    expect(V1_DEFAULTS.swapSlippageBps).toBe(DEFAULT_COMPOSER_SLIPPAGE_BPS);
    expect(V1_DEFAULTS.noRouteAssetPolicy).toBe(DEFAULT_UNROUTABLE_POLICY);
  });

  it('limits are BAG’s limits', () => {
    expect(V1_LIMITS.MAX_PERFORMANCE_FEE_BPS).toBe(MAX_PERFORMANCE_FEE_BPS);
    expect(V1_LIMITS.MAX_ASSETS).toBe(MAX_VALIDATE_ASSETS);
    expect(BAG_V1_CHAINS.robinhood).toBe(4663);
  });

  it('weights must sum to exactly 10000 in BAG too (the purchase path refuses anything else)', () => {
    const recipe = (w: number[]) => ({ assets: w.map((weightBps, i) => ({ chain: 'robinhood', address: `0x${String(i + 1).padStart(40, '0')}`, symbol: `A${i}`, decimals: 18, weightBps })) }) as unknown as BasketRecipe;
    expect(validateWeightInvariants(recipe([6000, 4000]))).toEqual([]);
    for (const w of [[5999, 4000], [6001, 4000], [3333, 3333, 3333]]) {
      expect(validateWeightInvariants(recipe(w)).map((i) => i.code)).toEqual(['WEIGHTS_NOT_100']);
    }
  });

  it('the normative deposit split is exactly BAG’s purchase split (distributeExactByWeight)', () => {
    const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`.replace('0xa', '0xA');
    let seed = 7;
    const rand = (m: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % m);
    for (let t = 0; t < 300; t++) {
      const n = 1 + rand(6);
      const weights = Array.from({ length: n }, () => 1 + rand(3000));
      const sum = weights.reduce((a, b) => a + b, 0);
      const scaled = weights.map((w) => Math.floor((w * 10000) / sum));
      scaled[0] += 10000 - scaled.reduce((a, b) => a + b, 0);
      if (scaled.some((w) => w <= 0)) continue;
      const assets = scaled.map((weightBps, i) => ({ chain: 'robinhood' as const, address: addr(0xa0 + i * 7), decimals: 18, weightBps }));
      const amount = BigInt(rand(1_000_000_007)) * BigInt(1 + rand(1000));
      const sdk = splitByWeight(amount, { assets });
      const bag = distributeExactByWeight(amount, assets.map((a) => ({ key: assetIdentityKey(a), weightBps: a.weightBps })), 10000);
      expect([...sdk.entries()].sort()).toEqual([...bag.entries()].sort());
      expect([...sdk.values()].reduce((a, b) => a + b, BigInt(0))).toBe(amount);
    }
  });

  it('BAG’s Composer purchase (on-chain bps cascade) stays within the v1 execution bound of the exact target', () => {
    // Mirrors lifi-purchase-quote.ts: exact target amounts → whole-bp leg weights (last leg absorbs) →
    // computeCascadeSplitBps → each on-chain split takes `bps` of what remains.
    let seed = 11;
    const rand = (m: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % m);
    let worst = 0;
    for (let t = 0; t < 3000; t++) {
      const n = 2 + rand(9);
      const raw = Array.from({ length: n }, () => 1 + rand(3000));
      const sum = raw.reduce((a, b) => a + b, 0);
      const weights = raw.map((w) => Math.floor((w * 10000) / sum));
      weights[0] += 10000 - weights.reduce((a, b) => a + b, 0);
      if (weights.some((w) => w <= 0)) continue;
      const assets = weights.map((weightBps, i) => ({ chain: 'robinhood' as const, address: `0x${(0xa0 + i).toString(16).padStart(40, '0')}`, decimals: 18, weightBps }));
      const amount = BigInt(1 + rand(1_000_000_007)) * BigInt(1_000_000);
      const target = [...splitByWeight(amount, { assets }).values()];
      // amounts → leg bps exactly as lifi-purchase-quote.ts does
      let assigned = 0;
      const legBps = target.map((a, i) => {
        if (i === n - 1) return 10000 - assigned;
        const b = Number((a * BigInt(10000)) / amount);
        assigned += b;
        return b;
      });
      if (legBps.some((b) => b <= 0)) continue;
      const steps = computeCascadeSplitBps(legBps.map((weightBps, i) => ({ address: assets[i].address, weightBps, symbol: `A${i}` })));
      let remaining = amount;
      const executed = steps.map((bps) => {
        const part = (remaining * BigInt(bps)) / BigInt(10000);
        remaining -= part;
        return part;
      });
      executed.push(remaining);
      expect(executed.reduce((a, b) => a + b, BigInt(0))).toBe(amount); // whole deposit spent
      executed.forEach((e, i) => {
        const dev = Math.abs(Number(e - target[i])) / Number(amount) * 10000;
        worst = Math.max(worst, dev);
      });
    }
    expect(worst).toBeLessThan(V1_EXECUTION_TOLERANCE_BPS);
  });
});
