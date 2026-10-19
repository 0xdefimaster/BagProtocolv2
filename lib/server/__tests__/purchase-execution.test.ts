import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BagRecord, BagVersionRecord, BasketRecipe, CanonicalAsset, DEFAULT_REBALANCE_RULE, NavResult, ShareSupply } from '@/types/basket-protocol';
import { PurchaseIntent, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import { SessionPayload } from '@/lib/auth/session';
import { calculateDepositAllocation } from '@/lib/domain/basket-protocol/deposit/allocation';
import { buildExecutionPlan } from '@/lib/domain/basket-protocol/deposit/execution-plan';
import { computeExecutionPlanFingerprint } from '@/lib/domain/basket-protocol/purchase-intent/fingerprint';
import { buildBagExecutionGraph, computeBagExecutionGraphHash } from '@/lib/execution/plan';
import { DEFAULT_COMPOSER_SLIPPAGE_BPS } from '@/lib/blockchain/lifi-purchase-quote';
import { BagExecutionError } from '@/lib/execution/errors';
import { CompiledExecution } from '@/lib/execution/types';

// -----------------------------------------------------------------------------
// Phase 17 — orchestration-level tests for lib/server/purchase-execution.ts.
// Same "mock every repo, run the real pure domain math" convention as
// lib/server/__tests__/purchase-preview-route.test.ts: computePurchasePreview
// itself is exercised for real (fixtures below), while all I/O
// (bag-repo, asset-repo, bag-nav, bag-share-state-repo,
// purchase-intent-repo, the real-wallet LI.FI quoting/status modules) is
// mocked — no real network or database call happens in this suite.
//
// Covers the spec Aşama 13 test list items this module is responsible for:
// unauthorized intent access, expired intent, quote-fingerprint mismatch,
// duplicate/idempotent execution, canonical registry enforcement remaining
// active, and accounting idempotency.
// -----------------------------------------------------------------------------

const getBagByIdMock = vi.fn();
const getCurrentBagVersionMock = vi.fn();
const getVerifiedIdentityKeysMock = vi.fn();
const listAssetsMock = vi.fn();
const getBagNavMock = vi.fn();
const getShareSupplyMock = vi.fn();
const buildPurchaseIntentStepsMock = vi.fn();
const trackStepStatusMock = vi.fn();
const trackBagRouterTransactionMock = vi.fn();
const trackComposerTransactionMock = vi.fn();
const compileBagExecutionMock = vi.fn();
const compileBagExecutionCandidatesMock = vi.fn();
const annotateCandidateMetricsMock = vi.fn();
const rankCandidatesMock = vi.fn();
const buildDefaultProvidersMock = vi.fn();
const checkAssetRouteMock = vi.fn();

const findActivePurchaseIntentForBagMock = vi.fn();
const createPurchaseIntentMock = vi.fn();
const getPurchaseIntentForUserMock = vi.fn();
const updatePurchaseIntentStatusMock = vi.fn();
const updatePurchaseIntentStepsMock = vi.fn();
const markAccountingAppliedMock = vi.fn();
const markReconciliationAppliedMock = vi.fn();

vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: (...args: unknown[]) => getBagByIdMock(...args),
  getCurrentBagVersion: (...args: unknown[]) => getCurrentBagVersionMock(...args),
}));
vi.mock('@/lib/server/asset-repo', () => ({
  getVerifiedIdentityKeys: (...args: unknown[]) => getVerifiedIdentityKeysMock(...args),
  listAssets: (...args: unknown[]) => listAssetsMock(...args),
}));
vi.mock('@/lib/server/asset-route-check', () => ({
  checkAssetRoute: (...args: unknown[]) => checkAssetRouteMock(...args),
}));
vi.mock('@/lib/server/stock-token-guard', () => ({
  checkStockTokensForPurchase: async () => ({ ok: true }),
}));
vi.mock('@/lib/server/bag-nav', () => ({
  getBagNav: (...args: unknown[]) => getBagNavMock(...args),
  getBagNavSafe: async (...args: unknown[]) => ({ ok: true, nav: await getBagNavMock(...args) }),
}));
vi.mock('@/lib/server/bag-share-state-repo', () => ({
  getShareSupply: (...args: unknown[]) => getShareSupplyMock(...args),
}));
vi.mock('@/lib/blockchain/lifi-purchase-quote', () => ({
  buildPurchaseIntentSteps: (...args: unknown[]) => buildPurchaseIntentStepsMock(...args),
  DEFAULT_COMPOSER_SLIPPAGE_BPS: 100,
}));
vi.mock('@/lib/blockchain/lifi-status', () => ({
  trackStepStatus: (...args: unknown[]) => trackStepStatusMock(...args),
}));
vi.mock('@/lib/blockchain/bag-router-status', () => ({
  trackBagRouterTransaction: (...args: unknown[]) => trackBagRouterTransactionMock(...args),
}));
vi.mock('@/lib/blockchain/composer-status', () => ({
  trackComposerTransaction: (...args: unknown[]) => trackComposerTransactionMock(...args),
}));
vi.mock('@/lib/execution/compiler', () => ({
  compileBagExecution: (...args: unknown[]) => compileBagExecutionMock(...args),
  compileBagExecutionCandidates: (...args: unknown[]) => compileBagExecutionCandidatesMock(...args),
}));
vi.mock('@/lib/execution/candidate-metrics', () => ({
  annotateCandidateMetrics: (...args: unknown[]) => annotateCandidateMetricsMock(...args),
}));
vi.mock('@/lib/execution/candidate-ranking', () => ({
  rankCandidates: (...args: unknown[]) => rankCandidatesMock(...args),
}));
vi.mock('@/lib/execution/registry', () => ({
  buildDefaultProviders: (...args: unknown[]) => buildDefaultProvidersMock(...args),
}));
vi.mock('@/lib/server/purchase-intent-repo', async () => {
  // The real repo asserts every status transition before writing; keep that
  // here so a test can never "pass" an invalid transition the database layer
  // would reject in production (e.g. SUBMITTED -> COMPLETED).
  const { assertValidPurchaseIntentTransition } = await vi.importActual<typeof import('@/lib/domain/basket-protocol/purchase-intent/state-machine')>(
    '@/lib/domain/basket-protocol/purchase-intent/state-machine'
  );
  return {
  createPurchaseIntent: (...args: unknown[]) => createPurchaseIntentMock(...args),
  findActivePurchaseIntentForBag: (...args: unknown[]) => findActivePurchaseIntentForBagMock(...args),
  getPurchaseIntentForUser: (...args: unknown[]) => getPurchaseIntentForUserMock(...args),
  markAccountingApplied: (...args: unknown[]) => markAccountingAppliedMock(...args),
  markReconciliationApplied: (...args: unknown[]) => markReconciliationAppliedMock(...args),
  updatePurchaseIntentStatus: (...args: unknown[]) => {
    const input = args[1] as { from: Parameters<typeof assertValidPurchaseIntentTransition>[0]; to: Parameters<typeof assertValidPurchaseIntentTransition>[1] };
    assertValidPurchaseIntentTransition(input.from, input.to);
    return updatePurchaseIntentStatusMock(...args);
  },
  updatePurchaseIntentSteps: (...args: unknown[]) => updatePurchaseIntentStepsMock(...args),
  };
});

const {
  createPurchaseIntentForUser,
  getPurchaseOptionsForUser,
  prepareExecution,
  recordStepEvent,
  verifyExecution,
} = await import('../purchase-execution');

// ----------------------------- fixtures ---------------------------------------

const USDC: CanonicalAsset = {
  id: 'asset_usdc',
  chain: 'ethereum',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  status: 'VERIFIED',
  assetType: 'crypto',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const NVDA_ADDRESS = '0x1111111111111111111111111111111111111111';
const AAPL_ADDRESS = '0x2222222222222222222222222222222222222222';

function recipe(): BasketRecipe {
  return {
    id: 'recipe_bag_1_v1',
    bagId: 'bag_1',
    name: 'AI Revolution',
    symbol: 'AIREV',
    description: 'NVDA + AAPL',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    assets: [
      { chain: 'ethereum', address: NVDA_ADDRESS, symbol: 'NVDA', decimals: 18, weightBps: 6000 },
      { chain: 'ethereum', address: AAPL_ADDRESS, symbol: 'AAPL', decimals: 18, weightBps: 4000 },
    ],
    rebalanceRule: DEFAULT_REBALANCE_RULE,
    minInvestment: 1,
    maxAssets: 10,
    minWeightBps: 100,
    maxWeightBps: 8000,
    mutability: 'MUTABLE',
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

function bagRecord(): BagRecord {
  return {
    id: 'bag_1',
    slug: 'ai-revolution',
    name: 'AI Revolution',
    symbol: 'AIREV',
    description: 'NVDA + AAPL',
    creatorId: 'creator_1',
    chain: 'ethereum',
    strategyType: 'STATIC_BASKET',
    mutability: 'MUTABLE',
    status: 'ACTIVE',
    currentVersion: 1,
    currentVersionId: 'version_1',
    parentBagId: null,
    rootBagId: null,
    registryId: null,
    contractAddress: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function bagVersion(overrides: Partial<BagVersionRecord> = {}): BagVersionRecord {
  return {
    id: 'version_1',
    bagId: 'bag_1',
    version: 1,
    compositionHash: 'hash',
    recipe: recipe(),
    createdBy: 'creator_1',
    reason: 'initial',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function nav(): NavResult {
  return { asOf: new Date().toISOString(), quoteCurrency: 'USD', components: [], grossNav: '1000', netNav: '1000' };
}

function shareSupply(): ShareSupply {
  return { bagId: 'bag_1', totalSharesRaw: '100000000000000000000', shareDecimals: 18, updatedAt: new Date().toISOString() };
}

function session(): SessionPayload {
  return { userId: 'user_1', walletAddress: '0xREALWALLET000000000000000000000000000001' };
}

function swapStepRecord(overrides: Partial<PurchaseIntentStepRecord> = {}): PurchaseIntentStepRecord {
  return {
    stepIndex: 0,
    action: 'SWAP',
    targetSymbol: 'xNVDA',
    inputAsset: { chain: 'ethereum', address: USDC.address },
    outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
    sourceChain: 'ethereum',
    destinationChain: 'ethereum',
    inputAmountRaw: '60000000',
    targetValueRaw: '60000000',
    outputAmountRaw: '10000000000000000000',
    outputDecimals: 18,
    minOutputRaw: '9900000000000000000',
    route: 'uniswap',
    lifiStep: { some: 'lifi-step-payload' },
    status: 'PENDING',
    approvalTxHash: null,
    txHash: null,
    providerSubstatus: null,
    failureCode: null,
    ...overrides,
  };
}

function intentFixture(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    id: 'intent_1',
    userId: 'user_1',
    walletAddress: session().walletAddress,
    bagId: 'bag_1',
    inputAsset: { chain: 'ethereum', address: USDC.address },
    inputAmountRaw: '100000000',
    sharesRaw: '100000000000000000000',
    shareDecimals: 18,
    // Real fingerprint of `recipe()`/USDC/'100000000' (Phase 18: prepareExecution
    // now recomputes and compares this exactly, not just an "output asset
    // set" heuristic) — a hardcoded fake string would make every "still
    // matches" test fail against the new strict check.
    routeFingerprint: computeExecutionPlanFingerprint(
      buildExecutionPlan(
        calculateDepositAllocation({ bagId: 'bag_1', inputAsset: { chain: 'ethereum', address: USDC.address }, amountRaw: '100000000' }, recipe())
      )
    ),
    recipeVersion: 1,
    compositionHash: 'hash',
    navSnapshot: { grossNav: '1000', quoteCurrency: 'USD', asOf: new Date().toISOString() },
    sharePriceAtQuote: '10',
    depositAmount: '1000',
    steps: [swapStepRecord()],
    composerTransaction: null,
    bagRouterTransaction: null,
    providerId: null,
    executionPlanHash: null,
    executionMode: null,
    status: 'READY',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    executedAt: null,
    accountingAppliedAt: null,
    reconciliationAppliedAt: null,
    failureCode: null,
    ...overrides,
  };
}

/** Real hash of the `BagExecutionGraph` `recipe()`/USDC/'100000000' (the
 * exact plan `intentFixture()`'s `routeFingerprint` is also computed from)
 * produces — the compiler-layer counterpart to `routeFingerprint` in the
 * fixture above, used by the `executionPlanHash` integrity tests below so a
 * hardcoded fake hash doesn't make every "still matches" case fail against
 * the real check. */
function realExecutionPlanHash(): string {
  const plan = calculateDepositAllocation(
    { bagId: 'bag_1', inputAsset: { chain: 'ethereum', address: USDC.address }, amountRaw: '100000000' },
    recipe()
  );
  const graph = buildBagExecutionGraph(buildExecutionPlan(plan), {
    wallet: session().walletAddress,
    chainId: 'ethereum',
    defaultSlippageBps: DEFAULT_COMPOSER_SLIPPAGE_BPS,
  });
  return computeBagExecutionGraphHash(graph);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deterministic regardless of the host shell's own env — the Composer
  // attempt in createPurchaseIntentForUser is opt-in based on
  // process.env.LIFI_API_KEY, and these tests exercise the plain
  // sequential path via the mocked buildPurchaseIntentSteps above either
  // way, so a real key in the test runner's environment must not change
  // what args that mock is asserted to have been called with.
  delete process.env.LIFI_API_KEY;
  delete process.env.BAG_EXECUTION_COMPILER_ENABLED;
  buildDefaultProvidersMock.mockReturnValue([]);
  checkAssetRouteMock.mockResolvedValue('ROUTABLE');
  compileBagExecutionCandidatesMock.mockResolvedValue({ candidates: [], executionPlanHash: 'candidates-hash', compiledAt: 1_700_000_000_000 });
  annotateCandidateMetricsMock.mockImplementation(async (set: unknown) => set);
  rankCandidatesMock.mockReturnValue({ executable: [], failed: [], winners: [] });
  getBagByIdMock.mockResolvedValue(bagRecord());
  getCurrentBagVersionMock.mockResolvedValue(bagVersion());
  getVerifiedIdentityKeysMock.mockResolvedValue(new Set(['ethereum:' + NVDA_ADDRESS, 'ethereum:' + AAPL_ADDRESS]));
  listAssetsMock.mockResolvedValue([USDC]);
  getBagNavMock.mockResolvedValue(nav());
  getShareSupplyMock.mockResolvedValue(shareSupply());
  findActivePurchaseIntentForBagMock.mockResolvedValue(null);
  createPurchaseIntentMock.mockImplementation(async (_admin: unknown, input: Record<string, unknown>) => ({
    ...intentFixture(),
    ...input,
  }));
});

// ----------------------------- 1. create ---------------------------------------


/** An admin.rpc mock where every tx-hash claim succeeds and accounting RPCs report "not yet applied". */
function rpcGrantingClaims() {
  return vi.fn(async (name: string) =>
    name === 'claim_intent_tx_hash' ? { data: true, error: null } : { data: { alreadyApplied: false }, error: null }
  );
}

/** Arguments of the (first) apply_purchase_execution / apply_partial_purchase_execution call. */
function applyCall(rpcMock: ReturnType<typeof vi.fn>) {
  const call = rpcMock.mock.calls.find((c) => String(c[0]).startsWith('apply_'));
  return (call?.[1] ?? {}) as Record<string, unknown> & { p_holdings: unknown[] };
}

/**
 * Makes the steps/status repo mocks behave like the real table for one
 * intent row: each write returns the row as it now stands (latest steps AND
 * latest status), which is what the real repo returns. Returns a getter for
 * the final row.
 */
function statefulIntentRow(initial: PurchaseIntent): () => PurchaseIntent {
  let row = initial;
  updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _st: string, steps: PurchaseIntentStepRecord[]) => (row = { ...row, steps }));
  updatePurchaseIntentStatusMock.mockImplementation(async (_a: unknown, u: { to: PurchaseIntent['status']; executedAt?: string }) => {
    row = { ...row, status: u.to, ...(u.executedAt ? { executedAt: u.executedAt } : {}) };
    return row;
  });
  return () => row;
}

describe('createPurchaseIntentForUser', () => {
  for (const status of ['DRAFT', 'ARCHIVED'] as const) {
    it(`refuses a ${status} Bag — only a deployed (ACTIVE) Bag takes investments`, async () => {
      getBagByIdMock.mockResolvedValue({ ...bagRecord(), status });

      const outcome = await createPurchaseIntentForUser({
        admin: {} as never,
        session: session(),
        bagId: 'bag_1',
        inputAssetId: 'asset_usdc',
        amount: '100',
      });

      expect(outcome).toEqual({ ok: false, error: { kind: 'BAG_NOT_LIVE', status } });
      expect(createPurchaseIntentMock).not.toHaveBeenCalled();
    });
  }

  it('quotes against the REAL session wallet address, never a client-supplied one', async () => {
    buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [swapStepRecord()], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    expect(buildPurchaseIntentStepsMock).toHaveBeenCalledWith(expect.anything(), session().walletAddress, USDC.decimals, undefined);
    expect(createPurchaseIntentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ walletAddress: session().walletAddress, userId: session().userId, status: 'READY' })
    );
  });

  it('rejects when a non-terminal intent with a transaction still in flight exists for this (user, bag)', async () => {
    const inFlight = intentFixture({
      id: 'existing_intent',
      status: 'CONFIRMING',
      steps: [swapStepRecord({ status: 'CONFIRMING', txHash: '0x' + 'aa'.repeat(32) })],
    });
    findActivePurchaseIntentForBagMock.mockResolvedValue(inFlight);
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: inFlight });
    trackStepStatusMock.mockResolvedValue({ kind: 'PENDING', substatus: 'WAIT_SOURCE_CONFIRMATIONS' });

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toEqual({ kind: 'PURCHASE_IN_PROGRESS', intentId: 'existing_intent' });
    expect(buildPurchaseIntentStepsMock).not.toHaveBeenCalled();
  });

  it('fails closed when the recipe references an unverified asset (canonical registry enforcement)', async () => {
    getVerifiedIdentityKeysMock.mockResolvedValue(new Set()); // nothing verified

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('REGISTRY_INVALID');
    expect(buildPurchaseIntentStepsMock).not.toHaveBeenCalled();
  });

  it('persists a FAILED intent (not silently discarded) when a real quote fails', async () => {
    buildPurchaseIntentStepsMock.mockResolvedValue({
      steps: [swapStepRecord({ status: 'FAILED', failureCode: 'UNSUPPORTED_ROUTE', lifiStep: null })],
      allSwapsQuoted: false,
      firstFailure: { failureCode: 'UNSUPPORTED_ROUTE', message: 'No route available for your wallet.' },
      composerTransaction: null,
    });

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toEqual({ kind: 'QUOTE_FAILED', failureCode: 'UNSUPPORTED_ROUTE', message: 'No route available for your wallet.' });
    expect(createPurchaseIntentMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'FAILED' }));
  });
});

describe('createPurchaseIntentForUser — Composer price-impact refusal', () => {
  const notice = {
    reason: 'PRICE_IMPACT' as const,
    message: 'Price impact 551 bps exceeds maximum 500 bps (input: $0.9991, output: $0.9440)',
    priceImpactBps: 551,
    maxPriceImpactBps: 500,
    inputUsd: '0.9991',
    outputUsd: '0.9440',
  };
  const base = { admin: {} as never, bagId: 'bag_1', inputAssetId: 'asset_usdc', amount: '100' };

  beforeEach(() => {
    process.env.LIFI_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.LIFI_API_KEY;
  });

  it('fails the intent and returns the refusal to the buyer — never a per-asset purchase', async () => {
    buildPurchaseIntentStepsMock.mockResolvedValue({
      steps: [],
      allSwapsQuoted: false,
      firstFailure: { failureCode: 'SLIPPAGE_EXCEEDED', message: notice.message },
      composerTransaction: null,
      composerFallback: notice,
    });

    const outcome = await createPurchaseIntentForUser({ ...base, session: session() });

    expect(outcome).toEqual({ ok: false, error: { kind: 'QUOTE_FAILED', failureCode: 'SLIPPAGE_EXCEEDED', message: notice.message, composerFallback: notice } });
    const persisted = createPurchaseIntentMock.mock.calls[0][1] as { status: string; steps: { status: string }[] };
    expect(persisted.status).toBe('FAILED');
    expect(persisted.steps.length).toBeGreaterThan(0);
  });

  it('an accepted impact recompiles the single transaction with that limit plus 1%', async () => {
    buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [swapStepRecord()], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });
    await createPurchaseIntentForUser({ ...base, session: session(), acceptedPriceImpactBps: 551 });
    expect(buildPurchaseIntentStepsMock.mock.calls[0][3]).toMatchObject({ maxPriceImpactBps: 651 });
  });

  it('refuses an accepted impact above the 15% ceiling without quoting', async () => {
    const outcome = await createPurchaseIntentForUser({ ...base, session: session(), acceptedPriceImpactBps: 1501 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ kind: 'QUOTE_FAILED', failureCode: 'SLIPPAGE_EXCEEDED' });
    expect(buildPurchaseIntentStepsMock).not.toHaveBeenCalled();
  });
});

// ----------------------------- 1b. createPurchaseIntentForUser — BAG_EXECUTION_COMPILER_ENABLED ---

// The compiler-layer counterpart to the legacy-path tests above. Same
// fixtures (`recipe()` = NVDA 60% / AAPL 40%, USDC input), but
// `compileBagExecution()` (mocked here — its OWN behavior is covered by
// lib/execution/__tests__/compiler.test.ts) drives provider selection
// instead of this file's `buildPurchaseIntentSteps` mock. The bridge
// (`compiledExecutionToPurchaseIntentSteps`) is deliberately left REAL and
// unmocked so these tests exercise the actual CompiledExecution ->
// PurchaseIntentStepRecord[] mapping end to end, not just that a mock was
// called.
describe('createPurchaseIntentForUser — BAG_EXECUTION_COMPILER_ENABLED', () => {
  const composerCompiled: CompiledExecution = {
    mode: 'SINGLE_TX',
    chainId: 1,
    transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 1 }],
    expectedOutputs: [
      { legId: 'leg_0', asset: { chain: 'ethereum', address: NVDA_ADDRESS }, quotedOutputRaw: '10000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
      { legId: 'leg_1', asset: { chain: 'ethereum', address: AAPL_ADDRESS }, quotedOutputRaw: '4000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
    ],
    providerId: 'lifi-composer',
    executionPlanHash: 'test-hash-composer-abc',
    providerMetadata: { userProxy: '0xProxy', legQuotes: {} },
  };

  const sequentialCompiled: CompiledExecution = {
    mode: 'MULTI_TX',
    chainId: 1,
    transactions: [],
    expectedOutputs: [
      { legId: 'leg_0', asset: { chain: 'ethereum', address: NVDA_ADDRESS }, quotedOutputRaw: '9900000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9900000000000000000' },
      { legId: 'leg_1', asset: { chain: 'ethereum', address: AAPL_ADDRESS }, quotedOutputRaw: '3900000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3900000000000000000' },
    ],
    providerId: 'lifi-sequential',
    executionPlanHash: 'test-hash-sequential-xyz',
    providerMetadata: {
      legResults: {
        leg_0: { ok: true, outputAmountRaw: '10000000000000000000', outputDecimals: 18, minOutputRaw: '9900000000000000000', route: 'uniswap', lifiStep: { some: 'lifi-step-nvda' } },
        leg_1: { ok: true, outputAmountRaw: '4000000000000000000', outputDecimals: 18, minOutputRaw: '3900000000000000000', route: 'uniswap', lifiStep: { some: 'lifi-step-aapl' } },
      },
    },
  };

  it('routes through compileBagExecution() instead of the legacy buildPurchaseIntentSteps() path (item 4: no provider-specific routing left in this file)', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockResolvedValue(composerCompiled);

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    expect(buildPurchaseIntentStepsMock).not.toHaveBeenCalled();
    expect(compileBagExecutionMock).toHaveBeenCalledTimes(1);
    const [bagIntentArg, graphArg] = compileBagExecutionMock.mock.calls[0];
    expect(bagIntentArg).toMatchObject({ wallet: session().walletAddress, chainId: 'ethereum', bagId: 'bag_1' });
    expect(graphArg.legs).toHaveLength(2);
  });

  it('a SINGLE_TX (Composer) CompiledExecution maps into composerTransaction + PENDING steps, and persists executionPlanHash', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockResolvedValue(composerCompiled);

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    const insertedInput = createPurchaseIntentMock.mock.calls[0][1];
    expect(insertedInput.status).toBe('READY');
    expect(insertedInput.executionPlanHash).toBe('test-hash-composer-abc');
    expect(insertedInput.composerTransaction).toEqual({ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 1, userProxy: '0xProxy', approvals: [] });
    expect(insertedInput.steps).toHaveLength(2);
    expect(insertedInput.steps[0]).toMatchObject({ action: 'SWAP', status: 'PENDING', outputAmountRaw: '10000000000000000000', minOutputRaw: null, route: null, lifiStep: null });
    expect(insertedInput.steps[1]).toMatchObject({ action: 'SWAP', status: 'PENDING', outputAmountRaw: '4000000000000000000' });
  });

  it('a MULTI_TX (sequential) CompiledExecution maps providerMetadata.legResults into steps carrying the real lifiStep/route, composerTransaction stays null', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockResolvedValue(sequentialCompiled);

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    const insertedInput = createPurchaseIntentMock.mock.calls[0][1];
    expect(insertedInput.composerTransaction).toBeNull();
    expect(insertedInput.executionPlanHash).toBe('test-hash-sequential-xyz');
    expect(insertedInput.steps[0]).toMatchObject({ status: 'PENDING', outputAmountRaw: '10000000000000000000', outputDecimals: 18, route: 'uniswap', lifiStep: { some: 'lifi-step-nvda' } });
    expect(insertedInput.steps[1]).toMatchObject({ status: 'PENDING', lifiStep: { some: 'lifi-step-aapl' } });
  });

  it('when every provider is ineligible/fails (compileBagExecution throws), still persists a FAILED, auditable intent rather than dropping the attempt', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockRejectedValue(new BagExecutionError('NO_ELIGIBLE_PROVIDER', 'no providers support this intent'));

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('QUOTE_FAILED');
    const insertedInput = createPurchaseIntentMock.mock.calls[0][1];
    expect(insertedInput.status).toBe('FAILED');
    expect(insertedInput.executionPlanHash).toBeNull();
    expect(
      (insertedInput.steps as PurchaseIntentStepRecord[]).every((s) => s.action === 'KEEP' || s.status === 'FAILED')
    ).toBe(true);
  });

  it('a compiler error that is NOT a BagExecutionError still propagates (never silently swallowed as a quote failure)', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockRejectedValue(new Error('unexpected bug'));

    await expect(
      createPurchaseIntentForUser({ admin: {} as never, session: session(), bagId: 'bag_1', inputAssetId: 'asset_usdc', amount: '100' })
    ).rejects.toThrow('unexpected bug');
  });

  // ----------------------------- Bag Router execution hardening (item 1/3) ---
  //
  // `bagRouterCompiled.mode === 'SINGLE_TX'` — the SAME mode `composerCompiled`
  // above has. Before the fix, `mode === 'SINGLE_TX'` was the ONLY thing
  // `compiledExecutionToPurchaseIntentSteps()` branched on, so this exact
  // fixture would have been silently mapped into `composerTransaction`
  // instead. These tests assert `providerId` is what actually decides it.

  const bagRouterCompiled: CompiledExecution = {
    mode: 'SINGLE_TX',
    chainId: 4663,
    transactions: [{ to: '0xBagRouterAddress', data: '0xexecutecalldata', value: '0', chainId: 4663 }],
    expectedOutputs: [
      { legId: 'leg_0', asset: { chain: 'ethereum', address: NVDA_ADDRESS }, quotedOutputRaw: '9950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '9950000000000000000' },
      { legId: 'leg_1', asset: { chain: 'ethereum', address: AAPL_ADDRESS }, quotedOutputRaw: '3950000000000000000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '3950000000000000000' },
    ],
    providerId: 'bag-router',
    executionPlanHash: 'test-hash-bag-router-ghi',
    providerMetadata: {
      routerAddress: '0xBagRouterAddress',
      signedPlan: { bagId: '0xOnChainBagId1' },
    },
  };

  it('BagRouter selected provider routes to the BagRouter execution path: providerId persisted, bagRouterTransaction populated, composerTransaction stays null (item 1 — no mode-based misrouting)', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockResolvedValue(bagRouterCompiled);

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    const insertedInput = createPurchaseIntentMock.mock.calls[0][1];
    expect(insertedInput.providerId).toBe('bag-router');
    expect(insertedInput.executionPlanHash).toBe('test-hash-bag-router-ghi');
    // BagRouter never enters Composer execution (item 2): the intent this
    // row produces has NO composerTransaction for `hooks/use-purchase-
    // execution.ts` to (wrongly) pick up.
    expect(insertedInput.composerTransaction).toBeNull();
    expect(insertedInput.bagRouterTransaction).toEqual({
      to: '0xBagRouterAddress',
      data: '0xexecutecalldata',
      value: '0',
      chainId: 4663,
      inputToken: USDC.address,
      inputAmountRaw: '100000000',
      bagOnChainId: '0xOnChainBagId1',
    });
  });

  it('a BagRouter step carries a REAL, non-null outputDecimals/minOutputRaw (item 5) — resolved from the recipe/input-asset decimals already in hand, no extra DB round-trip', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockResolvedValue(bagRouterCompiled);

    await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    const insertedInput = createPurchaseIntentMock.mock.calls[0][1];
    expect(insertedInput.steps[0]).toMatchObject({
      action: 'SWAP',
      status: 'PENDING',
      outputDecimals: 18,
      minOutputRaw: '9950000000000000000',
      outputAmountRaw: '9950000000000000000',
      route: null,
      lifiStep: null,
    });
    expect(insertedInput.steps[1]).toMatchObject({ outputDecimals: 18, minOutputRaw: '3950000000000000000' });
  });
});

// ----------------------------- 1c. createPurchaseIntentForUser — flag OFF stays legacy ---

describe('createPurchaseIntentForUser — BAG_EXECUTION_COMPILER_ENABLED unset (default)', () => {
  it('never calls compileBagExecution — uses the legacy buildPurchaseIntentSteps path exactly as before', async () => {
    buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [swapStepRecord()], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    expect(compileBagExecutionMock).not.toHaveBeenCalled();
    expect(buildPurchaseIntentStepsMock).toHaveBeenCalledTimes(1);
    expect(createPurchaseIntentMock.mock.calls[0][1].executionPlanHash).toBeNull();
  });

  it('rejects a selectedProviderId outright — item 12 "Do not force the new path onto legacy deployments" — never even reaches the duplicate-intent check', async () => {
    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
      selectedProviderId: 'lifi-composer',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('PROVIDER_SELECTION_UNAVAILABLE');
    expect(findActivePurchaseIntentForBagMock).not.toHaveBeenCalled();
    expect(compileBagExecutionMock).not.toHaveBeenCalled();
  });
});

// ----------------------------- 1d. selected-provider revalidation (item 9/11) ---

describe('createPurchaseIntentForUser — selectedProviderId (item 11)', () => {
  const composerCompiled: CompiledExecution = {
    mode: 'SINGLE_TX',
    chainId: 1,
    transactions: [{ to: '0xComposerRouter', data: '0xdeadbeef', value: '0', chainId: 1 }],
    expectedOutputs: [
      { legId: 'leg_0', asset: { chain: 'ethereum', address: NVDA_ADDRESS }, quotedOutputRaw: '10000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
      { legId: 'leg_1', asset: { chain: 'ethereum', address: AAPL_ADDRESS }, quotedOutputRaw: '4000000000000000000', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null },
    ],
    providerId: 'lifi-composer',
    executionPlanHash: 'test-hash-composer-abc',
    providerMetadata: {},
  };

  it('threads selectedProviderId into constraints.allowedProviders — compileBagExecution is asked to try ONLY that provider, never the client-supplied compiled/route/price', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockResolvedValue(composerCompiled);

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
      selectedProviderId: 'lifi-composer',
    });

    expect(outcome.ok).toBe(true);
    expect(compileBagExecutionMock).toHaveBeenCalledTimes(1);
    const [bagIntentArg] = compileBagExecutionMock.mock.calls[0];
    expect(bagIntentArg.constraints).toEqual({ allowedProviders: ['lifi-composer'] });
    // The server re-derived and re-compiled everything itself — the request
    // never carried a compiled execution/calldata/price for the server to
    // trust (there IS no such field on CreatePurchaseIntentParams at all).
  });

  it('when the selected provider is no longer eligible, compileBagExecution\'s NO_ELIGIBLE_PROVIDER is surfaced as an ordinary QUOTE_FAILED — same auditable-FAILED-intent behavior as any other compiler failure, not a special case', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionMock.mockRejectedValue(new BagExecutionError('NO_ELIGIBLE_PROVIDER', 'lifi-composer is no longer eligible for this intent'));

    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
      selectedProviderId: 'lifi-composer',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('QUOTE_FAILED');
    const insertedInput = createPurchaseIntentMock.mock.calls[0][1];
    expect(insertedInput.status).toBe('FAILED');
  });

  it('a selectedProviderId with the flag OFF is rejected before any compile attempt — regression guard duplicating the flag-off describe block above, kept here for locality with the other selectedProviderId tests', async () => {
    const outcome = await createPurchaseIntentForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
      selectedProviderId: 'lifi-composer',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('PROVIDER_SELECTION_UNAVAILABLE');
    expect(compileBagExecutionMock).not.toHaveBeenCalled();
  });
});

// ----------------------------- 1e. getPurchaseOptionsForUser (item 6/9/10) ---

describe('getPurchaseOptionsForUser', () => {
  it('is unavailable with the compiler flag off — never calls compileBagExecutionCandidates, never checks for a duplicate active intent', async () => {
    const outcome = await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('PROVIDER_SELECTION_UNAVAILABLE');
    expect(compileBagExecutionCandidatesMock).not.toHaveBeenCalled();
    expect(findActivePurchaseIntentForBagMock).not.toHaveBeenCalled();
  });

  it('NEVER persists — even with the flag on and a real candidate set, createPurchaseIntent/findActivePurchaseIntentForBag are never called (item 10)', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';

    const outcome = await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
    expect(findActivePurchaseIntentForBagMock).not.toHaveBeenCalled();
  });

  it('runs even while the SAME user already has an active PurchaseIntent for this Bag — a pure comparison has no business colliding with that write-side guard', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    findActivePurchaseIntentForBagMock.mockResolvedValue(intentFixture({ status: 'READY' }));

    const outcome = await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    expect(findActivePurchaseIntentForBagMock).not.toHaveBeenCalled();
  });

  it('calls compileBagExecutionCandidates with the SAME provider-independent intent/graph shape compileBagExecution gets, unconstrained (no allowedProviders) — tries every eligible provider', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';

    await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(compileBagExecutionCandidatesMock).toHaveBeenCalledTimes(1);
    const [bagIntentArg, graphArg] = compileBagExecutionCandidatesMock.mock.calls[0];
    expect(bagIntentArg.constraints).toBeUndefined();
    expect(bagIntentArg).toMatchObject({ wallet: session().walletAddress, chainId: 'ethereum', bagId: 'bag_1' });
    expect(graphArg.legs).toHaveLength(2);
  });

  it('annotates metrics using the real getPriceProvider() (never a client-supplied price), ranks the result, and SANITIZES each candidate before returning it (item 2 — never the raw compiled/calldata)', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    const candidateSet = { candidates: [{ id: 'lifi-composer' }], executionPlanHash: 'h1', compiledAt: 123 };
    compileBagExecutionCandidatesMock.mockResolvedValue(candidateSet);
    const fullCandidate = {
      id: 'lifi-composer',
      providerId: 'lifi-composer',
      compile: { status: 'COMPILED' as const },
      executionMode: 'SINGLE_TX' as const,
      metrics: { quotedOutputUsd: 99.5, quotedOutputBasis: 'SIMULATION' as const, minimumGuaranteedOutputUsd: null, estimatedGasUsd: null, estimatedDurationSeconds: null, requestedSlippageBps: 100 },
      executionPlanHash: 'h1',
      compiledAt: 123,
      // The one field that must NEVER survive into the HTTP response — see the assertions below.
      compiled: { mode: 'SINGLE_TX', chainId: 1, transactions: [{ to: '0xSECRET', data: '0xSHOULD_NOT_LEAK', value: '0', chainId: 1 }], expectedOutputs: [{ legId: 'leg_0', asset: { chain: 'ethereum', address: '0xA' }, quotedOutputRaw: '1', quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputRaw: null }], providerId: 'lifi-composer', executionPlanHash: 'h1', providerMetadata: { secretInternal: true } },
    };
    const ranked = { executable: [fullCandidate], failed: [], winners: [{ category: 'bestQuotedOutput', candidateId: 'lifi-composer', providerId: 'lifi-composer' }] };
    rankCandidatesMock.mockReturnValue(ranked);

    const outcome = await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(annotateCandidateMetricsMock).toHaveBeenCalledTimes(1);
    const [, annotateOptions] = annotateCandidateMetricsMock.mock.calls[0];
    expect(typeof annotateOptions.priceProvider.getPrice).toBe('function'); // the real module-scope getPriceProvider(), not a client value
    expect(rankCandidatesMock).toHaveBeenCalledTimes(1);
    expect(outcome.value.executionPlanHash).toBe('h1');
    expect(outcome.value.winners).toEqual(ranked.winners);

    // Sanitized: same id/providerId/compile/executionMode/metrics/hash/compiledAt survive...
    expect(outcome.value.candidates).toEqual([
      {
        id: 'lifi-composer',
        providerId: 'lifi-composer',
        compile: { status: 'COMPILED' },
        executionMode: 'SINGLE_TX',
        metrics: fullCandidate.metrics,
        executionPlanHash: 'h1',
        compiledAt: 123,
        swapLegCount: 1, // derived from compiled.expectedOutputs.length, not the raw array itself
      },
    ]);
    // ...but `compiled` itself — transactions/calldata/providerMetadata — is GONE.
    expect(JSON.stringify(outcome.value)).not.toContain('0xSHOULD_NOT_LEAK');
    expect(JSON.stringify(outcome.value)).not.toContain('secretInternal');
    expect((outcome.value.candidates[0] as unknown as { compiled?: unknown }).compiled).toBeUndefined();
  });

  it('a structural compiler failure (UNSATISFIABLE_CONSTRAINTS / invalid graph) is surfaced as QUOTE_FAILED, same convention as compileBagExecution throwing in createPurchaseIntentForUser', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionCandidatesMock.mockRejectedValue(new BagExecutionError('UNSATISFIABLE_CONSTRAINTS', 'no atomic-capable provider'));

    const outcome = await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('QUOTE_FAILED');
  });

  it('a non-BagExecutionError from the candidate compiler still propagates (never silently swallowed)', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    compileBagExecutionCandidatesMock.mockRejectedValue(new Error('unexpected bug'));

    await expect(
      getPurchaseOptionsForUser({ admin: {} as never, session: session(), bagId: 'bag_1', inputAssetId: 'asset_usdc', amount: '100' })
    ).rejects.toThrow('unexpected bug');
  });

  it('reuses the SAME registry/bag/version/allocation preparation as createPurchaseIntentForUser — fails BAG_NOT_FOUND the same way', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    getBagByIdMock.mockResolvedValue(null);

    const outcome = await getPurchaseOptionsForUser({
      admin: {} as never,
      session: session(),
      bagId: 'nonexistent',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('BAG_NOT_FOUND');
  });
});

// ----------------------------- 2. prepareExecution (idempotent) -----------------

describe('prepareExecution', () => {
  it('never re-executes an intent already past READY — returns the existing state unchanged', async () => {
    const submitted = intentFixture({ status: 'SUBMITTED' });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome).toEqual({ ok: true, value: submitted });
    expect(updatePurchaseIntentStatusMock).not.toHaveBeenCalled();
  });

  it('rejects an intent belonging to a different user', async () => {
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: false, error: 'FORBIDDEN' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome).toEqual({ ok: false, error: { kind: 'FORBIDDEN' } });
  });

  it('expires a READY intent past its expiry instead of executing it', async () => {
    const expiredIntent = intentFixture({ status: 'READY', expiresAt: new Date(Date.now() - 1000).toISOString() });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: expiredIntent });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...expiredIntent, status: 'EXPIRED' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome).toEqual({ ok: false, error: { kind: 'EXPIRED' } });
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'READY', to: 'EXPIRED' })
    );
  });

  it('fails a READY intent whose target assets no longer match the Bag current recipe (route changed)', async () => {
    const readyIntent = intentFixture({ status: 'READY' });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    // Current recipe now targets a DIFFERENT asset than what the intent was quoted for.
    getCurrentBagVersionMock.mockResolvedValue(
      bagVersion({
        recipe: {
          ...recipe(),
          assets: [{ chain: 'ethereum', address: '0x9999999999999999999999999999999999999999', symbol: 'xTSLA', decimals: 18, weightBps: 10000 }],
        },
      })
    );
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'FAILED' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ROUTE_CHANGED');
  });

  it('fails a READY intent reweighted between the SAME assets — a case the old "output asset set" check alone would have missed', async () => {
    const readyIntent = intentFixture({ status: 'READY' });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    // Same two assets (NVDA/AAPL), same compositionHash fixture value, but
    // reweighted 60/40 -> 50/50 — the Phase 17 check only compared the SET
    // of output asset addresses, which is unchanged here, so it would have
    // let this execute against a route the user never actually saw quoted.
    getCurrentBagVersionMock.mockResolvedValue(
      bagVersion({
        recipe: {
          ...recipe(),
          assets: [
            { chain: 'ethereum', address: NVDA_ADDRESS, symbol: 'NVDA', decimals: 18, weightBps: 5000 },
            { chain: 'ethereum', address: AAPL_ADDRESS, symbol: 'AAPL', decimals: 18, weightBps: 5000 },
          ],
        },
      })
    );
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'FAILED' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ROUTE_CHANGED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'FAILED', failureCode: 'ROUTE_EXPIRED' })
    );
  });

  it('fails a READY intent whose Bag composition changed (compositionHash mismatch) even before recomputing the full plan', async () => {
    const readyIntent = intentFixture({ status: 'READY' });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    getCurrentBagVersionMock.mockResolvedValue(bagVersion({ compositionHash: 'a-different-hash' }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'FAILED' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ROUTE_CHANGED');
  });

  it('advances a fresh READY intent all the way to AWAITING_SIGNATURE', async () => {
    const readyIntent = intentFixture({
      status: 'READY',
      steps: [swapStepRecord({ stepIndex: 0, targetSymbol: 'xNVDA', outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS } }), swapStepRecord({ stepIndex: 1, targetSymbol: 'xAAPL', outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS } })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'AWAITING_SIGNATURE' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('AWAITING_SIGNATURE');
  });
});

// ----------------------------- 2b. prepareExecution — executionPlanHash integrity ---

// Spec item 8: "executionPlanHash gerçek lifecycle'a bağlanmalı ... execute
// aşamasında yeniden hesaplanabilmeli. Mismatch: ayrı bir integrity error
// olarak ele alınmalı." — the execute-time half of
// supabase/migrations/0022_add_execution_plan_hash.sql.
describe('prepareExecution — executionPlanHash integrity (BAG_EXECUTION_COMPILER_ENABLED)', () => {
  it('an intent whose executionPlanHash still matches the freshly rebuilt graph advances normally', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    const readyIntent = intentFixture({
      status: 'READY',
      executionPlanHash: realExecutionPlanHash(),
      // Same convention the legacy "advances a fresh READY intent" test
      // above uses — the default fixture's single step doesn't match the
      // 2-asset `recipe()`, which the new targets-match invariant below
      // (correctly) treats as a real inconsistency, not something to wave
      // through silently.
      steps: [
        swapStepRecord({ stepIndex: 0, targetSymbol: 'xNVDA', outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS }, targetValueRaw: '60000000' }),
        swapStepRecord({ stepIndex: 1, targetSymbol: 'xAAPL', outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS }, targetValueRaw: '40000000' }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'AWAITING_SIGNATURE' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('AWAITING_SIGNATURE');
  });

  it('an intent whose executionPlanHash no longer matches the current graph fails with VERIFICATION_FAILED, distinct from a plain ROUTE_EXPIRED', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    const readyIntent = intentFixture({ status: 'READY', executionPlanHash: 'a-stale-hash-from-before-a-provider-bug-or-tamper' });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'FAILED' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ROUTE_CHANGED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'FAILED', failureCode: 'VERIFICATION_FAILED' })
    );
  });

  it('a legacy intent (executionPlanHash null) skips the check entirely, even with the flag on — never fails an intent this check was never meant to guard', async () => {
    process.env.BAG_EXECUTION_COMPILER_ENABLED = 'true';
    const readyIntent = intentFixture({ status: 'READY', executionPlanHash: null });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'AWAITING_SIGNATURE' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
  });

  it('flag off after creation: a non-null executionPlanHash is still verified, because the intent itself proves compiler provenance', async () => {
    delete process.env.BAG_EXECUTION_COMPILER_ENABLED;
    const readyIntent = intentFixture({ status: 'READY', executionPlanHash: 'this-would-fail-the-check-if-it-ran' });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: readyIntent });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...readyIntent, status: 'FAILED' });

    const outcome = await prepareExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ROUTE_CHANGED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'FAILED', failureCode: 'VERIFICATION_FAILED' })
    );
  });
});

// ----------------------------- 3. recordStepEvent -------------------------------

describe('recordStepEvent', () => {
  const VALID_TX = `0x${'ab'.repeat(32)}`;

  it('rejects a malformed txHash', async () => {
    const awaiting = intentFixture({ status: 'AWAITING_SIGNATURE', steps: [swapStepRecord({ status: 'AWAITING_SIGNATURE' })] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: awaiting });

    const outcome = await recordStepEvent({} as never, session(), 'intent_1', 0, { type: 'SUBMITTED', txHash: 'not-a-hash' });

    expect(outcome).toEqual({ ok: false, error: { kind: 'INVALID_TX_HASH' } });
    expect(updatePurchaseIntentStepsMock).not.toHaveBeenCalled();
  });

  it('records a submitted step WITHOUT claiming the hash — a reported hash is not trusted until it verifies', async () => {
    const awaiting = intentFixture({ status: 'AWAITING_SIGNATURE', steps: [swapStepRecord({ status: 'AWAITING_SIGNATURE' })] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: awaiting });
    updatePurchaseIntentStepsMock.mockResolvedValue({ ...awaiting, steps: [swapStepRecord({ status: 'SUBMITTED', txHash: VALID_TX })] });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...awaiting, status: 'SUBMITTED' });
    const rpc = vi.fn();

    const outcome = await recordStepEvent({ rpc } as never, session(), 'intent_1', 0, { type: 'SUBMITTED', txHash: VALID_TX });

    expect(outcome.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalledWith('claim_intent_tx_hash', expect.anything());
  });

  it('fails the WHOLE intent when the user rejects a step in their wallet', async () => {
    const awaiting = intentFixture({ status: 'AWAITING_SIGNATURE', steps: [swapStepRecord({ status: 'AWAITING_SIGNATURE' })] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: awaiting });
    updatePurchaseIntentStepsMock.mockResolvedValue({ ...awaiting, steps: [swapStepRecord({ status: 'FAILED', failureCode: 'USER_REJECTED' })] });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...awaiting, status: 'FAILED', failureCode: 'USER_REJECTED' });

    const outcome = await recordStepEvent({} as never, session(), 'intent_1', 0, { type: 'REJECTED', failureCode: 'USER_REJECTED' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('FAILED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'FAILED' }));
  });

  it('can never mark a step (or the intent) COMPLETED from a client report', async () => {
    const awaiting = intentFixture({ status: 'AWAITING_SIGNATURE', steps: [swapStepRecord({ status: 'AWAITING_SIGNATURE' })] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: awaiting });

    // @ts-expect-error — 'COMPLETED' is intentionally not a member of StepReportEvent['type'].
    const outcome = await recordStepEvent({} as never, session(), 'intent_1', 0, { type: 'COMPLETED' });

    expect(outcome.ok).toBe(false);
  });

  it('Phase 18: does NOT immediately fail the whole intent when a DIFFERENT step already has a real transaction submitted — defers to verifyExecution reconciliation', async () => {
    // Step 0 already submitted on-chain (has a txHash); step 1 is the one
    // whose signature the user is now rejecting.
    const submittedStep = swapStepRecord({ stepIndex: 0, targetSymbol: 'xNVDA', outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS }, status: 'SUBMITTED', txHash: '0xalreadysubmitted' });
    const awaitingStep = swapStepRecord({ stepIndex: 1, targetSymbol: 'xAAPL', outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS }, status: 'AWAITING_SIGNATURE' });
    const intent = intentFixture({ status: 'SUBMITTED', steps: [submittedStep, awaitingStep] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    updatePurchaseIntentStepsMock.mockResolvedValue({
      ...intent,
      steps: [submittedStep, { ...awaitingStep, status: 'FAILED', failureCode: 'USER_REJECTED' }],
    });

    const outcome = await recordStepEvent({} as never, session(), 'intent_1', 1, { type: 'REJECTED', failureCode: 'USER_REJECTED' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Never finalized to FAILED here — step 0's already-submitted
    // transaction still needs to be polled/reconciled.
    expect(outcome.value.status).not.toBe('FAILED');
    expect(updatePurchaseIntentStatusMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'FAILED' }));
  });
});

// ----------------------------- 4. verifyExecution (idempotent) ------------------

describe('verifyExecution', () => {
  it('is a no-op for an already-terminal intent', async () => {
    const completed = intentFixture({ status: 'COMPLETED', accountingAppliedAt: new Date().toISOString() });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: completed });

    const outcome = await verifyExecution({} as never, session(), 'intent_1');

    expect(outcome).toEqual({ ok: true, value: completed });
    expect(trackStepStatusMock).not.toHaveBeenCalled();
  });

  it('marks a step FAILED when the received asset does not match the registry-verified expected asset', async () => {
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: '0xabc' })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({
      kind: 'DONE',
      receivedAsset: { chain: 'ethereum', address: '0xWRONGASSET' },
      receivedAmountRaw: '123',
      matchesExpectedAsset: false,
    });
    updatePurchaseIntentStepsMock.mockImplementation(async (_admin: unknown, _id: string, _status: string, steps: PurchaseIntentStepRecord[]) => ({
      ...submitted,
      steps,
    }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });

    const outcome = await verifyExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('FAILED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'FAILED', failureCode: 'VERIFICATION_FAILED' })
    );
  });

  it('applies accounting exactly once, then marks the intent COMPLETED', async () => {
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: '0xabc' })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({
      kind: 'DONE',
      receivedAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
      receivedAmountRaw: '9950000000000000000',
      matchesExpectedAsset: true,
    });

    const completedSteps = [swapStepRecord({ status: 'COMPLETED', txHash: '0xabc', outputAmountRaw: '9950000000000000000' })];
    updatePurchaseIntentStepsMock.mockResolvedValue({ ...submitted, steps: completedSteps });
    updatePurchaseIntentStatusMock.mockResolvedValue({
      ...submitted,
      steps: completedSteps,
      status: 'COMPLETED',
      executedAt: new Date().toISOString(),
    });

    const rpcMock = rpcGrantingClaims();
    const admin = { rpc: rpcMock } as never;

    const outcome = await verifyExecution(admin, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('COMPLETED');
    expect(rpcMock).toHaveBeenCalledWith(
      'apply_purchase_execution',
      expect.objectContaining({
        p_intent_id: submitted.id,
        p_bag_id: submitted.bagId,
        p_shares_delta_raw: submitted.sharesRaw,
        p_user_id: submitted.userId,
        p_cost_basis_delta: submitted.depositAmount,
      })
    );
    // Credits the ACTUAL received amount, not the pre-execution estimate.
    expect(applyCall(rpcMock).p_holdings).toEqual(
      expect.arrayContaining([expect.objectContaining({ delta_raw: '9950000000000000000' })])
    );
    expect(markAccountingAppliedMock).toHaveBeenCalledWith(expect.anything(), submitted.id);
  });

  it('never mints shares for a completed SWAP step that has no decimals — accounting is refused, not applied without holdings', async () => {
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: '0xabc' })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({
      kind: 'DONE',
      receivedAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
      receivedAmountRaw: '9950000000000000000',
      matchesExpectedAsset: true,
    });
    const completedSteps = [
      swapStepRecord({ status: 'COMPLETED', txHash: '0xabc', outputAmountRaw: '9950000000000000000', outputDecimals: null }),
    ];
    updatePurchaseIntentStepsMock.mockResolvedValue({ ...submitted, steps: completedSteps });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, steps: completedSteps, status: 'COMPLETED' });
    const rpcMock = rpcGrantingClaims();

    await expect(verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1')).rejects.toThrow(/lack output amount\/decimals/);
    expect(rpcMock).not.toHaveBeenCalledWith('apply_purchase_execution', expect.anything());
    expect(markAccountingAppliedMock).not.toHaveBeenCalled();
  });

  it('claims the tx hash only after the step verifies, and fails the step when another intent already owns the hash', async () => {
    const VALID_TX = `0x${'ab'.repeat(32)}`;
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: VALID_TX })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({
      kind: 'DONE',
      receivedAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
      receivedAmountRaw: '9950000000000000000',
      matchesExpectedAsset: true,
    });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _st: string, steps: PurchaseIntentStepRecord[]) => ({
      ...submitted,
      steps,
    }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    const rpcMock = vi.fn(async () => ({ data: false, error: null }));

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('claim_intent_tx_hash', expect.objectContaining({ p_tx_hash: VALID_TX, p_intent_id: 'intent_1' }));
    const persisted = updatePurchaseIntentStepsMock.mock.calls[0][3] as PurchaseIntentStepRecord[];
    expect(persisted[0]).toMatchObject({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    expect(rpcMock).not.toHaveBeenCalledWith('apply_purchase_execution', expect.anything());
  });

  it('never claims a hash that fails verification — a front-runner reporting a victim\'s hash cannot lock it', async () => {
    const VALID_TX = `0x${'ab'.repeat(32)}`;
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: VALID_TX })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _st: string, steps: PurchaseIntentStepRecord[]) => ({
      ...submitted,
      steps,
    }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    const rpcMock = vi.fn();

    await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(rpcMock).not.toHaveBeenCalledWith('claim_intent_tx_hash', expect.anything());
  });

  // ----------------------------- Fork royalty -------------------------
  // A fork's root creator is paid on-chain from the fork's performance fee, at each sale (RedeemSettlement,
  // FORK_ROYALTY_FEE_SHARE_BPS). A purchase accrues nothing: no royalty rate, no recipient, for forks too.

  it('a fork bag accrues no deposit royalty: zero rate and no recipient, and the root bag is not looked up', async () => {
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: '0xabc' })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({
      kind: 'DONE',
      receivedAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
      receivedAmountRaw: '9950000000000000000',
      matchesExpectedAsset: true,
    });
    updatePurchaseIntentStepsMock.mockResolvedValue({
      ...submitted,
      steps: [swapStepRecord({ status: 'COMPLETED', txHash: '0xabc', outputAmountRaw: '9950000000000000000' })],
    });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, status: 'COMPLETED', executedAt: new Date().toISOString() });

    // This bag (bag_1) is a fork of bag_0, created by someone other than bag_0's creator.
    getBagByIdMock.mockImplementation(async (_admin: unknown, id: string) => {
      if (id === 'bag_1') return { ...bagRecord(), id: 'bag_1', creatorId: 'forker_1', rootBagId: 'bag_0' };
      if (id === 'bag_0') return { ...bagRecord(), id: 'bag_0', creatorId: 'original_creator', rootBagId: null };
      return null;
    });

    const rpcMock = rpcGrantingClaims();
    const admin = { rpc: rpcMock } as never;

    await verifyExecution(admin, session(), 'intent_1');

    expect(rpcMock).toHaveBeenCalledWith(
      'apply_purchase_execution',
      expect.objectContaining({
        p_fork_royalty_bps: 0,
        p_root_creator_id: null,
      })
    );
    expect(getBagByIdMock).not.toHaveBeenCalledWith(expect.anything(), 'bag_0');
  });

  it('passes zero royalty and no recipient for a non-fork bag (root_bag_id is null)', async () => {
    // beforeEach already stubs getBagByIdMock to bagRecord() (rootBagId: null).
    const submitted = intentFixture({
      status: 'SUBMITTED',
      steps: [swapStepRecord({ status: 'SUBMITTED', txHash: '0xabc' })],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    trackStepStatusMock.mockResolvedValue({
      kind: 'DONE',
      receivedAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
      receivedAmountRaw: '9950000000000000000',
      matchesExpectedAsset: true,
    });
    updatePurchaseIntentStepsMock.mockResolvedValue({
      ...submitted,
      steps: [swapStepRecord({ status: 'COMPLETED', txHash: '0xabc', outputAmountRaw: '9950000000000000000' })],
    });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, status: 'COMPLETED', executedAt: new Date().toISOString() });

    const rpcMock = rpcGrantingClaims();
    const admin = { rpc: rpcMock } as never;

    await verifyExecution(admin, session(), 'intent_1');

    expect(rpcMock).toHaveBeenCalledWith(
      'apply_purchase_execution',
      expect.objectContaining({
        p_fork_royalty_bps: 0,
        p_root_creator_id: null,
      })
    );
  });

  it('never finalizes the intent while one step failed but ANOTHER step is still pending/confirming — waits for both to reach a terminal state', async () => {
    const failedStep = swapStepRecord({ stepIndex: 0, targetSymbol: 'xNVDA', outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS }, status: 'FAILED', failureCode: 'SLIPPAGE_EXCEEDED', txHash: '0xfailed' });
    const pendingStep = swapStepRecord({ stepIndex: 1, targetSymbol: 'xAAPL', outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS }, status: 'SUBMITTED', txHash: '0xpending' });
    const submitted = intentFixture({ status: 'CONFIRMING', steps: [failedStep, pendingStep] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    // Only the still-pending step gets polled (the failed one is already terminal and skipped).
    trackStepStatusMock.mockResolvedValue({ kind: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION' });
    updatePurchaseIntentStepsMock.mockResolvedValue({
      ...submitted,
      steps: [failedStep, { ...pendingStep, status: 'CONFIRMING', providerSubstatus: 'WAIT_DESTINATION_TRANSACTION' }],
    });

    const outcome = await verifyExecution({} as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Must NOT be finalized to FAILED, PARTIAL_SUCCESS, or anything else —
    // step 1 could still complete on-chain.
    expect(updatePurchaseIntentStatusMock).not.toHaveBeenCalled();
    expect(outcome.value.status).toBe('CONFIRMING');
  });

  it('moves to PARTIAL_SUCCESS -> RECONCILIATION_REQUIRED when one step verifiably completes and a sibling genuinely fails — credits ONLY the verified holdings and mints shares only for the part that executed', async () => {
    const completedStep = swapStepRecord({ stepIndex: 0, targetSymbol: 'xNVDA', outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS }, status: 'COMPLETED', txHash: '0xdone', outputAmountRaw: '9950000000000000000' });
    const failedStep = swapStepRecord({ stepIndex: 1, targetSymbol: 'xAAPL', outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS }, status: 'FAILED', failureCode: 'SLIPPAGE_EXCEEDED', txHash: '0xfailed' });
    const submitted = intentFixture({ status: 'CONFIRMING', steps: [completedStep, failedStep] });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    // Both steps already terminal (COMPLETED/FAILED) — nothing left to poll.

    const partial = { ...submitted, status: 'PARTIAL_SUCCESS' as const };
    const reconciled = { ...submitted, status: 'RECONCILIATION_REQUIRED' as const, reconciliationAppliedAt: new Date().toISOString() };
    updatePurchaseIntentStatusMock
      .mockResolvedValueOnce(partial) // SUBMITTED/CONFIRMING -> PARTIAL_SUCCESS
      .mockResolvedValueOnce(reconciled); // PARTIAL_SUCCESS -> RECONCILIATION_REQUIRED

    const rpcMock = rpcGrantingClaims();
    const admin = { rpc: rpcMock } as never;

    const outcome = await verifyExecution(admin, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('RECONCILIATION_REQUIRED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ to: 'PARTIAL_SUCCESS' }));
    expect(updatePurchaseIntentStatusMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ from: 'PARTIAL_SUCCESS', to: 'RECONCILIATION_REQUIRED' }));

    // Credits the verified-COMPLETED step's holdings...
    expect(rpcMock).toHaveBeenCalledWith(
      'apply_partial_purchase_execution',
      expect.objectContaining({
        p_intent_id: submitted.id,
        p_bag_id: submitted.bagId,
        p_user_id: submitted.userId,
      })
    );
    expect(applyCall(rpcMock).p_holdings).toEqual([
      expect.objectContaining({ chain: 'ethereum', address: NVDA_ADDRESS, delta_raw: '9950000000000000000' }),
    ]);
    // ...mints shares and cost basis pro rata to the input actually spent
    // (the completed leg's 60 of 100 USDC), through the partial RPC — never
    // the full apply_purchase_execution.
    expect(applyCall(rpcMock)).toMatchObject({
      p_shares_delta_raw: '60000000000000000000',
      p_share_decimals: 18,
      p_cost_basis_delta: '600',
    });
    expect(rpcMock).not.toHaveBeenCalledWith('apply_purchase_execution', expect.anything());
    expect(markReconciliationAppliedMock).toHaveBeenCalledWith(expect.anything(), submitted.id);
    expect(markAccountingAppliedMock).not.toHaveBeenCalled();
  });

  it('reconciliation is idempotent — a second verifyExecution call on an already-RECONCILIATION_REQUIRED intent never re-credits holdings', async () => {
    const reconciled = intentFixture({
      status: 'RECONCILIATION_REQUIRED',
      reconciliationAppliedAt: new Date().toISOString(),
      steps: [
        swapStepRecord({ stepIndex: 0, status: 'COMPLETED', outputAmountRaw: '9950000000000000000' }),
        swapStepRecord({ stepIndex: 1, status: 'FAILED', failureCode: 'SLIPPAGE_EXCEEDED' }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: reconciled });

    const outcome = await verifyExecution({} as never, session(), 'intent_1');

    expect(outcome).toEqual({ ok: true, value: reconciled });
    expect(trackStepStatusMock).not.toHaveBeenCalled();
    expect(updatePurchaseIntentStatusMock).not.toHaveBeenCalled();
  });

  it('retrying from PARTIAL_SUCCESS (previous reconciliation attempt did not finish) resumes without double-crediting', async () => {
    // reconciliationAppliedAt already set by a PRIOR call whose RPC
    // succeeded but crashed before the PARTIAL_SUCCESS -> RECONCILIATION_REQUIRED
    // status write landed.
    const stuckPartial = intentFixture({
      status: 'PARTIAL_SUCCESS',
      reconciliationAppliedAt: new Date().toISOString(),
      steps: [
        swapStepRecord({ stepIndex: 0, status: 'COMPLETED', outputAmountRaw: '9950000000000000000' }),
        swapStepRecord({ stepIndex: 1, status: 'FAILED', failureCode: 'SLIPPAGE_EXCEEDED' }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: stuckPartial });
    const reconciled = { ...stuckPartial, status: 'RECONCILIATION_REQUIRED' as const };
    updatePurchaseIntentStatusMock.mockResolvedValue(reconciled);
    const rpcMock = vi.fn();
    const admin = { rpc: rpcMock } as never;

    const outcome = await verifyExecution(admin, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('RECONCILIATION_REQUIRED');
    // reconciliationAppliedAt was already set -> the RPC must NOT be called again.
    expect(rpcMock).not.toHaveBeenCalled();
    expect(markReconciliationAppliedMock).not.toHaveBeenCalled();
  });

  it('never advances to RECONCILIATION_REQUIRED if the partial-credit RPC itself reports an error', async () => {
    const submitted = intentFixture({
      status: 'CONFIRMING',
      steps: [
        swapStepRecord({ stepIndex: 0, status: 'COMPLETED', outputAmountRaw: '9950000000000000000' }),
        swapStepRecord({ stepIndex: 1, status: 'FAILED', failureCode: 'SLIPPAGE_EXCEEDED' }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: submitted });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...submitted, status: 'PARTIAL_SUCCESS' });
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: { message: 'db unavailable' } });
    const admin = { rpc: rpcMock } as never;

    await expect(verifyExecution(admin, session(), 'intent_1')).rejects.toThrow('apply_partial_purchase_execution failed');
    expect(markReconciliationAppliedMock).not.toHaveBeenCalled();
  });
});

// ----------------------------- verifyExecution — Bag Router execution hardening ---
//
// Covers the hardening spec's test list (item 6) for the SERVER-side
// verification path: `trackBagRouterTransaction()` (lib/blockchain/
// bag-router-status.ts) is mocked here — its OWN decoding/matching logic
// has its own dedicated unit tests (lib/blockchain/__tests__/
// bag-router-status.test.ts). These tests instead prove `verifyExecution()`
// wires that outcome into steps/accounting correctly, and never through
// `trackComposerTransaction`/`trackStepStatus`.
describe('verifyExecution — Bag Router execution hardening', () => {
  const ROUTER_ADDRESS = '0xBagRouterAddress';
  const BAG_ROUTER_TX = {
    to: ROUTER_ADDRESS,
    data: '0xexecutecalldata',
    value: '0',
    chainId: 4663,
    inputToken: USDC.address,
    inputAmountRaw: '100000000',
    bagOnChainId: '0xOnChainBagId1',
  };

  /** A single-swap-step BAG Router intent — kept to one leg for the failure-mode tests below so a rejected leg can never trigger the separate PARTIAL_SUCCESS/mixed-outcome machinery (already covered by the sequential/Composer tests above); the "every expected asset" test further down uses two legs instead. */
  function singleLegBagRouterIntent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
    return intentFixture({
      providerId: 'bag-router',
      executionPlanHash: 'plan-hash-router',
      bagRouterTransaction: BAG_ROUTER_TX,
      status: 'SUBMITTED',
      steps: [
        swapStepRecord({
          stepIndex: 0,
          status: 'SUBMITTED',
          txHash: '0xroutertx',
          outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
          outputAmountRaw: '9950000000000000000',
          outputDecimals: 18,
          minOutputRaw: '9950000000000000000',
          route: null,
          lifiStep: null,
        }),
      ],
      ...overrides,
    });
  }

  it('routes through trackBagRouterTransaction ONLY — never trackComposerTransaction/trackStepStatus (item 2: BagRouter never enters Composer/sequential verification)', async () => {
    const intent = singleLegBagRouterIntent();
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    trackBagRouterTransactionMock.mockResolvedValue({
      kind: 'DONE',
      receivedAmountsByAddress: { [NVDA_ADDRESS.toLowerCase()]: '9960000000000000000' },
    });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _status: string, steps: PurchaseIntentStepRecord[]) => ({ ...intent, steps }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...intent, status: 'COMPLETED', executedAt: new Date().toISOString() });
    const rpcMock = rpcGrantingClaims();

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    expect(trackBagRouterTransactionMock).toHaveBeenCalledTimes(1);
    expect(trackStepStatusMock).not.toHaveBeenCalled();
    // Passes the exact plan-identity fields bag-router-status.ts checks —
    // never merely "some transaction happened".
    expect(trackBagRouterTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ routerAddress: ROUTER_ADDRESS, recipient: intent.walletAddress })
    );
    const call = trackBagRouterTransactionMock.mock.calls[0][0];
    expect(call.expectedBagId).toBe('0xOnChainBagId1');
    expect(call.expectedExecutionPlanHash).toBe('plan-hash-router');
    expect(call.expectedInputToken).toBe(USDC.address);
    expect(call.expectedInputAmountRaw).toBe('100000000');
    expect(call.expectedLegCount).toBe(1);
    expect(call.expectedOutputTokens).toEqual([NVDA_ADDRESS]);
  });

  it('successful verification credits the ACTUAL on-chain-received amount (not the pre-execution quote) and completes (item 10: every expected asset accounted correctly)', async () => {
    const intent = intentFixture({
      providerId: 'bag-router',
      executionPlanHash: 'plan-hash-router',
      bagRouterTransaction: BAG_ROUTER_TX,
      status: 'SUBMITTED',
      steps: [
        swapStepRecord({
          stepIndex: 0,
          status: 'SUBMITTED',
          txHash: '0xroutertx',
          targetSymbol: 'xNVDA',
          outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
          outputAmountRaw: '9950000000000000000',
          outputDecimals: 18,
          minOutputRaw: '9950000000000000000',
          route: null,
          lifiStep: null,
        }),
        swapStepRecord({
          stepIndex: 1,
          status: 'SUBMITTED',
          txHash: '0xroutertx',
          targetSymbol: 'xAAPL',
          outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS },
          outputAmountRaw: '3950000000000000000',
          outputDecimals: 18,
          minOutputRaw: '3950000000000000000',
          route: null,
          lifiStep: null,
        }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    trackBagRouterTransactionMock.mockResolvedValue({
      kind: 'DONE',
      receivedAmountsByAddress: {
        [NVDA_ADDRESS.toLowerCase()]: '9961000000000000000',
        [AAPL_ADDRESS.toLowerCase()]: '3961000000000000000',
      },
    });
    statefulIntentRow(intent);
    const rpcMock = rpcGrantingClaims();

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('COMPLETED');
    // SUBMITTED -> CONFIRMING -> COMPLETED: the tx had landed by the first verify.
    expect(updatePurchaseIntentStatusMock.mock.calls.map((c) => [(c[1] as { from: string }).from, (c[1] as { to: string }).to])).toEqual([
      ['SUBMITTED', 'CONFIRMING'],
      ['CONFIRMING', 'COMPLETED'],
    ]);
    expect(rpcMock).toHaveBeenCalledWith(
      'apply_purchase_execution',
      expect.objectContaining({ p_intent_id: intent.id })
    );
    const holdings = applyCall(rpcMock).p_holdings;
    expect(holdings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: NVDA_ADDRESS, delta_raw: '9961000000000000000', decimals: 18 }),
        expect.objectContaining({ address: AAPL_ADDRESS, delta_raw: '3961000000000000000', decimals: 18 }),
      ])
    );
    expect(markAccountingAppliedMock).toHaveBeenCalledWith(expect.anything(), intent.id);
  });

  it('a leg whose own txHash was never recorded (lost parallel report) is still verified by the shared transaction and completes', async () => {
    const intent = intentFixture({
      providerId: 'bag-router',
      executionPlanHash: 'plan-hash-router',
      bagRouterTransaction: BAG_ROUTER_TX,
      status: 'SUBMITTED',
      steps: [
        swapStepRecord({
          stepIndex: 0,
          status: 'SUBMITTED',
          txHash: '0xroutertx',
          targetSymbol: 'xNVDA',
          outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
          outputAmountRaw: '9950000000000000000',
          outputDecimals: 18,
          minOutputRaw: '9950000000000000000',
          route: null,
          lifiStep: null,
        }),
        swapStepRecord({
          stepIndex: 1,
          status: 'AWAITING_SIGNATURE',
          txHash: null,
          targetSymbol: 'xAAPL',
          outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS },
          outputAmountRaw: '3950000000000000000',
          outputDecimals: 18,
          minOutputRaw: '3950000000000000000',
          route: null,
          lifiStep: null,
        }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    trackBagRouterTransactionMock.mockResolvedValue({
      kind: 'DONE',
      receivedAmountsByAddress: {
        [NVDA_ADDRESS.toLowerCase()]: '9961000000000000000',
        [AAPL_ADDRESS.toLowerCase()]: '3961000000000000000',
      },
    });
    statefulIntentRow(intent);
    const rpcMock = rpcGrantingClaims();

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('COMPLETED');
    const persisted = updatePurchaseIntentStepsMock.mock.calls[0][3] as PurchaseIntentStepRecord[];
    expect(persisted.map((st) => [st.status, st.txHash])).toEqual([
      ['COMPLETED', '0xroutertx'],
      ['COMPLETED', '0xroutertx'],
    ]);
    expect(applyCall(rpcMock).p_holdings).toEqual(
      expect.arrayContaining([expect.objectContaining({ address: AAPL_ADDRESS, delta_raw: '3961000000000000000' })])
    );
  });

  it('wrong output — the recipient never actually received the expected asset — fails verification (item 6: never silently accepted)', async () => {
    const intent = singleLegBagRouterIntent();
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    // DONE, but no Transfer log at all for NVDA — some other asset (or
    // nothing) reached the wallet.
    trackBagRouterTransactionMock.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: {} });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _status: string, steps: PurchaseIntentStepRecord[]) => ({ ...intent, steps }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...intent, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    const rpcMock = vi.fn();

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('FAILED');
    expect(updatePurchaseIntentStepsMock).toHaveBeenCalledWith(
      expect.anything(),
      'intent_1',
      'SUBMITTED',
      expect.arrayContaining([expect.objectContaining({ status: 'FAILED', failureCode: 'VERIFICATION_FAILED' })])
    );
    expect(rpcMock).not.toHaveBeenCalledWith('apply_purchase_execution', expect.anything());
    expect(markAccountingAppliedMock).not.toHaveBeenCalled();
  });

  it('output below minOutputRaw fails verification even though the on-chain transaction itself succeeded (item 7: defense-in-depth re-check against the persisted enforced minimum)', async () => {
    const intent = singleLegBagRouterIntent();
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    // The router's own on-chain InsufficientOutput check would normally
    // have reverted this — mocked here as DONE-but-short to prove
    // verifyExecution() ALSO checks it independently, not merely trusting
    // "the transaction succeeded" as sufficient.
    trackBagRouterTransactionMock.mockResolvedValue({
      kind: 'DONE',
      receivedAmountsByAddress: { [NVDA_ADDRESS.toLowerCase()]: '1000000000000000000' }, // < minOutputRaw 9950000000000000000
    });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _status: string, steps: PurchaseIntentStepRecord[]) => ({ ...intent, steps }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...intent, status: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    const rpcMock = vi.fn();

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('FAILED');
    expect(rpcMock).not.toHaveBeenCalledWith('apply_purchase_execution', expect.anything());
    expect(markAccountingAppliedMock).not.toHaveBeenCalled();
  });

  it('a reverted BAG Router transaction never produces normal successful accounting (item 8)', async () => {
    const intent = singleLegBagRouterIntent();
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    trackBagRouterTransactionMock.mockResolvedValue({
      kind: 'FAILED',
      failureCode: 'TRANSACTION_REVERTED',
      message: 'The BAG Router transaction reverted on-chain.',
    });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, _status: string, steps: PurchaseIntentStepRecord[]) => ({ ...intent, steps }));
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...intent, status: 'FAILED', failureCode: 'TRANSACTION_REVERTED' });
    const rpcMock = vi.fn();

    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('FAILED');
    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'FAILED', failureCode: 'TRANSACTION_REVERTED' })
    );
    expect(rpcMock).not.toHaveBeenCalled();
    expect(markAccountingAppliedMock).not.toHaveBeenCalled();
  });

  it('repeated verification never double-credits — a second call on an already-COMPLETED BagRouter intent is a pure no-op (item 9)', async () => {
    const completed = singleLegBagRouterIntent({
      status: 'COMPLETED',
      accountingAppliedAt: new Date().toISOString(),
      steps: [
        swapStepRecord({
          stepIndex: 0,
          status: 'COMPLETED',
          txHash: '0xroutertx',
          outputAsset: { chain: 'ethereum', address: NVDA_ADDRESS },
          outputAmountRaw: '9961000000000000000',
          outputDecimals: 18,
          minOutputRaw: '9950000000000000000',
        }),
      ],
    });
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: completed });

    const outcome = await verifyExecution({} as never, session(), 'intent_1');

    expect(outcome).toEqual({ ok: true, value: completed });
    // Already-terminal short-circuit (same guard every other provider path
    // uses) — never re-fetches the receipt, never re-applies accounting.
    expect(trackBagRouterTransactionMock).not.toHaveBeenCalled();
    expect(updatePurchaseIntentStatusMock).not.toHaveBeenCalled();
    expect(markAccountingAppliedMock).not.toHaveBeenCalled();
  });
});

// ----------------------------- unroutable-asset policy --------------------------

describe('createPurchaseIntentForUser / prepareExecution — unroutable-asset policy', () => {
  const aaplNoRoute = async (asset: { address: string }) => (asset.address === AAPL_ADDRESS ? 'NO_ROUTE' : 'ROUTABLE');
  const withPolicy = (policy: BasketRecipe['unroutablePolicy'], weights: [number, number] = [6000, 4000]) =>
    bagVersion({
      recipe: {
        ...recipe(),
        unroutablePolicy: policy,
        assets: [
          { chain: 'ethereum', address: NVDA_ADDRESS, symbol: 'NVDA', decimals: 18, weightBps: weights[0] },
          { chain: 'ethereum', address: AAPL_ADDRESS, symbol: 'AAPL', decimals: 18, weightBps: weights[1] },
        ],
      },
    });
  const create = () =>
    createPurchaseIntentForUser({ admin: {} as never, session: session(), bagId: 'bag_1', inputAssetId: 'asset_usdc', amount: '100' });
  const quotedAll = () => buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [swapStepRecord()], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });
  const stepsPassedToQuote = () => buildPurchaseIntentStepsMock.mock.calls[0][0] as Array<{ action: string; targetSymbol: string; route: { inputAmountRaw: string } }>;
  const createdInput = () => createPurchaseIntentMock.mock.calls[0][1] as Record<string, unknown> & PurchaseIntent;

  it('BLOCK (the default) never probes routes — the real quote decides, exactly as before', async () => {
    quotedAll();
    await create();
    expect(checkAssetRouteMock).not.toHaveBeenCalled();
    expect(createdInput().fallback).toBeNull();
  });

  it('HOLD_INPUT: the unroutable leg becomes a KEEP of the payment token; full amount spent, fallback recorded', async () => {
    getCurrentBagVersionMock.mockResolvedValue(withPolicy('HOLD_INPUT', [7500, 2500]));
    checkAssetRouteMock.mockImplementation(aaplNoRoute);
    quotedAll();

    const outcome = await create();
    expect(outcome.ok).toBe(true);
    expect(stepsPassedToQuote().map((st) => [st.action, st.targetSymbol, st.route.inputAmountRaw])).toEqual([
      ['SWAP', 'NVDA', '75000000'],
      ['KEEP', 'USDC', '25000000'],
    ]);
    expect(createdInput()).toMatchObject({
      inputAmountRaw: '100000000',
      fallback: { policy: 'HOLD_INPUT', unroutableWeightBps: 2500, amountScaleBps: 10000, requestedAmountRaw: '100000000', assets: [{ symbol: 'AAPL' }] },
    });
  });

  it('REFUND: the unroutable leg is left out and only the routable share is spent and credited', async () => {
    getCurrentBagVersionMock.mockResolvedValue(withPolicy('REFUND', [7500, 2500]));
    checkAssetRouteMock.mockImplementation(aaplNoRoute);
    quotedAll();

    const outcome = await create();
    expect(outcome.ok).toBe(true);
    expect(stepsPassedToQuote().map((st) => [st.action, st.targetSymbol, st.route.inputAmountRaw])).toEqual([['SWAP', 'NVDA', '75000000']]);
    expect(createdInput()).toMatchObject({
      inputAmountRaw: '75000000',
      depositAmount: '75',
      fallback: { policy: 'REFUND', amountScaleBps: 7500, requestedAmountRaw: '100000000' },
    });
  });

  it('refuses with ASSETS_UNROUTABLE when more than the cap is unroutable', async () => {
    getCurrentBagVersionMock.mockResolvedValue(withPolicy('HOLD_INPUT', [6000, 4000]));
    checkAssetRouteMock.mockImplementation(aaplNoRoute);

    expect(await create()).toEqual({ ok: false, error: { kind: 'ASSETS_UNROUTABLE', reason: 'TOO_MUCH_UNROUTABLE', symbols: ['AAPL'] } });
    expect(createPurchaseIntentMock).not.toHaveBeenCalled();
  });

  for (const policy of ['HOLD_INPUT', 'REFUND'] as const) {
    it(`${policy}: prepareExecution re-derives the same plan from the stored fallback and proceeds`, async () => {
      getCurrentBagVersionMock.mockResolvedValue(withPolicy(policy, [7500, 2500]));
      checkAssetRouteMock.mockImplementation(aaplNoRoute);
      quotedAll();
      await create();
      const stored = { ...intentFixture(), ...createdInput(), status: 'READY' as const };

      getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: stored });
      updatePurchaseIntentStatusMock.mockImplementation(async (_a: unknown, u: { to: string }) => ({ ...stored, status: u.to }));

      const outcome = await prepareExecution({} as never, session(), 'intent_1');
      expect(outcome).toMatchObject({ ok: true, value: { status: 'AWAITING_SIGNATURE' } });
    });
  }

  it('prepareExecution fails with ROUTE_CHANGED if the creator changed the policy since the quote', async () => {
    getCurrentBagVersionMock.mockResolvedValue(withPolicy('REFUND', [7500, 2500]));
    checkAssetRouteMock.mockImplementation(aaplNoRoute);
    quotedAll();
    await create();
    const stored = { ...intentFixture(), ...createdInput(), status: 'READY' as const };

    getCurrentBagVersionMock.mockResolvedValue(withPolicy('HOLD_INPUT', [7500, 2500]));
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: stored });
    updatePurchaseIntentStatusMock.mockResolvedValue({ ...stored, status: 'FAILED' });

    expect(await prepareExecution({} as never, session(), 'intent_1')).toEqual({ ok: false, error: { kind: 'ROUTE_CHANGED' } });
  });
});

// ----------------------------- stale open intents ------------------------------

describe('createPurchaseIntentForUser — an earlier open intent no longer blocks forever', () => {
  const create = () =>
    createPurchaseIntentForUser({ admin: {} as never, session: session(), bagId: 'bag_1', inputAssetId: 'asset_usdc', amount: '100' });

  it('cancels an earlier intent that never had a transaction sent, then creates the new one', async () => {
    findActivePurchaseIntentForBagMock.mockResolvedValue(intentFixture({ id: 'abandoned', status: 'AWAITING_SIGNATURE' }));
    updatePurchaseIntentStatusMock.mockResolvedValue(intentFixture({ id: 'abandoned', status: 'CANCELLED' }));
    buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [swapStepRecord()], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });

    const outcome = await create();

    expect(updatePurchaseIntentStatusMock).toHaveBeenCalledWith(expect.anything(), { id: 'abandoned', from: 'AWAITING_SIGNATURE', to: 'CANCELLED' });
    expect(outcome.ok).toBe(true);
    expect(createPurchaseIntentMock).toHaveBeenCalled();
  });

  it('a half-signed intent past expiry + grace: its unsigned steps fail, it settles, and the new purchase proceeds', async () => {
    const sent = swapStepRecord({ stepIndex: 0, status: 'COMPLETED', txHash: '0x' + 'bb'.repeat(32) });
    const neverSigned = swapStepRecord({ stepIndex: 1, status: 'PENDING', txHash: null, targetSymbol: 'xAAPL', outputAsset: { chain: 'ethereum', address: AAPL_ADDRESS } });
    const halfSigned = intentFixture({
      id: 'half',
      status: 'SUBMITTED',
      expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      steps: [sent, neverSigned],
    });
    findActivePurchaseIntentForBagMock.mockResolvedValue(halfSigned);
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: halfSigned });
    updatePurchaseIntentStepsMock.mockImplementation(async (_a: unknown, _id: string, status: string, steps: PurchaseIntentStepRecord[]) => ({ ...halfSigned, status, steps }));
    updatePurchaseIntentStatusMock.mockImplementation(async (_a: unknown, u: { to: string }) => ({ ...halfSigned, status: u.to }));
    buildPurchaseIntentStepsMock.mockResolvedValue({ steps: [swapStepRecord()], allSwapsQuoted: true, firstFailure: null, composerTransaction: null });

    const outcome = await createPurchaseIntentForUser({
      admin: { rpc: rpcGrantingClaims() } as never,
      session: session(),
      bagId: 'bag_1',
      inputAssetId: 'asset_usdc',
      amount: '100',
    });

    const stepsWritten = updatePurchaseIntentStepsMock.mock.calls[0][3] as PurchaseIntentStepRecord[];
    expect(stepsWritten[1]).toMatchObject({ status: 'FAILED', failureCode: 'ROUTE_EXPIRED' });
    expect(outcome.ok).toBe(true);
  });

  it('within the grace window a half-signed intent still blocks (its steps may yet be signed)', async () => {
    const halfSigned = intentFixture({
      id: 'half',
      status: 'SUBMITTED',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      steps: [
        swapStepRecord({ stepIndex: 0, status: 'COMPLETED', txHash: '0x' + 'cc'.repeat(32) }),
        swapStepRecord({ stepIndex: 1, status: 'PENDING', txHash: null }),
      ],
    });
    findActivePurchaseIntentForBagMock.mockResolvedValue(halfSigned);
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent: halfSigned });
    updatePurchaseIntentStatusMock.mockImplementation(async (_a: unknown, u: { to: string }) => ({ ...halfSigned, status: u.to }));

    expect(await create()).toEqual({ ok: false, error: { kind: 'PURCHASE_IN_PROGRESS', intentId: 'half' } });
  });
});

describe('partialPurchaseShare', () => {
  it('counts completed swaps and KEEP legs, never failed or unsigned ones, and floors', async () => {
    const { partialPurchaseShare } = await import('../purchase-execution');
    const intent = intentFixture({
      inputAmountRaw: '100000000',
      sharesRaw: '100000000000000000000',
      depositAmount: '100',
      steps: [
        swapStepRecord({ stepIndex: 0, status: 'COMPLETED', inputAmountRaw: '44000000' }),
        swapStepRecord({ stepIndex: 1, status: 'COMPLETED', inputAmountRaw: '20000000' }),
        swapStepRecord({ stepIndex: 2, status: 'FAILED', inputAmountRaw: '16000000' }),
        swapStepRecord({ stepIndex: 3, status: 'PENDING', inputAmountRaw: '10000000' }),
        { ...swapStepRecord({ stepIndex: 4 }), action: 'KEEP', inputAmountRaw: '10000000' },
      ],
    });
    expect(partialPurchaseShare(intent)).toEqual({ spentRaw: '74000000', sharesRaw: '74000000000000000000', costBasis: '74' });
  });

  it('nothing executed means nothing minted', async () => {
    const { partialPurchaseShare } = await import('../purchase-execution');
    const intent = intentFixture({ steps: [swapStepRecord({ status: 'FAILED' })] });
    expect(partialPurchaseShare(intent)).toEqual({ spentRaw: '0', sharesRaw: '0', costBasis: '0' });
  });
});

// providerEnforcedMinOutputRaw is Composer's own on-chain swap floor, and the purchase flow sweeps the whole swap
// output to the wallet. At or above it verification behaves EXACTLY as if it were absent — same statuses, same
// persisted steps, same accounting. Below it the transaction did not run the call BAG built (F-01): refused.
describe('verifyExecution — providerEnforcedMinOutputRaw is a Composer leg\'s floor', () => {
  const COMPOSER_TX = { to: '0xComposerDiamond', data: '0xcomposercalldata', value: '0', chainId: 4663, userProxy: '0xProxy' };

  function composerIntent(providerMins: [string | null, string | null] | null): PurchaseIntent {
    const leg = (i: 0 | 1, address: string) =>
      swapStepRecord({
        stepIndex: i,
        status: 'SUBMITTED',
        txHash: '0xcomposertx',
        targetSymbol: i === 0 ? 'xNVDA' : 'xAAPL',
        outputAsset: { chain: 'ethereum', address },
        outputAmountRaw: '1000',
        outputDecimals: 18,
        minOutputRaw: null,
        route: null,
        lifiStep: null,
        ...(providerMins ? { providerEnforcedMinOutputRaw: providerMins[i] } : {}),
      });
    return intentFixture({
      providerId: 'lifi-composer',
      composerTransaction: COMPOSER_TX,
      status: 'SUBMITTED',
      steps: [leg(0, NVDA_ADDRESS), leg(1, AAPL_ADDRESS)],
    });
  }

  async function verify(intent: PurchaseIntent, received: Record<string, string>) {
    vi.clearAllMocks();
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    // The deposit left the wallet in the same transaction, as a real Composer purchase pulls it.
    const spent = intent.steps.filter((st) => st.action === 'SWAP').reduce((sum, st) => sum + BigInt(st.inputAmountRaw), BigInt(0));
    trackComposerTransactionMock.mockResolvedValue({
      kind: 'DONE',
      receivedAmountsByAddress: received,
      sentAmountsByAddress: { [intent.inputAsset.address.toLowerCase()]: spent.toString() },
    });
    statefulIntentRow(intent);
    const rpcMock = rpcGrantingClaims();
    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');
    const persisted = (updatePurchaseIntentStepsMock.mock.calls[0]?.[3] ?? []) as PurchaseIntentStepRecord[];
    return {
      status: outcome.ok ? outcome.value.status : `error:${outcome.error.kind}`,
      steps: persisted.map((st) => ({ status: st.status, outputAmountRaw: st.outputAmountRaw, failureCode: st.failureCode, minOutputRaw: st.minOutputRaw })),
      holdings: applyCall(rpcMock).p_holdings,
      statusTransitions: updatePurchaseIntentStatusMock.mock.calls.map((c) => (c[1] as { to: string }).to),
    };
  }

  const received = { [NVDA_ADDRESS.toLowerCase()]: '900', [AAPL_ADDRESS.toLowerCase()]: '950' };

  it('same result with and without the field when the received amount reaches the provider minimum', async () => {
    const without = await verify(composerIntent(null), received);
    const withMet = await verify(composerIntent(['1', '1']), received);
    const withExact = await verify(composerIntent(['900', '950']), received);

    expect(without.status).toBe('COMPLETED');
    expect(withMet).toEqual(without);
    expect(withExact).toEqual(without);
    expect(without.steps.map((st) => st.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(without.holdings).toHaveLength(2);
  });

  it('refuses the purchase when the deposit never left the wallet in that transaction (F-01)', async () => {
    const intent = composerIntent(null);
    vi.clearAllMocks();
    getPurchaseIntentForUserMock.mockResolvedValue({ ok: true, intent });
    // Outputs arrived, but only 1 raw unit of the input moved out of the wallet.
    trackComposerTransactionMock.mockResolvedValue({ kind: 'DONE', receivedAmountsByAddress: received, sentAmountsByAddress: { [intent.inputAsset.address.toLowerCase()]: '1' } });
    statefulIntentRow(intent);
    const rpcMock = rpcGrantingClaims();
    const outcome = await verifyExecution({ rpc: rpcMock } as never, session(), 'intent_1');
    const persisted = (updatePurchaseIntentStepsMock.mock.calls[0]?.[3] ?? []) as PurchaseIntentStepRecord[];
    expect(persisted.map((st) => [st.status, st.failureCode])).toEqual([
      ['FAILED', 'VERIFICATION_FAILED'],
      ['FAILED', 'VERIFICATION_FAILED'],
    ]);
    expect(outcome.ok && outcome.value.status).not.toBe('COMPLETED');
  });

  it('refuses a leg that received less than the provider minimum (VERIFICATION_FAILED), and books none of it', async () => {
    // 900 < 990: the Composer swap cannot have succeeded with this output.
    const below = await verify(composerIntent(['990', '1']), received);
    expect(below.steps.map((st) => [st.status, st.failureCode])).toEqual([
      ['FAILED', 'VERIFICATION_FAILED'],
      ['COMPLETED', null],
    ]);
    expect(below.status).not.toBe('COMPLETED');
  });
});

