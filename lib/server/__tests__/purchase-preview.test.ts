import { describe, expect, it } from 'vitest';
import { BasketRecipe, DEFAULT_REBALANCE_RULE, NavResult, ShareSupply } from '@/types/basket-protocol';
import { computePurchasePreview, isKeepAllocation, PREVIEW_DISCLAIMER } from '../purchase-preview';

// -----------------------------------------------------------------------------
// Phase 12 — Purchase Preview pipeline. Deliberately does not re-test the
// math inside calculateDepositAllocation()/buildExecutionPlan()/
// getDepositQuote() themselves (see their own suites) — only that this
// module wires them together correctly and maps their failures to the
// right typed PurchasePreviewError.
//
// Phase 13 — `shareSupply` is now a required input (previously hardcoded
// to zero inside this file); `zeroShareSupply()`/`realShareSupply()` below
// exercise both the bootstrap AND the real, non-bootstrap pricing path.
// -----------------------------------------------------------------------------

const USDC = { chain: 'ethereum' as const, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
const NVDA = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111111' };
const AAPL = { chain: 'ethereum' as const, address: '0x2222222222222222222222222222222222222222' };

function recipe(overrides: Partial<BasketRecipe> = {}): BasketRecipe {
  return {
    id: 'recipe_bag_1_v1',
    bagId: 'bag_1',
    name: 'AI Revolution',
    symbol: 'AIREV',
    description: 'NVDA + AAPL',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets: [
      { chain: 'ethereum', address: NVDA.address, symbol: 'NVDA', decimals: 18, weightBps: 6000 },
      { chain: 'ethereum', address: AAPL.address, symbol: 'AAPL', decimals: 18, weightBps: 4000 },
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 1,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 8000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function zeroNav(): NavResult {
  return { asOf: new Date().toISOString(), quoteCurrency: 'USD', components: [], grossNav: '0', netNav: '0' };
}

function nav(grossNav: string): NavResult {
  return { asOf: new Date().toISOString(), quoteCurrency: 'USD', components: [], grossNav, netNav: grossNav };
}

function zeroShareSupply(bagId = 'bag_1'): ShareSupply {
  return { bagId, totalSharesRaw: '0', shareDecimals: 18, updatedAt: new Date(0).toISOString() };
}

function shareSupply(totalShares: number, bagId = 'bag_1'): ShareSupply {
  return {
    bagId,
    totalSharesRaw: (BigInt(totalShares) * BigInt(10) ** BigInt(18)).toString(),
    shareDecimals: 18,
    updatedAt: new Date().toISOString(),
  };
}

describe('computePurchasePreview', () => {
  it('100 USDC -> a valid DepositPlan, DepositQuote, and ExecutionPlan', () => {
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '100',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.disclaimer).toBe(PREVIEW_DISCLAIMER);
    expect(outcome.inputAmountRaw).toBe('100000000'); // 100 * 10^6
    expect(outcome.depositPlan.allocations).toHaveLength(2);
    expect(outcome.depositPlan.unallocatedRaw).toBe('0');
    expect(outcome.executionPlan.steps).toHaveLength(2);
    expect(outcome.executionPlan.steps.every((s) => s.action === 'SWAP')).toBe(true);
    expect(outcome.depositQuote.isBootstrap).toBe(true);
    expect(outcome.isBootstrap).toBe(true);
  });

  it("rejects a deposit below the creator's minimum investment", () => {
    const outcome = computePurchasePreview({
      recipe: recipe({ minInvestment: 250 }),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '100',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ kind: 'BELOW_MIN_INVESTMENT', minimum: 250 });
  });

  it('a minimum of 0 means no minimum', () => {
    const outcome = computePurchasePreview({
      recipe: recipe({ minInvestment: 0 }),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '1',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(true);
  });

  it('input asset present in the target composition is KEEP, not SWAP', () => {
    const targetIsInput = recipe({
      assets: [
        { chain: 'ethereum', address: USDC.address, symbol: 'USDC', decimals: 6, weightBps: 5000 },
        { chain: 'ethereum', address: NVDA.address, symbol: 'NVDA', decimals: 18, weightBps: 5000 },
      ],
    });

    const outcome = computePurchasePreview({
      recipe: targetIsInput,
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '100',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const keepAllocation = outcome.depositPlan.allocations.find((a) => a.targetSymbol === 'USDC');
    expect(keepAllocation).toBeDefined();
    expect(keepAllocation!.action).toBe('KEEP');
    expect(isKeepAllocation(keepAllocation!, USDC)).toBe(true);

    // KEEP still produces an execution step (spec: "KEEP allocation with a
    // nonzero value DOES produce a step"), but never as a SWAP.
    const keepStep = outcome.executionPlan.steps.find((s) => s.targetSymbol === 'USDC');
    expect(keepStep?.action).toBe('KEEP');
  });

  it('rejects a zero amount', () => {
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '0',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ZERO_AMOUNT');
  });

  it('rejects a negative amount', () => {
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '-5',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('INVALID_AMOUNT');
  });

  it('rejects a non-numeric amount', () => {
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: 'abc',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('INVALID_AMOUNT');
  });

  it('rejects a recipe whose weights do not sum to 100%', () => {
    const badRecipe = recipe({
      assets: [{ chain: 'ethereum', address: NVDA.address, symbol: 'NVDA', decimals: 18, weightBps: 9000 }],
    });
    const outcome = computePurchasePreview({
      recipe: badRecipe,
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '100',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('INVALID_RECIPE');
  });

  it('NAV/share = 10, deposit = 1000 -> 100 estimated shares (post-bootstrap path via getDepositQuote)', () => {
    // getDepositQuote() only leaves the bootstrap branch once share supply
    // is non-zero, which this product never produces yet (see this file's
    // module doc) — so this asserts the bootstrap-path arithmetic
    // (1 share = 1 unit of quote currency at bootstrap) instead, which is
    // the actual reachable path today.
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '1000',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.depositQuote.sharePrice).toBe('1');
    expect(BigInt(outcome.depositQuote.sharesRaw)).toBe(BigInt(1000) * BigInt(10) ** BigInt(outcome.depositQuote.shareDecimals));
  });

  it('residual: total allocated + unallocated equals the input amount exactly', () => {
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '99.999999',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const total = BigInt(outcome.depositPlan.totalAllocatedRaw) + BigInt(outcome.depositPlan.unallocatedRaw);
    expect(total.toString()).toBe(outcome.inputAmountRaw);
  });

  it('is deterministic: same input produces the same preview', () => {
    const input = {
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '250.5',
      nav: zeroNav(),
      shareSupply: zeroShareSupply(),
    };
    const a = computePurchasePreview(input);
    const b = computePurchasePreview(input);
    expect(a).toEqual(b);
  });

  it('real, non-bootstrap pricing: NAV/share = $10, 250 deposit -> 25 shares (Phase 13)', () => {
    // Supply = 100 shares, NAV = $1000 -> NAV/share = $10 — a real,
    // non-bootstrap Bag, unreachable before Phase 13 wired a real
    // shareSupply through instead of this file's old hardcoded zero.
    const outcome = computePurchasePreview({
      recipe: recipe(),
      inputAsset: USDC,
      inputSymbol: 'USDC',
      inputDecimals: 6,
      amount: '250',
      nav: nav('1000'),
      shareSupply: shareSupply(100),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.isBootstrap).toBe(false);
    expect(outcome.depositQuote.sharePrice).toBe('10.000000000000000000');
    expect(BigInt(outcome.depositQuote.sharesRaw)).toBe(BigInt(25) * BigInt(10) ** BigInt(18));
  });
});
