import { describe, expect, it } from 'vitest';
import { AssetIdentity } from '@/types/basket-protocol';
import { MockPriceProvider } from '@/lib/domain/basket-protocol/pricing/mock-provider';
import { PriceProvider, PriceUnavailableError } from '@/lib/domain/basket-protocol/pricing/provider';
import { annotateCandidateMetrics } from '../candidate-metrics';
import { rankCandidates } from '../candidate-ranking';
import { ExecutionCandidate, ExecutionCandidateSet } from '../candidate-types';
import { validateCandidateCompleteness } from '../candidate-completeness';
import { BagExecutionGraph, CompiledExecution, ExpectedOutput } from '../types';

// -----------------------------------------------------------------------------
// Output SEMANTICS across providers, end to end (expected outputs → metrics →
// ranking). The providers report different things:
//   LI.FI Sequential  quote = estimate.toAmount   floor = estimate.toAmountMin (enforced)
//   BAG Router        quote = QuoterV2 amountOut  floor = quote − slippage (enforced on-chain)
//   LI.FI Composer    SIMULATION of the composed tx, no enforced floor
// These tests pin that "Best …" badges only ever come from a like-for-like
// comparison, and that a simulation is never presented as a guarantee.
// -----------------------------------------------------------------------------

const BTC: AssetIdentity = { chain: 'base', address: '0xBtc' }; // 8 decimals
const USDC: AssetIdentity = { chain: 'base', address: '0xUsdc' }; // 6 decimals
const WETH: AssetIdentity = { chain: 'base', address: '0xWeth' }; // 18 decimals
const DECIMALS: Record<string, number> = { '0xBtc': 8, '0xUsdc': 6, '0xWeth': 18 };

const quote = (legId: string, asset: AssetIdentity, quoted: string, floor: string): ExpectedOutput => ({
  legId,
  asset,
  quotedOutputRaw: quoted,
  quotedOutputBasis: 'PROVIDER_QUOTE',
  minimumGuaranteedOutputRaw: floor,
});
const simulation = (legId: string, asset: AssetIdentity, simulated: string): ExpectedOutput => ({
  legId,
  asset,
  quotedOutputRaw: simulated,
  quotedOutputBasis: 'SIMULATION',
  minimumGuaranteedOutputRaw: null,
});

function candidate(providerId: string, expectedOutputs: ExpectedOutput[], providerMetadata?: Record<string, unknown>): ExecutionCandidate {
  const compiled: CompiledExecution = { mode: 'MULTI_TX', chainId: 8453, transactions: [], expectedOutputs, providerId, executionPlanHash: 'h', providerMetadata };
  return { id: providerId, providerId, compile: { status: 'COMPILED' }, executionMode: 'MULTI_TX', compiled, metrics: null, executionPlanHash: 'h', compiledAt: 0 };
}
const failed = (providerId: string): ExecutionCandidate => ({
  id: providerId,
  providerId,
  compile: { status: 'FAILED', failureReason: { kind: 'PROVIDER_ERROR', message: 'quote unavailable' } },
  executionMode: null,
  metrics: null,
  executionPlanHash: 'h',
  compiledAt: 0,
});

function prices() {
  const p = new MockPriceProvider();
  p.setPrice(BTC, '60000.00');
  p.setPrice(USDC, '1.00');
  p.setPrice(WETH, '3000.00');
  return p;
}

async function annotateAndRank(candidates: ExecutionCandidate[], priceProvider: PriceProvider = prices()) {
  const set: ExecutionCandidateSet = { candidates, executionPlanHash: 'h', compiledAt: 0 };
  const annotated = await annotateCandidateMetrics(set, { requestedSlippageBps: 100, priceProvider, resolveAssetDecimals: (a) => DECIMALS[a.address] ?? null });
  const byId = Object.fromEntries(annotated.candidates.map((c) => [c.id, c]));
  const ranked = rankCandidates(annotated.candidates);
  const winner = (category: string) => ranked.winners.find((w) => w.category === category)?.providerId;
  return { byId, ranked, winner };
}

describe('expected vs minimum: two different numbers, never one field', () => {
  it('a quote-with-floor provider reports BOTH, priced separately (expected > guaranteed by the slippage)', async () => {
    // 1 BTC quoted, 0.99 BTC floor.
    const { byId } = await annotateAndRank([candidate('lifi-sequential', [quote('leg_0', BTC, '100000000', '99000000')])]);
    expect(byId['lifi-sequential'].metrics).toMatchObject({ quotedOutputUsd: 60000, quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputUsd: 59400 });
  });

  it('a simulation-only provider shows its simulated figure but NO guaranteed minimum (never back-filled from the simulation)', async () => {
    const { byId } = await annotateAndRank([candidate('lifi-composer', [simulation('leg_0', BTC, '100000000')])]);
    expect(byId['lifi-composer'].metrics).toMatchObject({ quotedOutputUsd: 60000, quotedOutputBasis: 'SIMULATION', minimumGuaranteedOutputUsd: null });
  });

  it('a candidate where only SOME legs have a floor has no guaranteed total (never a partial sum)', async () => {
    const mixed = candidate('odd', [quote('leg_0', BTC, '100000000', '99000000'), simulation('leg_1', WETH, '1000000000000000000')]);
    const { byId } = await annotateAndRank([mixed]);
    expect(byId.odd.metrics).toMatchObject({ quotedOutputUsd: 63000, quotedOutputBasis: 'MIXED', minimumGuaranteedOutputUsd: null });
  });
});

describe('provider comparison', () => {
  it('REGRESSION: Composer\'s simulation no longer "beats" LI.FI\'s slippage floor — no output badge when semantics differ', async () => {
    // Same real market: LI.FI quotes 1.000 BTC (floor 0.990), Composer simulates 1.000 BTC.
    // The old single field compared 0.990 (LI.FI floor) to 1.000 (Composer sim) and crowned Composer.
    const { winner, byId } = await annotateAndRank([
      candidate('lifi-sequential', [quote('leg_0', BTC, '100000000', '99000000')]),
      candidate('lifi-composer', [simulation('leg_0', BTC, '100000000')]),
    ]);
    expect(winner('bestGuaranteedOutput')).toBeUndefined();
    expect(winner('bestQuotedOutput')).toBeUndefined();
    // Each provider's own output is still available for display.
    expect(byId['lifi-sequential'].metrics?.minimumGuaranteedOutputUsd).toBe(59400);
    expect(byId['lifi-composer'].metrics?.quotedOutputUsd).toBe(60000);
  });

  it('two providers that both ENFORCE a floor are compared on the floor — the higher guaranteed minimum wins, even if its quote is lower', async () => {
    const { winner } = await annotateAndRank([
      candidate('lifi-sequential', [quote('leg_0', BTC, '100500000', '98000000')]), // higher quote, looser floor
      candidate('bag-router', [quote('leg_0', BTC, '100000000', '99000000')]), // lower quote, tighter floor
    ]);
    expect(winner('bestGuaranteedOutput')).toBe('bag-router');
    expect(winner('bestQuotedOutput')).toBe('lifi-sequential'); // both are PROVIDER_QUOTEs — a like-for-like expected-output comparison
  });
});

describe('USD normalization and differing decimals', () => {
  it('legs in 8-, 6- and 18-decimal assets are each scaled by their own decimals before summing', async () => {
    const outputs = [
      quote('leg_0', BTC, '50000000', '50000000'), // 0.5 BTC  × 60000 = 30000
      quote('leg_1', USDC, '2500000000', '2500000000'), // 2500 USDC × 1  = 2500
      quote('leg_2', WETH, '2000000000000000000', '2000000000000000000'), // 2 WETH × 3000 = 6000
    ];
    const { byId } = await annotateAndRank([candidate('lifi-sequential', outputs)]);
    expect(byId['lifi-sequential'].metrics?.quotedOutputUsd).toBe(38500);
    expect(byId['lifi-sequential'].metrics?.minimumGuaranteedOutputUsd).toBe(38500);
  });

  it('comparison is on USD, not raw units: fewer raw units of a pricier asset can win', async () => {
    const { winner } = await annotateAndRank([
      candidate('a', [quote('leg_0', USDC, '1000000000', '990000000')]), // 990 USDC floor = $990
      candidate('b', [quote('leg_0', WETH, '340000000000000000', '335000000000000000')]), // 0.335 WETH floor = $1005
    ]);
    expect(winner('bestGuaranteedOutput')).toBe('b');
  });

  it('an unresolvable decimals value makes that candidate\'s totals null — and blocks the comparison instead of letting the other win', async () => {
    const unknownAsset: AssetIdentity = { chain: 'base', address: '0xUnknown' };
    const { byId, winner } = await annotateAndRank([candidate('a', [quote('leg_0', unknownAsset, '100', '99')]), candidate('b', [quote('leg_0', USDC, '1000000', '990000')])]);
    expect(byId.a.metrics).toMatchObject({ quotedOutputUsd: null, minimumGuaranteedOutputUsd: null });
    expect(winner('bestGuaranteedOutput')).toBeUndefined();
  });
});

describe('fees, unavailable quotes, failures, ties', () => {
  it('missing provider fee: a provider that reports no fee gets no fabricated $0 fee, and its output metrics are unaffected', async () => {
    const withFee = candidate('lifi-sequential', [quote('leg_0', USDC, '1000000', '990000')], {
      legResults: { leg_0: { ok: true, outputAmountRaw: '1000000', outputDecimals: 6, minOutputRaw: '990000', route: 'x', lifiStep: { estimate: { feeCosts: [{ amountUSD: '0.30' }] } } } },
    });
    const noFee = candidate('bag-router', [quote('leg_0', USDC, '1000000', '990000')]);
    const { byId } = await annotateAndRank([withFee, noFee]);
    expect(byId['lifi-sequential'].metrics?.providerMetadata).toEqual({ estimatedFeeUsd: 0.3 });
    expect(byId['bag-router'].metrics?.providerMetadata).toBeUndefined();
    expect(byId['bag-router'].metrics?.minimumGuaranteedOutputUsd).toBe(0.99);
  });

  it('unavailable quote: a leg with no quote makes the candidate structurally incomplete (FAILED upstream), never a $0 output', () => {
    const graph: BagExecutionGraph = {
      bagId: 'b',
      wallet: '0xW',
      chainId: 'base',
      inputAsset: USDC,
      inputAmountRaw: '1',
      unallocatedRaw: '0',
      legs: [{ id: 'leg_0', sourceAsset: USDC, targetAsset: BTC, amountRaw: '1', weightBps: 10000, minimumOutputRaw: null, slippageBps: 100, chain: 'base', dependsOn: [] }],
    };
    const noQuote: CompiledExecution = { ...candidate('x', [{ ...simulation('leg_0', BTC, '1'), quotedOutputRaw: null }]).compiled! };
    expect(validateCandidateCompleteness(graph, noQuote).ok).toBe(false);
  });

  it('an unpriceable output asset leaves metrics null rather than zero', async () => {
    const unpriced: PriceProvider = {
      getPrice: async (asset) => {
        throw new PriceUnavailableError(asset);
      },
    };
    const { byId } = await annotateAndRank([candidate('a', [quote('leg_0', USDC, '1000000', '990000')])], unpriced);
    expect(byId.a.metrics).toMatchObject({ quotedOutputUsd: null, minimumGuaranteedOutputUsd: null });
  });

  it('one FAILED candidate + one valid candidate: the valid one is executable and shows its own output, but no "best" badge is invented', async () => {
    const { ranked, byId } = await annotateAndRank([failed('lifi-composer'), candidate('lifi-sequential', [quote('leg_0', USDC, '1000000', '990000')])]);
    expect(ranked.executable.map((c) => c.id)).toEqual(['lifi-sequential']);
    expect(ranked.failed.map((c) => c.id)).toEqual(['lifi-composer']);
    expect(byId['lifi-composer'].metrics).toBeNull();
    expect(byId['lifi-sequential'].metrics?.minimumGuaranteedOutputUsd).toBe(0.99);
    expect(ranked.winners).toEqual([]);
  });

  it('equal outputs: two routes with identical guaranteed and quoted outputs get no output badge', async () => {
    const { winner } = await annotateAndRank([
      candidate('lifi-sequential', [quote('leg_0', USDC, '1000000', '990000')]),
      candidate('bag-router', [quote('leg_0', USDC, '1000000', '990000')]),
    ]);
    expect(winner('bestGuaranteedOutput')).toBeUndefined();
    expect(winner('bestQuotedOutput')).toBeUndefined();
  });
});
