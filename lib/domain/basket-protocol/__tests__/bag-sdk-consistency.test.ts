import { describe, expect, it } from 'vitest';
import { V1_DEFAULTS, V1_LIMITS, BAG_V1_CHAINS, splitByWeight } from '@/packages/bag-sdk/src';
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
});
