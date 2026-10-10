import { ChainId } from '@/types/basket-protocol';
import {
  buildComposerPurchase,
  COMPOSER_ELIGIBLE_CHAINS,
  ComposerPurchaseLeg,
  composerLegEnforcedMinOutputRaw,
  composerLegSimulatedOutputRaw,
  isComposerEligible,
} from '@/lib/blockchain/lifi-composer-adapter';
import { toLiFiChainId } from '@/lib/blockchain/lifi-config';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution, ExpectedOutput } from '../types';
import { BagExecutionProvider, ProviderCapabilities } from './types';

// -----------------------------------------------------------------------------
// lib/execution/providers/lifi-composer-provider.ts
//
// Adapts the EXISTING `lib/blockchain/lifi-composer-adapter.ts`
// (`buildComposerPurchase`, `isComposerEligible`, `COMPOSER_ELIGIBLE_CHAINS`
// — none of it modified) to the `BagExecutionProvider` interface. Spec item
// 5: "BAG Compiler → LiFiComposerProvider → mevcut buildComposerPurchase()."
//
// Only handles the flat "one ERC-20 input, N ERC-20-target legs, all on the
// same chain" shape the underlying adapter itself supports — see
// `supports()` below, which mirrors `isComposerEligible()` plus the extra
// "all legs share the same input asset" check the underlying adapter's
// cascading-split fan-out requires (its own module doc: "one input, N
// outputs").
// -----------------------------------------------------------------------------

const CAPABILITIES: ProviderCapabilities = {
  sameChain: true,
  crossChain: false,
  multiAsset: true,
  singleTransaction: true,
  requiresApproval: true, // Composer's own on-chain-allowance check (`checkOnChainAllowances`) may still require one; see `buildComposerPurchase`'s own comment.
  requiresMultipleSignatures: false,
  nativeAsset: true, // ERC-20 inputs (`resources.erc20`) and native ETH (`resources.native`, sent as the tx value).
  erc20: true,
  atomic: true,
  supportsRecipient: false, // `sweepTo: { $ref: 'context.sender' }` is hardcoded in the underlying adapter.
  supportsPermit: false,
  supportsComposer: true,
};

export interface LiFiComposerProviderConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class LiFiComposerProvider implements BagExecutionProvider {
  constructor(private readonly config: LiFiComposerProviderConfig) {}

  identify(): string {
    return 'lifi-composer';
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  supports(_intent: BagExecutionIntent, graph: BagExecutionGraph): boolean {
    if (!COMPOSER_ELIGIBLE_CHAINS.includes(graph.chainId)) return false;
    if (graph.legs.length === 0) return false;
    // Cascading-split fan-out needs exactly one shared input asset.
    const firstInput = graph.legs[0].sourceAsset;
    const sameInput = graph.legs.every(
      (leg) => leg.sourceAsset.chain === firstInput.chain && leg.sourceAsset.address === firstInput.address
    );
    if (!sameInput) return false;
    const legs = toComposerLegs(graph);
    return isComposerEligible(graph.chainId, legs);
  }

  async compile(_intent: BagExecutionIntent, graph: BagExecutionGraph): Promise<CompiledExecution> {
    const legs = toComposerLegs(graph);
    const inputAsset = graph.legs[0].sourceAsset;
    const uniformSlippageBps = graph.legs[0].slippageBps;

    const result = await buildComposerPurchase({
      chain: graph.chainId,
      inputTokenAddress: inputAsset.address,
      inputAmountRaw: graph.inputAmountRaw,
      legs,
      signerAddress: graph.wallet,
      slippageBps: uniformSlippageBps,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      fetchImpl: this.config.fetchImpl,
    });

    const expectedOutputs: ExpectedOutput[] = [];
    // Keyed by leg id — see providers/types.ts and this provider's own
    // note in purchase-intent-bridge.ts: the ONLY place a caller should
    // read per-leg detail back out of a `CompiledExecution`, never a
    // provider-specific type reaching outside `lib/execution/`. Mirrors
    // EXACTLY what `tryBuildComposerSteps()` (lifi-purchase-quote.ts)
    // already puts on a `PurchaseIntentStepRecord` for a Composer-built
    // step — `outputDecimals: null`, `route: null`, `lifiStep: null` — so
    // the bridge can reproduce that record without this provider knowing
    // `PurchaseIntentStepRecord` exists.
    const legQuotes: Record<string, { outputAmountRaw: string | null; outputDecimals: number | null; route: string | null; lifiStep: unknown | null }> = {};
    graph.legs.forEach((leg, index) => {
      const outputAmountRaw = composerLegSimulatedOutputRaw(result.producedResources, index);
      // `quotedOutputRaw` is the simulated (expected) output. The leg's swap
      // itself IS protected on chain — LI.FI's swap reverts below
      // `amountOutMin` — but that floor is the PROVIDER's, at the swap
      // boundary, so it goes in `providerEnforcedMinOutputRaw`, never in
      // `minimumGuaranteedOutputRaw` (BAG's own floor for what reaches the
      // wallet, which Composer does not give us).
      expectedOutputs.push({
        legId: leg.id,
        asset: leg.targetAsset,
        quotedOutputRaw: outputAmountRaw,
        quotedOutputBasis: 'SIMULATION',
        minimumGuaranteedOutputRaw: null,
        providerEnforcedMinOutputRaw: composerLegEnforcedMinOutputRaw(result.producedResources, index),
      });
      legQuotes[leg.id] = { outputAmountRaw, outputDecimals: null, route: null, lifiStep: null };
    });

    return {
      mode: 'SINGLE_TX',
      chainId: toLiFiChainId(graph.chainId),
      transactions: [
        {
          to: result.transactionRequest.to,
          data: result.transactionRequest.data,
          value: result.transactionRequest.value,
          chainId: result.transactionRequest.chainId ?? toLiFiChainId(graph.chainId),
        },
      ],
      expectedOutputs,
      providerId: this.identify(),
      executionPlanHash: '', // Re-stamped by `compileBagExecution()` — see that file's own comment.
      providerMetadata: {
        userProxy: result.userProxy,
        approvals: result.approvals,
        legQuotes,
        // Passthrough of the SAME compile() response above — see
        // lifi-composer-adapter.ts's `ComposerPurchaseResult` doc. Read by
        // candidate-metrics.ts's Composer-specific extraction; never
        // interpreted as `estimatedGasUsd` (gasLimitRaw is a gas UNIT
        // count, not USD — spec item 6's explicit warning).
        gasLimitRaw: result.gasLimitRaw,
        priceImpact: result.priceImpact,
        fees: result.fees,
      },
    };
  }
}

function toComposerLegs(graph: BagExecutionGraph): ComposerPurchaseLeg[] {
  return graph.legs.map((leg) => ({
    address: leg.targetAsset.address,
    weightBps: leg.weightBps,
    symbol: leg.targetAsset.address,
  }));
}

export type { ChainId };
