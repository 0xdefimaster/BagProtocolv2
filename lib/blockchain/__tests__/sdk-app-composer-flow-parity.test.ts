import { describe, expect, it } from 'vitest';
import { buildComposerPurchase } from '../lifi-composer-adapter';
import { composeResponse, wireOut } from './composer-fixtures';
import { compileBag, parseBag, planPurchase, type BagDocument } from '@/packages/bag-sdk/src';
import { lifiComposer } from '@/packages/bag-sdk/src/adapters/lifi';

// -----------------------------------------------------------------------------
// Two Composer adapters, one flow. For the same plan, BAG's buildComposerPurchase and the SDK's lifiComposer must
// send Composer the same program: the same core.partition node(s) with the same bps, the same lifi.swap nodes in
// the same order and bindings, the same run inputs. Only the flow's display id differs. HTTP is mocked at the fetch
// boundary; the real @lifi/composer-sdk builds and serializes both requests.
// -----------------------------------------------------------------------------

const USDG = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const ROUTER = '0x' + '7'.repeat(40);
const token = (i: number) => '0x' + (0x1000 + i * 7919).toString(16).padStart(8, '0') + 'd'.repeat(32);

function bag(weights: number[]): BagDocument {
  const r = parseBag({
    bagJson: 1,
    definition: {
      kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'MUTABLE',
      assets: weights.map((weightBps, i) => ({ chain: 'robinhood', address: token(i), decimals: 18, weightBps })),
      rules: { weightBounds: { minBps: 1, maxBps: 10000 }, maxAssets: 100, minInvestment: null, swapSlippageBps: 100, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: null },
    },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
}

/** A fetch that records the compose request body and answers with a compile result for `tokens`. */
function recordingFetch(tokens: string[], bodies: unknown[]) {
  return (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    // The SDK validates terminal ownership. This response must name the same
    // signer as the request, rather than the shared fixture's placeholder.
    const outputs = Object.fromEntries(tokens.map((t, i) => [`swap_${i}.amountOut`, { ...wireOut(1000, 990, t), owner: SIGNER }]));
    return composeResponse({ data: { outputs, transactionRequest: { to: ROUTER, chainId: 4663, data: '0xdeadbeef', value: '0' }, userProxy: '0x' + '8'.repeat(40), approvals: [], priceImpact: { inputValueUsd: 100, outputValueUsd: 99, impactBps: 100, unpricedInputs: [], unpricedOutputs: [] }, fees: [] } });
  }) as unknown as typeof fetch;
}

const program = (body: unknown) => {
  const b = body as { flow: { nodes: unknown[]; inputs: unknown[]; chainId: number }; run: unknown };
  return { chainId: b.flow.chainId, inputs: b.flow.inputs, nodes: b.flow.nodes, run: b.run };
};

describe('BAG buildComposerPurchase ↔ SDK lifiComposer: the same Composer program', () => {
  const cases: [string, number[]][] = [
    ['2 legs', [4000, 6000]],
    ['7 uneven legs', [1, 2, 997, 3000, 1500, 2500, 2000]],
    ['20 legs (two partition levels)', [...Array(19).fill(500), 500]],
    ['37 legs', Array.from({ length: 37 }, (_, i) => (i === 0 ? 10000 - 36 * 270 : 270))],
  ];
  for (const [name, weights] of cases) {
    it(name, async () => {
      const doc = bag(weights);
      const deposit = BigInt(123_456_789);
      const plan = planPurchase(doc, { inputToken: USDG, amountRaw: deposit, signer: SIGNER });
      const tokens = plan.legs.map((l) => l.token);

      const sdkBodies: unknown[] = [];
      await compileBag(doc, { inputToken: USDG, amountRaw: deposit, signer: SIGNER }, {
        provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: recordingFetch(tokens, sdkBodies) }),
        trust: { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] },
      });

      const appBodies: unknown[] = [];
      await buildComposerPurchase({
        chain: 'robinhood',
        inputTokenAddress: USDG,
        inputAmountRaw: plan.swapAmountRaw.toString(),
        legs: plan.legs.map((l) => ({ address: l.token, weightBps: l.legBps, symbol: l.token })),
        signerAddress: SIGNER,
        slippageBps: plan.slippageBps,
        maxPriceImpactBps: plan.maxPriceImpactBps,
        apiKey: 'k',
        fetchImpl: recordingFetch(tokens, appBodies),
      });

      expect(sdkBodies).toHaveLength(1);
      expect(appBodies).toHaveLength(1);
      expect(program(appBodies[0])).toEqual(program(sdkBodies[0]));
      // No cascade anywhere: only partition and swap nodes.
      const ops = (program(sdkBodies[0]).nodes as { op: string }[]).map((n) => n.op);
      expect(new Set(ops)).toEqual(new Set(['core.partition', 'lifi.swap']));
    });
  }
});
