import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, pad, type Hex } from 'viem';
import { compileBagExecution, compileBagExecutionCandidates } from '../../compiler';
import { computeBagExecutionGraphHash } from '../../plan';
import { buildDefaultProviders } from '../../registry';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from '../../types';
import { ChainId } from '@/types/basket-protocol';
import { ROBINHOOD_CHAIN_ID } from '@/lib/config/robinhood-chain';
import {
  BAG_EXECUTION_ROUTER_ABI,
  BAG_ROUTER_PROVIDER_ID,
  BagRouterProvider,
  BagRouterProviderConfig,
  BuiltRouterLeg,
} from '../bag-router-provider';

// -----------------------------------------------------------------------------
// Item 9 — proves the EXISTING compiler can target the new router through
// the EXISTING `BagExecutionProvider` seam: same `compileBagExecution()`,
// same registry, same `CompiledExecution` contract, no second execution
// abstraction and no bypass of the provider/intent architecture.
//
// No network and no chain here: the router's own on-chain behaviour is
// covered by contracts/test/BagExecutionRouter.test.ts (29 Hardhat tests).
// What these tests can uniquely prove is the SEAM — that what the provider
// hands the wallet layer is a single well-formed `execute()` call carrying
// exactly the plan that was signed.
// -----------------------------------------------------------------------------

const ROUTER: Hex = '0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const INPUT: Hex = '0x1111111111111111111111111111111111111111';
const TARGET_A: Hex = '0x2222222222222222222222222222222222222222';
const TARGET_B: Hex = '0x3333333333333333333333333333333333333333';
const POOL_A: Hex = '0x4444444444444444444444444444444444444444';
const POOL_B: Hex = '0x5555555555555555555555555555555555555555';
const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`;

function makeIntent(overrides: Partial<BagExecutionIntent> = {}): BagExecutionIntent {
  return {
    bagId: 'bag_1',
    wallet: '0x6666666666666666666666666666666666666666',
    chainId: 'base',
    inputAsset: { chain: 'base', address: INPUT },
    inputAmountRaw: '1000000',
    targets: [{ asset: { chain: 'base', address: TARGET_A }, weightBps: 10000 }],
    maxSlippageBps: 100,
    deadline: Date.now() + 60_000,
    recipeVersion: 1,
    compositionHash: 'hash_1',
    ...overrides,
  };
}

function makeGraph(overrides: Partial<BagExecutionGraph> = {}): BagExecutionGraph {
  return {
    bagId: 'bag_1',
    wallet: '0x6666666666666666666666666666666666666666',
    chainId: 'base',
    inputAsset: { chain: 'base', address: INPUT },
    inputAmountRaw: '1000000',
    legs: [
      {
        id: 'leg_0',
        sourceAsset: { chain: 'base', address: INPUT },
        targetAsset: { chain: 'base', address: TARGET_A },
        amountRaw: '600000',
        weightBps: 6000,
        minimumOutputRaw: null,
        slippageBps: 100,
        chain: 'base',
        dependsOn: [],
      },
      {
        id: 'leg_1',
        sourceAsset: { chain: 'base', address: INPUT },
        targetAsset: { chain: 'base', address: TARGET_B },
        amountRaw: '400000',
        weightBps: 4000,
        minimumOutputRaw: null,
        slippageBps: 100,
        chain: 'base',
        dependsOn: [],
      },
    ],
    unallocatedRaw: '0',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<BagRouterProviderConfig> = {}): BagRouterProviderConfig {
  const legBuilder = vi.fn(async (leg: BagExecutionGraph['legs'][number]): Promise<BuiltRouterLeg> => ({
    target: leg.targetAsset.address === TARGET_A ? POOL_A : POOL_B,
    callData: '0xdeadbeef',
    value: BigInt(0),
    approveToken: INPUT,
    approveAmount: BigInt(leg.amountRaw),
    quotedOutputRaw: ((BigInt(leg.amountRaw) * BigInt(202)) / BigInt(100)).toString(), // quote before slippage
    minimumGuaranteedOutputRaw: (BigInt(leg.amountRaw) * BigInt(2)).toString(), // enforced floor
  }));

  return {
    routerAddress: ROUTER,
    chainId: 8453,
    toOnChainBagId: (bagId: string) => pad(`0x${Buffer.from(bagId).toString('hex')}` as Hex, { size: 32 }),
    legBuilder,
    signPlan: vi.fn(async () => SIGNATURE),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function decodePlan(data: Hex) {
  const decoded = decodeFunctionData({ abi: BAG_EXECUTION_ROUTER_ABI, data });
  return decoded.args as unknown as [
    {
      bagId: Hex;
      executionPlanHash: Hex;
      wallet: Hex;
      inputToken: Hex;
      inputAmount: bigint;
      deadline: bigint;
      legs: { target: Hex; callData: Hex; value: bigint; approveToken: Hex; approveAmount: bigint }[];
      minOutputs: { token: Hex; minAmountOut: bigint }[];
    },
    Hex,
  ];
}

describe('BagRouterProvider — eligibility', () => {
  it('supports a same-chain, single-input graph', () => {
    const provider = new BagRouterProvider(makeConfig());
    expect(provider.supports(makeIntent(), makeGraph())).toBe(true);
  });

  it('refuses a graph whose legs span more than one chain', () => {
    const provider = new BagRouterProvider(makeConfig());
    const graph = makeGraph();
    graph.legs[1].chain = 'arbitrum';
    expect(provider.supports(makeIntent(), graph)).toBe(false);
  });

  it('refuses a graph where a leg spends an asset other than the graph input (the router pulls exactly one input token)', () => {
    const provider = new BagRouterProvider(makeConfig());
    const graph = makeGraph();
    graph.legs[1].sourceAsset = { chain: 'base', address: TARGET_A };
    expect(provider.supports(makeIntent(), graph)).toBe(false);
  });

  it('refuses a native-ETH input (the router pulls its input with transferFrom: ERC-20 only)', () => {
    const provider = new BagRouterProvider(makeConfig());
    const ETH = { chain: 'base' as const, address: '0x0000000000000000000000000000000000000000' };
    const g = makeGraph();
    const graph = { ...g, inputAsset: ETH, legs: g.legs.map((l) => ({ ...l, sourceAsset: ETH })) };
    expect(provider.supports(makeIntent({ inputAsset: ETH }), graph)).toBe(false);
  });

  it('refuses an empty graph rather than compiling a plan with no legs (which the contract rejects outright)', () => {
    const provider = new BagRouterProvider(makeConfig());
    expect(provider.supports(makeIntent(), makeGraph({ legs: [] }))).toBe(false);
  });

  it('never throws from supports(), even on a malformed graph — the interface requires it be speculative-call safe', () => {
    const provider = new BagRouterProvider(makeConfig());
    const graph = makeGraph({ inputAsset: { chain: 'base', address: INPUT } });
    expect(() => provider.supports(makeIntent({ chainId: 'arbitrum' }), graph)).not.toThrow();
  });

  it('reports itself as atomic single-transaction, but honestly still requiring an approval (Permit2 is a later phase)', () => {
    const caps = new BagRouterProvider(makeConfig()).getCapabilities();
    expect(caps.atomic).toBe(true);
    expect(caps.singleTransaction).toBe(true);
    expect(caps.requiresMultipleSignatures).toBe(false);
    expect(caps.requiresApproval).toBe(true);
    expect(caps.supportsPermit).toBe(false);
  });
});

describe('BagRouterProvider — chain binding (config.chainId is really enforced)', () => {
  // Rewrites every chain field of the default graph/intent to `chain`, so only the chain differs between cases.
  const onChain = (chain: ChainId) => {
    const g = makeGraph();
    const graph: BagExecutionGraph = {
      ...g,
      chainId: chain,
      inputAsset: { ...g.inputAsset, chain },
      legs: g.legs.map((l) => ({ ...l, chain, sourceAsset: { ...l.sourceAsset, chain }, targetAsset: { ...l.targetAsset, chain } })),
    };
    const intent = makeIntent({ chainId: chain, inputAsset: { chain, address: INPUT } });
    return { graph, intent };
  };
  const robinhoodRouter = () => new BagRouterProvider(makeConfig({ chainId: ROBINHOOD_CHAIN_ID }));
  const baseRouter = () => new BagRouterProvider(makeConfig({ chainId: 8453 }));

  it('matching chain: a Robinhood-pinned router supports a Robinhood graph; a Base-pinned router supports a Base graph', () => {
    const rh = onChain('robinhood');
    expect(robinhoodRouter().supports(rh.intent, rh.graph)).toBe(true);
    const base = onChain('base');
    expect(baseRouter().supports(base.intent, base.graph)).toBe(true);
  });

  it.each(['ethereum', 'base', 'arbitrum', 'solana'] as ChainId[])('wrong chain: a Robinhood-pinned router refuses a fully-%s graph', (chain) => {
    const { graph, intent } = onChain(chain);
    expect(robinhoodRouter().supports(intent, graph)).toBe(false);
  });

  it('wrong chain: a Base-pinned router refuses a Robinhood graph', () => {
    const { graph, intent } = onChain('robinhood');
    expect(baseRouter().supports(intent, graph)).toBe(false);
  });

  it('uses the canonical mapping, not coercion: the Robinhood TESTNET id (46630) never matches the mainnet ChainId', () => {
    const { graph, intent } = onChain('robinhood');
    expect(new BagRouterProvider(makeConfig({ chainId: 46630 })).supports(intent, graph)).toBe(false);
  });

  it('mixed-chain graph: one leg (or one leg asset, or the input asset) on another chain → false, even when graph.chainId matches', () => {
    const legChain = onChain('robinhood');
    legChain.graph.legs[1] = { ...legChain.graph.legs[1], chain: 'base' };
    expect(robinhoodRouter().supports(legChain.intent, legChain.graph)).toBe(false);

    const targetChain = onChain('robinhood');
    targetChain.graph.legs[0] = { ...targetChain.graph.legs[0], targetAsset: { chain: 'base', address: TARGET_A } };
    expect(robinhoodRouter().supports(targetChain.intent, targetChain.graph)).toBe(false);

    const inputChain = onChain('robinhood');
    inputChain.graph.inputAsset = { chain: 'base', address: INPUT };
    expect(robinhoodRouter().supports(inputChain.intent, inputChain.graph)).toBe(false);
  });

  it('wrong intent chain: a Robinhood graph with an intent for another chain → false', () => {
    const { graph } = onChain('robinhood');
    expect(robinhoodRouter().supports(onChain('base').intent, graph)).toBe(false);
  });

  it('empty graph on the matching chain → false', () => {
    const { graph, intent } = onChain('robinhood');
    expect(robinhoodRouter().supports(intent, { ...graph, legs: [] })).toBe(false);
  });

  it('never throws, even for garbage input — returns false', () => {
    const provider = robinhoodRouter();
    const { intent } = onChain('robinhood');
    const garbage = [undefined, null, {}, { chainId: 'robinhood', legs: [{}] }, { chainId: 'robinhood', legs: null }, { chainId: 'not-a-chain', legs: [] }];
    for (const g of garbage) {
      expect(() => provider.supports(intent, g as unknown as BagExecutionGraph)).not.toThrow();
      expect(provider.supports(intent, g as unknown as BagExecutionGraph)).toBe(false);
    }
  });

  it('compile fallback is preserved: a Robinhood-pinned router given a Base graph falls through to the next provider', async () => {
    const router = new BagRouterProvider(makeConfig({ chainId: ROBINHOOD_CHAIN_ID }));
    const fallback = {
      identify: () => 'fallback',
      getCapabilities: () => router.getCapabilities(),
      supports: () => true,
      compile: async () => ({ mode: 'MULTI_TX' as const, chainId: 8453, transactions: [], expectedOutputs: [], providerId: 'fallback', executionPlanHash: 'x' }),
    };
    const { graph, intent } = onChain('base');
    const compiled = await compileBagExecution(intent, graph, [router, fallback]);
    expect(compiled.providerId).toBe('fallback');
    const cfg = makeConfig({ chainId: ROBINHOOD_CHAIN_ID });
    await compileBagExecution(intent, graph, [new BagRouterProvider(cfg), fallback]);
    expect(cfg.legBuilder).not.toHaveBeenCalled(); // never even quoted on the wrong chain
    expect(cfg.signPlan).not.toHaveBeenCalled();
  });
});

describe('BagRouterProvider — compilation', () => {
  it('produces exactly ONE transaction, addressed to the router', async () => {
    const provider = new BagRouterProvider(makeConfig());
    const compiled = await provider.compile(makeIntent(), makeGraph());

    expect(compiled.mode).toBe('SINGLE_TX');
    expect(compiled.transactions).toHaveLength(1);
    expect(compiled.transactions[0].to).toBe(ROUTER);
    expect(compiled.transactions[0].chainId).toBe(8453);
  });

  it('encodes the built legs into the execute() calldata verbatim — the provider never invents swap calldata of its own', async () => {
    const provider = new BagRouterProvider(makeConfig());
    const compiled = await provider.compile(makeIntent(), makeGraph());
    const [plan] = decodePlan(compiled.transactions[0].data as Hex);

    expect(plan.legs).toHaveLength(2);
    expect(plan.legs[0].target).toBe(POOL_A);
    expect(plan.legs[1].target).toBe(POOL_B);
    expect(plan.legs[0].callData).toBe('0xdeadbeef');
    expect(plan.legs[0].approveAmount).toBe(BigInt(600000));
    expect(plan.legs[1].approveAmount).toBe(BigInt(400000));
    expect(plan.inputToken).toBe(INPUT);
    expect(plan.inputAmount).toBe(BigInt(1000000));
  });

  it('binds the signed plan to the SAME graph hash the compiler stamps — not a second, independently-derived value', async () => {
    const graph = makeGraph();
    const provider = new BagRouterProvider(makeConfig());
    const compiled = await provider.compile(makeIntent(), graph);
    const [plan] = decodePlan(compiled.transactions[0].data as Hex);

    expect(plan.executionPlanHash).toBe(`0x${computeBagExecutionGraphHash(graph)}`);
  });

  it('carries each leg minimum through to expectedOutputs without fabricating one', async () => {
    const provider = new BagRouterProvider(makeConfig());
    const compiled = await provider.compile(makeIntent(), makeGraph());

    expect(compiled.expectedOutputs).toEqual([
      { legId: 'leg_0', asset: { chain: 'base', address: TARGET_A }, quotedOutputRaw: '1212000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1200000' },
      { legId: 'leg_1', asset: { chain: 'base', address: TARGET_B }, quotedOutputRaw: '808000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '800000' },
    ]);
  });

  it('sums minimums per distinct output token, because the contract rejects duplicate output checks', async () => {
    const graph = makeGraph();
    // Both legs now land in the SAME target asset.
    graph.legs[1].targetAsset = { chain: 'base', address: TARGET_A };
    const provider = new BagRouterProvider(makeConfig());
    const compiled = await provider.compile(makeIntent(), graph);
    const [plan] = decodePlan(compiled.transactions[0].data as Hex);

    expect(plan.minOutputs).toHaveLength(1);
    expect(plan.minOutputs[0].token.toLowerCase()).toBe(TARGET_A.toLowerCase());
    expect(plan.minOutputs[0].minAmountOut).toBe(BigInt(1200000) + BigInt(800000));
  });

  it('sets a bounded deadline from the injected clock rather than leaving the plan valid forever', async () => {
    const provider = new BagRouterProvider(makeConfig({ planTtlSeconds: 120, now: () => 1_700_000_000_000 }));
    const compiled = await provider.compile(makeIntent(), makeGraph());
    const [plan] = decodePlan(compiled.transactions[0].data as Hex);

    expect(plan.deadline).toBe(BigInt(1_700_000_000 + 120));
  });

  it('asks the injected signer to sign, and embeds that exact signature — the provider holds no key itself', async () => {
    const signPlan = vi.fn(async () => SIGNATURE);
    const provider = new BagRouterProvider(makeConfig({ signPlan }));
    const compiled = await provider.compile(makeIntent(), makeGraph());
    const [, signature] = decodePlan(compiled.transactions[0].data as Hex);

    expect(signPlan).toHaveBeenCalledTimes(1);
    expect(signPlan).toHaveBeenCalledWith(expect.objectContaining({ wallet: makeGraph().wallet }), 8453, ROUTER);
    expect(signature).toBe(SIGNATURE);
  });

  it('propagates a leg-builder failure as a thrown error, so the compiler can fall through to the next provider', async () => {
    const provider = new BagRouterProvider(
      makeConfig({
        legBuilder: vi.fn(async () => {
          throw new Error('no route for this pair');
        }),
      })
    );
    await expect(provider.compile(makeIntent(), makeGraph())).rejects.toThrow('no route for this pair');
  });
});

describe('BagRouterProvider — compiler integration (no architecture bypass)', () => {
  it('is selected by the real compileBagExecution() and its result is re-stamped by the compiler', async () => {
    const graph = makeGraph();
    const provider = new BagRouterProvider(makeConfig());

    const compiled = await compileBagExecution(makeIntent(), graph, [provider]);

    expect(compiled.providerId).toBe(BAG_ROUTER_PROVIDER_ID);
    expect(compiled.executionPlanHash).toBe(computeBagExecutionGraphHash(graph));
    expect(compiled.mode).toBe('SINGLE_TX');
  });

  it('satisfies an atomic:true constraint through the real compiler', async () => {
    const provider = new BagRouterProvider(makeConfig());
    const compiled = await compileBagExecution(
      makeIntent({ constraints: { atomic: true } }),
      makeGraph(),
      [provider]
    );
    expect(compiled.providerId).toBe(BAG_ROUTER_PROVIDER_ID);
  });

  it('falls through to the next provider when the router cannot serve the graph — existing fallback behaviour is untouched', async () => {
    const routerProvider = new BagRouterProvider(makeConfig());
    const fallback = {
      identify: () => 'fallback',
      getCapabilities: () => routerProvider.getCapabilities(),
      supports: () => true,
      compile: async () => ({
        mode: 'MULTI_TX' as const,
        chainId: 8453,
        transactions: [],
        expectedOutputs: [],
        providerId: 'fallback',
        executionPlanHash: 'x',
      }),
    };

    // Cross-chain graph: the router refuses it in supports().
    const graph = makeGraph();
    graph.legs[1].chain = 'arbitrum';

    const compiled = await compileBagExecution(makeIntent(), graph, [routerProvider, fallback]);
    expect(compiled.providerId).toBe('fallback');
  });

  it('falls through when the router is eligible but its leg builder fails at compile time', async () => {
    const routerProvider = new BagRouterProvider(
      makeConfig({
        legBuilder: vi.fn(async () => {
          throw new Error('router quote unavailable');
        }),
      })
    );
    const fallback = {
      identify: () => 'fallback',
      getCapabilities: () => routerProvider.getCapabilities(),
      supports: () => true,
      compile: async () => ({
        mode: 'MULTI_TX' as const,
        chainId: 8453,
        transactions: [],
        expectedOutputs: [],
        providerId: 'fallback',
        executionPlanHash: 'x',
      }),
    };

    const compiled = await compileBagExecution(makeIntent(), makeGraph(), [routerProvider, fallback]);
    expect(compiled.providerId).toBe('fallback');
  });
});

describe('BagRouterProvider — compileQuote() (comparison-only, no signature)', () => {
  it('never calls signPlan, unlike compile()', async () => {
    const signPlan = vi.fn(async () => SIGNATURE);
    const provider = new BagRouterProvider(makeConfig({ signPlan }));

    await provider.compileQuote(makeIntent(), makeGraph());

    expect(signPlan).not.toHaveBeenCalled();
  });

  it('still quotes real legs through the injected legBuilder — the numbers are as real as compile()\'s, only the signature is withheld', async () => {
    const legBuilder = vi.fn(async (leg: BagExecutionGraph['legs'][number]): Promise<BuiltRouterLeg> => ({
      target: leg.targetAsset.address === TARGET_A ? POOL_A : POOL_B,
      callData: '0xdeadbeef',
      value: BigInt(0),
      approveToken: INPUT,
      approveAmount: BigInt(leg.amountRaw),
      quotedOutputRaw: ((BigInt(leg.amountRaw) * BigInt(202)) / BigInt(100)).toString(), // quote before slippage
    minimumGuaranteedOutputRaw: (BigInt(leg.amountRaw) * BigInt(2)).toString(), // enforced floor
    }));
    const provider = new BagRouterProvider(makeConfig({ legBuilder }));

    const quote = await provider.compileQuote(makeIntent(), makeGraph());

    expect(legBuilder).toHaveBeenCalledTimes(2);
    expect(quote.expectedOutputs).toEqual([
      { legId: 'leg_0', asset: { chain: 'base', address: TARGET_A }, quotedOutputRaw: '1212000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1200000' },
      { legId: 'leg_1', asset: { chain: 'base', address: TARGET_B }, quotedOutputRaw: '808000', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '800000' },
    ]);
  });

  it('returns no transactions — nothing executable exists before a route is selected and signed', async () => {
    const provider = new BagRouterProvider(makeConfig());
    const quote = await provider.compileQuote(makeIntent(), makeGraph());
    expect(quote.transactions).toEqual([]);
  });

  it('carries no signedPlan in providerMetadata — only compile() ever produces one', async () => {
    const provider = new BagRouterProvider(makeConfig());
    const quote = await provider.compileQuote(makeIntent(), makeGraph());
    expect(quote.providerMetadata?.signedPlan).toBeUndefined();
    expect(quote.providerMetadata?.quoteOnly).toBe(true);
  });

  it('binds to the same wallet and the same graph hash compile() would sign — wallet binding and executionPlanHash are preserved on the quote path too', async () => {
    const graph = makeGraph();
    const provider = new BagRouterProvider(makeConfig());
    const quote = await provider.compileQuote(makeIntent(), graph);

    expect(quote.executionPlanHash).toBe(computeBagExecutionGraphHash(graph));
    expect(quote.providerMetadata?.wallet).toBe(graph.wallet);
  });

  it('propagates a leg-builder failure the same way compile() does, so a broken quote can still become a FAILED candidate', async () => {
    const provider = new BagRouterProvider(
      makeConfig({
        legBuilder: vi.fn(async () => {
          throw new Error('no route for this pair');
        }),
      })
    );
    await expect(provider.compileQuote(makeIntent(), makeGraph())).rejects.toThrow('no route for this pair');
  });
});

describe('BagRouterProvider — signing boundary through the real compiler (comparison vs executable)', () => {
  it('compileBagExecutionCandidates() never calls signPlan — candidate comparison is side-effect-free', async () => {
    const signPlan = vi.fn(async () => SIGNATURE);
    const provider = new BagRouterProvider(makeConfig({ signPlan }));

    const result = await compileBagExecutionCandidates(makeIntent(), makeGraph(), [provider]);

    expect(signPlan).not.toHaveBeenCalled();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].compile.status).toBe('COMPILED');
  });

  it('compileBagExecution() (the selected-provider executable path) DOES call signPlan, exactly once', async () => {
    const signPlan = vi.fn(async () => SIGNATURE);
    const provider = new BagRouterProvider(makeConfig({ signPlan }));

    const compiled = await compileBagExecution(makeIntent(), makeGraph(), [provider]);

    expect(signPlan).toHaveBeenCalledTimes(1);
    expect(compiled.providerMetadata?.signedPlan).toBeDefined();
  });

  it('a signed plan is only ever produced by the executable path — running comparison first, then selecting the provider, signs exactly once total', async () => {
    const signPlan = vi.fn(async () => SIGNATURE);
    const provider = new BagRouterProvider(makeConfig({ signPlan }));
    const graph = makeGraph();
    const intent = makeIntent();

    // Same lifecycle a real purchase goes through: compare first...
    const candidateSet = await compileBagExecutionCandidates(intent, graph, [provider]);
    expect(signPlan).not.toHaveBeenCalled();
    expect(candidateSet.candidates[0].compiled?.transactions).toEqual([]);

    // ...then the user selects this provider, which triggers a FRESH
    // executable compile — never a re-use of the comparison result.
    const executable = await compileBagExecution(intent, graph, [provider]);
    expect(signPlan).toHaveBeenCalledTimes(1);
    expect(executable.transactions).toHaveLength(1);
    expect(executable.executionPlanHash).toBe(candidateSet.executionPlanHash);
  });

  it('existing fallback behavior is preserved: an ineligible router is simply absent from the candidate set, exactly as compileBagExecution() falls through to the next provider', async () => {
    const signPlan = vi.fn(async () => SIGNATURE);
    const routerProvider = new BagRouterProvider(makeConfig({ signPlan }));
    const fallback = {
      identify: () => 'fallback',
      getCapabilities: () => routerProvider.getCapabilities(),
      supports: () => true,
      compile: async (): Promise<CompiledExecution> => ({
        mode: 'MULTI_TX',
        chainId: 8453,
        transactions: [],
        expectedOutputs: [
          { legId: 'leg_0', asset: { chain: 'base', address: TARGET_A }, quotedOutputRaw: '1', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1' },
          { legId: 'leg_1', asset: { chain: 'base', address: TARGET_B }, quotedOutputRaw: '1', quotedOutputBasis: 'PROVIDER_QUOTE', minimumGuaranteedOutputRaw: '1' },
        ],
        providerId: 'fallback',
        executionPlanHash: 'x',
      }),
    };

    // Cross-chain graph: the router refuses it in supports() (same fixture
    // as the executable-path fallback test above).
    const graph = makeGraph();
    graph.legs[1].chain = 'arbitrum';

    const candidateSet = await compileBagExecutionCandidates(makeIntent(), graph, [routerProvider, fallback]);
    expect(candidateSet.candidates.map((c) => c.providerId)).toEqual(['fallback']);
    expect(signPlan).not.toHaveBeenCalled();

    const executable = await compileBagExecution(makeIntent(), graph, [routerProvider, fallback]);
    expect(executable.providerId).toBe('fallback');
    expect(signPlan).not.toHaveBeenCalled();
  });
});

describe('buildDefaultProviders — registry wiring', () => {
  it('does NOT register the router when it is not configured (deployment is unchanged from before item 7)', () => {
    const providers = buildDefaultProviders({});
    expect(providers.map((p) => p.identify())).not.toContain(BAG_ROUTER_PROVIDER_ID);
    expect(providers.map((p) => p.identify())).toEqual(['lifi-sequential']);
  });

  it('registers the router FIRST when configured, keeping LI.FI as the fallback tail', () => {
    const providers = buildDefaultProviders({ bagRouter: makeConfig() });
    expect(providers.map((p) => p.identify())).toEqual([BAG_ROUTER_PROVIDER_ID, 'lifi-sequential']);
  });

  it('keeps the existing Composer ordering intact when both are configured', () => {
    const providers = buildDefaultProviders({
      bagRouter: makeConfig(),
      lifiComposer: { apiKey: 'test-key' },
    });
    expect(providers.map((p) => p.identify())).toEqual([BAG_ROUTER_PROVIDER_ID, 'lifi-composer', 'lifi-sequential']);
  });
});
