import { ChainId, ExecutionStep } from '@/types/basket-protocol';
import { quoteRealSwapStep } from '@/lib/blockchain/lifi-purchase-quote';
import { toLiFiChainId } from '@/lib/blockchain/lifi-config';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution, ExpectedOutput } from '../types';
import { BagExecutionProvider, ProviderCapabilities } from './types';

// -----------------------------------------------------------------------------
// lib/execution/providers/lifi-sequential-provider.ts
//
// Adapts the EXISTING per-step LI.FI quoting logic
// (`lib/blockchain/lifi-purchase-quote.ts`'s `quoteRealSwapStep` — reused
// as-is, not reimplemented) to the `BagExecutionProvider` interface. Spec
// item 6: the fallback provider for cross-chain / unsupported-by-Composer
// purchases.
//
// PER-LEG FAILURE SEMANTICS — matches the pre-existing
// `buildPurchaseIntentSteps()` behavior exactly: `quoteRealSwapStep()`
// itself never throws (it catches internally and returns
// `{ ok: false, failureCode, message }`), so a single leg failing to quote
// does NOT abort the whole `compile()` call — every leg is still quoted in
// parallel, and the per-leg outcome (success or failure) is reported in
// `providerMetadata.legResults`, keyed by leg id. The bridge that turns a
// `CompiledExecution` back into `PurchaseIntentStepRecord[]`
// (`lib/execution/purchase-intent-bridge.ts`) reads THIS to build a FAILED
// step exactly where the legacy path would have, rather than the compiler
// throwing a generic `PROVIDER_COMPILE_FAILED` for what is really a
// per-leg, partially-successful outcome.
//
// KNOWN LIMITATION, stated plainly rather than papered over: this
// provider's `compile()` cannot return raw `{ to, data, value }`
// transactions the way the Composer provider can. Every existing LI.FI
// quote in this codebase (`lifiStep` on `PurchaseIntentStepRecord`) is
// deliberately opaque server-side and only ever turned into a real
// transaction by `@lifi/sdk`'s `convertQuoteToRoute()`/`executeRoute()`
// running in the BROWSER (see `hooks/use-purchase-execution.ts` and
// `types/purchase-intent.ts`'s own doc on `lifiStep`) — building that
// conversion server-side would duplicate wallet-signing logic that already
// exists on the client and is explicitly out of scope for this pass.
// `transactions` is therefore left EMPTY here; each leg's real, opaque
// `lifiStep` payload travels in `providerMetadata.legResults[legId]
// .lifiStep` straight into the existing `PurchaseIntentStepRecord.lifiStep`
// field via the bridge — the exact same value the legacy path already put
// there, just carried through one more layer.
// -----------------------------------------------------------------------------

const CAPABILITIES: ProviderCapabilities = {
  sameChain: true,
  crossChain: true,
  multiAsset: true,
  singleTransaction: false,
  requiresApproval: true,
  requiresMultipleSignatures: true,
  nativeAsset: true,
  erc20: true,
  atomic: false,
  supportsRecipient: false, // `quoteRealSwapStep` always sets `toAddress: walletAddress` — see that function's own doc.
  supportsPermit: false,
  supportsComposer: false,
};

export type LegQuoteResult =
  | {
      ok: true;
      outputAmountRaw: string;
      outputDecimals: number;
      minOutputRaw: string | null;
      route: string | null;
      lifiStep: unknown | null;
    }
  | { ok: false; failureCode: 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR'; message: string };

export class LiFiSequentialProvider implements BagExecutionProvider {
  identify(): string {
    return 'lifi-sequential';
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  supports(_intent: BagExecutionIntent, graph: BagExecutionGraph): boolean {
    // Deliberately does NOT reject a graph containing a Solana leg — this
    // is the universal fallback provider, and `quoteRealSwapStep()` (called
    // per-leg in `compile()`) already reports `UNSUPPORTED_ROUTE` for
    // exactly that leg on its own, without failing sibling legs in the same
    // batch. Rejecting the whole graph here would be a REGRESSION from the
    // legacy `buildPurchaseIntentSteps()` behavior, where a mixed batch
    // (one unsupported leg, others fine) still quotes every quotable leg.
    return graph.legs.length > 0;
  }

  async compile(_intent: BagExecutionIntent, graph: BagExecutionGraph): Promise<CompiledExecution> {
    const results = await Promise.all(
      graph.legs.map((leg) => quoteRealSwapStep(legToExecutionStep(leg), graph.wallet))
    );

    const expectedOutputs: ExpectedOutput[] = [];
    const legResults: Record<string, LegQuoteResult> = {};
    const crossChain = graph.legs.some((leg) => leg.sourceAsset.chain !== leg.targetAsset.chain);

    for (let i = 0; i < results.length; i++) {
      const leg = graph.legs[i];
      const result = results[i];
      if (result.ok) {
        legResults[leg.id] = {
          ok: true,
          outputAmountRaw: result.step.outputAmountRaw as string,
          outputDecimals: result.step.outputDecimals as number,
          minOutputRaw: result.step.minOutputRaw,
          route: result.step.route,
          lifiStep: result.step.lifiStep,
        };
        // LI.FI: `toAmount` is the route's quote; `toAmountMin` is the slippage floor the route enforces on-chain.
        expectedOutputs.push({
          legId: leg.id,
          asset: leg.targetAsset,
          quotedOutputRaw: result.step.outputAmountRaw ?? null,
          quotedOutputBasis: 'PROVIDER_QUOTE',
          minimumGuaranteedOutputRaw: result.step.minOutputRaw ?? null,
        });
      } else {
        // Reported, not thrown — see this file's module doc. No
        // `expectedOutputs` entry for a failed leg: there is nothing to
        // verify output against.
        legResults[leg.id] = { ok: false, failureCode: result.failureCode, message: result.message };
      }
    }

    return {
      mode: crossChain ? 'CROSS_CHAIN' : 'MULTI_TX',
      chainId: toLiFiChainId(graph.chainId),
      transactions: [], // See this file's module doc — every leg is client-executed via its opaque `lifiStep`.
      expectedOutputs,
      providerId: this.identify(),
      executionPlanHash: '', // Re-stamped by `compileBagExecution()`.
      providerMetadata: { legResults },
    };
  }
}

function legToExecutionStep(leg: BagExecutionGraph['legs'][number]): ExecutionStep {
  return {
    action: 'SWAP',
    targetSymbol: leg.targetAsset.address,
    route: {
      inputAsset: leg.sourceAsset,
      inputAmountRaw: leg.amountRaw,
      outputAsset: leg.targetAsset,
      targetValueRaw: leg.amountRaw,
      sourceChain: leg.sourceAsset.chain,
      destinationChain: leg.targetAsset.chain,
      slippageBps: leg.slippageBps,
    },
  };
}

export type { ChainId };
