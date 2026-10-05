import { describe, expect, it } from 'vitest';
import { buildPurchaseReceipt, buildRedeemReceipt, chainIdFor, publicOutcome, publicStepOutcome, purchaseProvider, ReceiptContext, sortReceipts, toMicros } from '../execution-receipts';
import { PurchaseIntent, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import { RedeemIntent } from '@/types/redeem-intent';
import { CanonicalAsset } from '@/types/basket-protocol';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0x00000000000000000000000000000000000000a1';
const AMD = '0x00000000000000000000000000000000000000a2';
const TX = '0x' + 'ab'.repeat(32);
const APPROVE = '0x' + 'cd'.repeat(32);
const PLAN = '0x' + 'ee'.repeat(32);

function step(i: number, address: string, over: Partial<PurchaseIntentStepRecord> = {}): PurchaseIntentStepRecord {
  return {
    stepIndex: i, action: 'SWAP', targetSymbol: 'X', inputAsset: { chain: 'robinhood', address: USDG }, outputAsset: { chain: 'robinhood', address },
    sourceChain: 'robinhood', destinationChain: 'robinhood', inputAmountRaw: '500000', targetValueRaw: '500000',
    outputAmountRaw: '1000', outputDecimals: 18, minOutputRaw: '990', providerEnforcedMinOutputRaw: '985', route: 'composer', lifiStep: null,
    status: 'COMPLETED', approvalTxHash: APPROVE, txHash: TX, providerSubstatus: null, failureCode: null, ...over,
  } as PurchaseIntentStepRecord;
}

function purchase(over: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    id: 'intent-1', userId: 'user-1', walletAddress: '0xwallet', bagId: 'bag-1', inputAsset: { chain: 'robinhood', address: USDG }, inputAmountRaw: '1000000',
    sharesRaw: '980000000000000000', shareDecimals: 18, routeFingerprint: 'fp', recipeVersion: 5, compositionHash: 'h5',
    navSnapshot: { grossNav: '1', quoteCurrency: 'USD', asOf: '' }, sharePriceAtQuote: null, depositAmount: '1',
    steps: [step(0, NVDA), step(1, AMD, { outputAmountRaw: '2000', minOutputRaw: '1980' })],
    composerTransaction: { to: '0xvm', data: '0x', value: '0', chainId: 4663, userProxy: '0xp' }, bagRouterTransaction: null,
    providerId: null, executionPlanHash: null, executionMode: null, fallback: null, status: 'COMPLETED', failureCode: null,
    createdAt: '2026-10-01T10:00:00Z', expiresAt: '', executedAt: '2026-10-01T10:01:00Z', accountingAppliedAt: '2026-10-01T10:01:00Z', reconciliationAppliedAt: null,
    ...over,
  } as PurchaseIntent;
}

const reg = (address: string, symbol: string, decimals: number) => ({ chain: 'robinhood', address, symbol, decimals }) as CanonicalAsset;
function ctx(over: Partial<ReceiptContext> = {}): ReceiptContext {
  return {
    assetsByKey: new Map([
      [`robinhood:${USDG.toLowerCase()}`, reg(USDG, 'USDG', 6)],
      [`robinhood:${NVDA}`, reg(NVDA, 'NVDA', 18)],
      [`robinhood:${AMD}`, reg(AMD, 'AMD', 18)],
    ]),
    claims: new Map([[`robinhood:${TX}`, { chain: 'robinhood', tx_hash: TX, intent_kind: 'PURCHASE' as const, intent_id: 'intent-1' }]]),
    versionHashes: new Map([[5, 'h5']]),
    ...over,
  };
}

describe('buildPurchaseReceipt', () => {
  it('a completed Composer purchase: provider, version, input, verified tx, on-chain-derived actual outputs and their minimums', () => {
    const r = buildPurchaseReceipt(purchase(), ctx());
    expect(r).toMatchObject({ executionId: 'intent-1', kind: 'PURCHASE', bagId: 'bag-1', strategyVersion: 5, versionBinding: 'MATCHES_VERSION_RECORD', provider: 'LIFI_COMPOSER' });
    expect(r.input).toEqual({ unit: 'TOKEN', asset: { chain: 'robinhood', chainId: 4663, address: USDG, symbol: 'USDG', decimals: 6 }, amountRaw: '1000000', decimals: 6, source: 'EXECUTION_PLAN' });
    expect(r).toMatchObject({ outcome: 'SUCCEEDED', isFinal: true });
    expect(r.evidence).toEqual({ level: 'ONCHAIN', swapSteps: 2, filledSwaps: 2, onchainDerived: 2, providerReported: 0, coveredByTotal: 0, unrecorded: 0 });
    expect(r.outputs[0]).toMatchObject({ asset: { symbol: 'NVDA' }, bagMinimumRaw: '990', providerEnforcedMinimumRaw: '985', actualRaw: '1000', actualSource: 'ONCHAIN_DERIVED', quotedRaw: null, minimumRespected: true });
    expect(r.transactions).toEqual([
      { txHash: APPROVE, chain: 'robinhood', chainId: 4663, role: 'APPROVAL', verification: 'REPORTED_UNVERIFIED', claim: 'UNCLAIMED' },
      { txHash: TX, chain: 'robinhood', chainId: 4663, role: 'EXECUTION', verification: 'VERIFIED', claim: 'THIS_EXECUTION' },
    ]);
    expect(r.blockNumber).toBeNull();
    expect(r.blockTimestamp).toBeNull();
    expect(r.policyEvaluation).toEqual({
      policySnapshotAvailable: false,
      evaluatedAgainstVersion: 5,
      checks: [
        { check: 'ACTUAL_AT_LEAST_MINIMUM', result: 'PASS' },
        { check: 'TX_CLAIMED_BY_THIS_EXECUTION', result: 'PASS' },
        { check: 'VERSION_BINDING', result: 'PASS' },
      ],
      noRouteFallback: null,
    });
  });

  it('records the provider from server-side fields, and the plan hash; only the BAG Router plan hash counts as checked on-chain', () => {
    expect(purchaseProvider(purchase({ providerId: 'bag-router' }))).toBe('BAG_ROUTER');
    expect(purchaseProvider(purchase({ providerId: 'lifi-sequential' }))).toBe('LIFI_SEQUENTIAL');
    expect(purchaseProvider(purchase({ providerId: 'something-new' }))).toBe('UNKNOWN');
    expect(purchaseProvider(purchase({ composerTransaction: null, bagRouterTransaction: { to: '', data: '', value: '0', chainId: 1, inputToken: '', inputAmountRaw: '', bagOnChainId: '' } }))).toBe('BAG_ROUTER');

    const router = buildPurchaseReceipt(purchase({ providerId: 'bag-router', executionPlanHash: PLAN, composerTransaction: null }), ctx());
    expect(router).toMatchObject({ provider: 'BAG_ROUTER', executionPlanHash: PLAN, planHashCheckedOnchain: true });
    const composer = buildPurchaseReceipt(purchase({ providerId: 'lifi-composer', executionPlanHash: PLAN }), ctx());
    expect(composer).toMatchObject({ executionPlanHash: PLAN, planHashCheckedOnchain: false });
  });

  it('never shows a quote as the actual output: unfinished steps have actual null and the quote labelled as such', () => {
    const r = buildPurchaseReceipt(purchase({ status: 'FAILED', steps: [step(0, NVDA, { status: 'FAILED', outputAmountRaw: '1000' })] }), ctx());
    expect(r.outputs[0]).toMatchObject({ outcome: 'FAILED', actualRaw: null, actualSource: null, quotedRaw: '1000', minimumRespected: null });
    expect(r).toMatchObject({ outcome: 'FAILED', isFinal: true });
    expect(r.evidence.level).toBe('NONE');
    expect(r.transactions.find((t) => t.role === 'EXECUTION')).toMatchObject({ verification: 'REPORTED_UNVERIFIED' });
    expect(r.policyEvaluation.checks[0]).toEqual({ check: 'ACTUAL_AT_LEAST_MINIMUM', result: 'UNKNOWN' });
  });

  it('sequential: actual is provider-reported only when a minimum forced a received amount; otherwise null', () => {
    const seq = (minOutputRaw: string | null) =>
      buildPurchaseReceipt(purchase({ composerTransaction: null, steps: [step(0, NVDA, { lifiStep: {}, minOutputRaw, providerEnforcedMinOutputRaw: null })] }), ctx());
    expect(seq('990').outputs[0]).toMatchObject({ actualRaw: '1000', actualSource: 'PROVIDER_REPORTED' });
    expect(seq('990').evidence.level).toBe('PROVIDER');
    expect(seq(null).outputs[0]).toMatchObject({ actualRaw: null, actualSource: null });
    expect(seq(null).evidence).toMatchObject({ level: 'PARTIAL', unrecorded: 1 });
  });

  it('flags a tx claimed by another execution and a version mismatch', () => {
    const other = ctx({ claims: new Map([[`robinhood:${TX}`, { chain: 'robinhood', tx_hash: TX, intent_kind: 'PURCHASE', intent_id: 'someone-else' }]]), versionHashes: new Map([[5, 'tampered']]) });
    const r = buildPurchaseReceipt(purchase(), other);
    expect(r.transactions.find((t) => t.role === 'EXECUTION')).toMatchObject({ claim: 'OTHER_EXECUTION', verification: 'REPORTED_UNVERIFIED' });
    expect(r.versionBinding).toBe('MISMATCH');
    expect(r.policyEvaluation.checks.map((c) => c.result)).toEqual(['PASS', 'FAIL', 'FAIL']);
    expect(buildPurchaseReceipt(purchase(), ctx({ versionHashes: new Map() })).versionBinding).toBe('VERSION_NOT_FOUND');
  });

  it('an actual below the BAG minimum is reported as a failed check, not hidden', () => {
    const r = buildPurchaseReceipt(purchase({ steps: [step(0, NVDA, { outputAmountRaw: '900' })] }), ctx());
    expect(r.outputs[0].minimumRespected).toBe(false);
    expect(r.policyEvaluation.checks[0].result).toBe('FAIL');
  });

  it('records the no-route fallback that was applied, and KEEP steps as BAG-recorded allocations', () => {
    const r = buildPurchaseReceipt(
      purchase({
        fallback: { policy: 'HOLD_INPUT', assets: [{ chain: 'robinhood', address: AMD, symbol: 'AMD' }], unroutableWeightBps: 2000, amountScaleBps: 10000 } as PurchaseIntent['fallback'],
        steps: [step(0, NVDA), step(1, USDG, { action: 'KEEP', outputAmountRaw: null, minOutputRaw: null, txHash: null, approvalTxHash: null, inputAmountRaw: '200000' })],
      }),
      ctx()
    );
    expect(r.policyEvaluation.noRouteFallback).toEqual({
      policy: 'HOLD_INPUT',
      skippedAssets: [{ chain: 'robinhood', chainId: 4663, address: AMD, symbol: 'AMD', decimals: 18 }],
      unroutableWeightBps: 2000,
    });
    expect(r.outputs[1]).toMatchObject({ action: 'KEEP', outcome: 'HELD', actualRaw: '200000', actualSource: 'BAG_RECORDED', bagMinimumRaw: null });
    // Keep steps never count as evidence.
    expect(r.evidence).toMatchObject({ swapSteps: 1, filledSwaps: 1, level: 'ONCHAIN' });
  });

  it('exposes no internal user id', () => {
    expect(JSON.stringify(buildPurchaseReceipt(purchase(), ctx()))).not.toContain('user-1');
  });
});

describe('buildRedeemReceipt', () => {
  const redeem = (over: Partial<RedeemIntent> = {}): RedeemIntent =>
    ({
      id: 'redeem-1', userId: 'user-1', walletAddress: '0xwallet', bagId: 'bag-1', sharesRaw: '500000000000000000', shareDecimals: 18,
      outputAsset: { chain: 'robinhood', address: USDG }, outputDecimals: 6, routeFingerprint: 'fp', sharePriceAtQuote: '1', redeemValueQuote: '0.5',
      steps: [step(0, USDG, { inputAsset: { chain: 'robinhood', address: NVDA }, inputAmountRaw: '500', outputAmountRaw: '480000', outputDecimals: 6, minOutputRaw: '470000', providerEnforcedMinOutputRaw: null, lifiStep: {} })],
      status: 'COMPLETED', failureCode: null, createdAt: '2026-10-02T10:00:00Z', updatedAt: '', expiresAt: '', executedAt: '2026-10-02T10:01:00Z',
      accountingAppliedAt: null, reconciliationAppliedAt: null, ...over,
    }) as RedeemIntent;

  it('uses the same receipt shape: shares in, payment token out, no version recorded', () => {
    const claims = new Map([[`robinhood:${TX}`, { chain: 'robinhood', tx_hash: TX, intent_kind: 'REDEEM' as const, intent_id: 'redeem-1' }]]);
    const r = buildRedeemReceipt(redeem(), ctx({ claims }));
    expect(r).toMatchObject({ kind: 'REDEEM', provider: 'LIFI_SEQUENTIAL', strategyVersion: null, versionBinding: 'NOT_RECORDED', executionPlanHash: null, planHashCheckedOnchain: false });
    expect(r.input).toEqual({ unit: 'BAG_SHARES', asset: null, amountRaw: '500000000000000000', decimals: 18, source: 'EXECUTION_PLAN' });
    expect(r.outputs[0]).toMatchObject({ asset: { symbol: 'USDG', decimals: 6 }, actualRaw: '480000', actualSource: 'PROVIDER_REPORTED', minimumRespected: true });
    expect(r.policyEvaluation.checks.find((c) => c.check === 'VERSION_BINDING')).toEqual({ check: 'VERSION_BINDING', result: 'UNKNOWN' });
    // What was sold is on each output; one transaction per asset → total from the legs, weakest source.
    expect(r.outputs[0].soldAsset).toMatchObject({ address: NVDA });
    expect(r.totalReceived).toMatchObject({ asset: { symbol: 'USDG' }, actualRaw: '480000', actualSource: 'PROVIDER_REPORTED', providerEnforcedMinimumRaw: null });
    expect(r.evidence).toMatchObject({ level: 'PROVIDER', coveredByTotal: 0, unrecorded: 0 });
  });

  // The live V2 round trip: a 50% sale of four holdings into USDG in ONE LI.FI Composer transaction.
  const composerRedeem = (over: Partial<RedeemIntent> = {}) =>
    redeem({
      composerTransaction: { to: '0xvm', data: '0x', value: '0', chainId: 4663, approvals: [] },
      steps: [
        step(0, USDG, { inputAsset: { chain: 'robinhood', address: NVDA }, inputAmountRaw: '500', outputAmountRaw: '831000', outputDecimals: 6, minOutputRaw: null, providerEnforcedMinOutputRaw: '831000' }),
        step(1, USDG, { inputAsset: { chain: 'robinhood', address: AMD }, inputAmountRaw: '700', outputAmountRaw: '1599000', outputDecimals: 6, minOutputRaw: null, providerEnforcedMinOutputRaw: '1590000' }),
      ],
      ...over,
    });

  it('one-transaction (Composer) redeem: provider is LI.FI Composer, the total comes from the tx receipt, legs are never shown as per-leg outcomes', () => {
    const claims = new Map([[`robinhood:${TX}`, { chain: 'robinhood', tx_hash: TX, intent_kind: 'REDEEM' as const, intent_id: 'redeem-1' }]]);
    const r = buildRedeemReceipt(composerRedeem(), ctx({ claims }));
    expect(r.provider).toBe('LIFI_COMPOSER');
    for (const o of r.outputs) expect(o).toMatchObject({ outcome: 'FILLED', actualRaw: null, actualSource: null, quotedRaw: null, minimumRespected: null });
    expect(r.outputs.map((o) => o.soldAsset?.address)).toEqual([NVDA, AMD]);
    expect(r.totalReceived).toEqual({
      asset: expect.objectContaining({ address: USDG, decimals: 6 }),
      actualRaw: '2430000',
      actualSource: 'ONCHAIN_DERIVED',
      providerEnforcedMinimumRaw: '2421000',
    });
    expect(r.evidence).toEqual({ level: 'ONCHAIN', swapSteps: 2, filledSwaps: 2, onchainDerived: 0, providerReported: 0, coveredByTotal: 2, unrecorded: 0 });
    expect(r.policyEvaluation.checks.find((c) => c.check === 'TX_CLAIMED_BY_THIS_EXECUTION')?.result).toBe('PASS');
  });

  it('one-transaction redeem not verified yet: no total, and the stored leg amounts are not shown as quotes either', () => {
    const pending = composerRedeem({ status: 'CONFIRMING' as never });
    pending.steps = pending.steps.map((s) => ({ ...s, status: 'CONFIRMING' as never }));
    const r = buildRedeemReceipt(pending, ctx());
    expect(r.totalReceived).toBeNull();
    for (const o of r.outputs) expect(o).toMatchObject({ outcome: 'PENDING', actualRaw: null, quotedRaw: null });
    expect(r.evidence.level).toBe('NONE');
  });

  it('a purchase never has a total or a sold asset', () => {
    const r = buildPurchaseReceipt(purchase(), ctx());
    expect(r.totalReceived).toBeNull();
    expect(r.outputs.every((o) => o.soldAsset === null)).toBe(true);
    expect(r.evidence.coveredByTotal).toBe(0);
  });
});

describe('sortReceipts', () => {
  it('newest first, deterministic on ties', () => {
    const a = buildPurchaseReceipt(purchase({ id: 'b', createdAt: '2026-10-01T00:00:00Z' }), ctx());
    const b = buildPurchaseReceipt(purchase({ id: 'a', createdAt: '2026-10-01T00:00:00Z' }), ctx());
    const c = buildPurchaseReceipt(purchase({ id: 'c', createdAt: '2026-10-03T00:00:00Z' }), ctx());
    expect(sortReceipts([a, b, c]).map((r) => r.executionId)).toEqual(['c', 'a', 'b']);
    expect(sortReceipts([c, b, a]).map((r) => r.executionId)).toEqual(['c', 'a', 'b']);
  });
});

describe('public status mapping (independent of internal enums)', () => {
  it('maps every internal intent status; anything unknown is UNKNOWN, never guessed', () => {
    expect(publicOutcome('COMPLETED')).toBe('SUCCEEDED');
    expect(publicOutcome('PARTIAL_SUCCESS')).toBe('PARTIAL');
    expect(publicOutcome('RECONCILIATION_REQUIRED')).toBe('PARTIAL');
    expect(publicOutcome('FAILED')).toBe('FAILED');
    expect(publicOutcome('SUBMITTED')).toBe('PENDING');
    expect(publicOutcome('CONFIRMING')).toBe('PENDING');
    for (const s of ['DRAFT', 'QUOTED', 'READY', 'AWAITING_SIGNATURE', 'EXPIRED', 'CANCELLED', 'SOMETHING_NEW']) expect(publicOutcome(s)).toBe('UNKNOWN');
  });

  it('maps step statuses; a swap with no submitted tx is NOT_SUBMITTED; unknown is UNKNOWN', () => {
    const s = (status: string, txHash: string | null = null, action: 'SWAP' | 'KEEP' = 'SWAP') => publicStepOutcome({ action, status: status as never, txHash });
    expect(s('COMPLETED', TX)).toBe('FILLED');
    expect(s('FAILED', TX)).toBe('FAILED');
    expect(s('SUBMITTED', TX)).toBe('PENDING');
    expect(s('CONFIRMING', TX)).toBe('PENDING');
    expect(s('APPROVAL_CONFIRMED')).toBe('NOT_SUBMITTED');
    expect(s('AWAITING_SIGNATURE')).toBe('NOT_SUBMITTED');
    expect(s('PENDING')).toBe('NOT_SUBMITTED');
    expect(s('NOT_NEEDED', null, 'KEEP')).toBe('HELD');
    expect(s('WHATEVER')).toBe('UNKNOWN');
  });

  it('a receipt never exposes an internal status string', () => {
    const json = JSON.stringify(buildPurchaseReceipt(purchase({ status: 'RECONCILIATION_REQUIRED' }), ctx()));
    expect(json).not.toMatch(/RECONCILIATION_REQUIRED|PARTIAL_SUCCESS|AWAITING_SIGNATURE|"COMPLETED"|"status"|"stepStatus"/);
    expect(JSON.parse(json)).toMatchObject({ outcome: 'PARTIAL', isFinal: true });
    expect(buildPurchaseReceipt(purchase({ status: 'PARTIAL_SUCCESS' }), ctx())).toMatchObject({ outcome: 'PARTIAL', isFinal: false });
    expect(buildPurchaseReceipt(purchase({ status: 'CONFIRMING' }), ctx())).toMatchObject({ outcome: 'PENDING', isFinal: false });
  });
});

describe('forward-open and identity fields', () => {
  it('future fields are typed open (null today, not permanently null)', () => {
    const r = buildPurchaseReceipt(purchase(), ctx());
    expect(r.blockNumber).toBeNull();
    expect(r.blockTimestamp).toBeNull();
    expect(r.policyEvaluation.policySnapshotAvailable).toBe(false);
    // Type-level: these assignments compile only because the types are open.
    const future: Pick<typeof r, 'blockNumber' | 'blockTimestamp'> = { blockNumber: 123, blockTimestamp: '2026-10-01T00:00:00Z' };
    const snap: (typeof r)['policyEvaluation']['policySnapshotAvailable'] = true;
    expect(future.blockNumber).toBe(123);
    expect(snap).toBe(true);
  });

  it('chainId comes from BAG chain config by slug; non-EVM chains get null', () => {
    expect(chainIdFor('robinhood')).toBe(4663);
    expect(chainIdFor('ethereum')).toBe(1);
    expect(chainIdFor('base')).toBe(8453);
    expect(chainIdFor('solana')).toBeNull();
  });

  it('timestamps compare at microsecond precision regardless of fraction length', () => {
    expect(toMicros('2026-10-01T10:00:00.1+00:00')).toBe(toMicros('2026-10-01T10:00:00.100000+00:00'));
    expect(toMicros('2026-10-01T10:00:00.000002Z') > toMicros('2026-10-01T10:00:00.000001Z')).toBe(true);
    expect(toMicros('2026-10-01T10:00:00+00:00')).toBe(toMicros('2026-10-01T10:00:00Z'));
  });
});
