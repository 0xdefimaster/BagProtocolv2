import { AssetIdentity, ExecutionPlan } from '@/types/basket-protocol';
import { PurchaseIntentStepRecord } from '@/types/purchase-intent';
import { ComposerTransactionSummary } from '@/lib/blockchain/lifi-purchase-quote';
import { CompiledExecution } from './types';
import { LegQuoteResult } from './providers/lifi-sequential-provider';
import { BAG_ROUTER_PROVIDER_ID } from './providers/bag-router-provider';

// -----------------------------------------------------------------------------
// lib/execution/purchase-intent-bridge.ts
//
// The seam between the new provider-independent `CompiledExecution` and the
// EXISTING `PurchaseIntent` persistence shape (`steps`, `composerTransaction`
// / `bagRouterTransaction` — types/purchase-intent.ts, unchanged otherwise).
// `lib/server/purchase-execution.ts` calls this INSTEAD of hand-rolling the
// mapping itself, so it never needs to know which provider produced
// `compiled` (spec item 6: "purchase-execution.ts provider-specific
// routing yapmasın") — this file is where that provider-specific knowledge
// (Composer's single shared tx, the BAG Router's single shared tx WITH a
// real enforced per-leg minimum, vs sequential's per-leg `lifiStep`) is
// allowed to live, same boundary `lib/blockchain/lifi-purchase-quote.ts`'s
// `tryBuildComposerSteps()` already drew for the pre-compiler path.
//
// PROVIDER IDENTITY, EXPLICIT (Bag Router execution hardening, checkpoint 1):
// this file branches on `compiled.providerId` — NEVER on `compiled.mode`.
// `mode === 'SINGLE_TX'` is true for BOTH `lifi-composer` AND `bag-router`,
// so mode alone cannot tell them apart; using it as the sole discriminator
// (as an earlier revision of this file did) silently mapped a BAG Router
// result into the Composer branch below — wrong on every axis: the
// Composer branch treats a leg's output as an unenforced SIMULATION
// (`minOutputRaw: null`), but the BAG Router
// contract enforces a REAL on-chain minimum for every leg, and a `null`
// `outputDecimals` step is silently excluded from `apply_purchase_execution`/
// `apply_partial_purchase_execution`'s holdings credit (purchase-execution.ts)
// — so a successfully-executed BAG Router purchase would never actually
// credit the depositor's bag. `providerId` is the fix: an explicit,
// unambiguous discriminant, never re-derived from a field two providers
// can share.
//
// EVERY provider's SWAP step must carry a real `outputDecimals`: the
// accounting RPC only credits holdings for steps that have one, while it
// mints the intent's shares regardless — a null there means shares with no
// backing assets on the books. Composer steps resolve it the same way the
// BAG Router branch does, and fail the leg rather than persist a null.
//
// Deliberately built from the ORIGINAL `ExecutionPlan` (not just the
// `BagExecutionGraph`) — a `BagExecutionGraph` only carries SWAP legs
// (`plan.ts`'s `buildBagExecutionGraph()` skips `KEEP` steps entirely), but
// a `PurchaseIntent.steps` array needs a full row for every allocation,
// `KEEP` included. This function re-walks `plan.steps` in original order
// and reattaches each `SWAP` step's compiled result by position — the same
// `leg_<N>` id scheme `buildBagExecutionGraph()` assigns (Nth SWAP step,
// zero-indexed) is recomputed here rather than imported, since the two
// functions necessarily agree on it by construction (same filter, same
// order, over the same `plan.steps`). `ExecutionPlan.inputAsset`/
// `inputAmountRaw` are also what `bagRouterTransaction`'s `inputToken`/
// `inputAmountRaw` (the client's ERC-20 approval target/floor) are read
// from — the BAG Router pulls exactly this asset/amount via `transferFrom`.
// -----------------------------------------------------------------------------

export interface CompiledExecutionToStepsResult {
  steps: PurchaseIntentStepRecord[];
  /** Mirrors `BuildPurchaseIntentStepsResult.allSwapsQuoted` (lifi-purchase-quote.ts) — true iff every SWAP step above ended up with a real, non-FAILED result. */
  allSwapsQuoted: boolean;
  firstFailure: { failureCode: 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR'; message: string } | null;
  composerTransaction: ComposerTransactionSummary | null;
  bagRouterTransaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    inputToken: string;
    inputAmountRaw: string;
    bagOnChainId: string;
  } | null;
}

export function compiledExecutionToPurchaseIntentSteps(
  plan: ExecutionPlan,
  compiled: CompiledExecution,
  /** A KEEP step's outputDecimals is always the (single) input asset's own decimals — same convention/reasoning as `buildPurchaseIntentSteps()`'s own `inputDecimals` parameter. */
  inputDecimals: number,
  /**
   * Resolves a target asset's decimals for a BAG Router or Composer leg —
   * REQUIRED because neither provider's step may persist a `null`
   * `outputDecimals` (see this file's own doc). Returning `null` from this
   * resolver is treated as a genuine failure for that leg — never silently
   * defaulted — since accounting cannot credit a decimals-less amount.
   * Unused for sequential legs, which take decimals from LI.FI's own quote.
   */
  resolveOutputDecimals: (asset: AssetIdentity) => number | null
): CompiledExecutionToStepsResult {
  const providerId = compiled.providerId;
  const isComposer = providerId === 'lifi-composer';
  const isBagRouter = providerId === BAG_ROUTER_PROVIDER_ID;
  const expectedByLegId = new Map(compiled.expectedOutputs.map((o) => [o.legId, o]));
  const legResults = (compiled.providerMetadata?.legResults as Record<string, LegQuoteResult> | undefined) ?? {};

  let swapIndex = 0;
  let firstFailure: { failureCode: 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR'; message: string } | null = null;

  const steps: PurchaseIntentStepRecord[] = plan.steps.map((step, stepIndex) => {
    if (step.action === 'KEEP') {
      return {
        stepIndex,
        action: 'KEEP',
        targetSymbol: step.targetSymbol,
        inputAsset: step.route.inputAsset,
        outputAsset: step.route.outputAsset,
        sourceChain: step.route.sourceChain,
        destinationChain: step.route.destinationChain,
        inputAmountRaw: step.route.inputAmountRaw,
        targetValueRaw: step.route.targetValueRaw,
        outputAmountRaw: null,
        outputDecimals: inputDecimals,
        minOutputRaw: null,
        route: null,
        lifiStep: null,
        status: 'NOT_NEEDED',
        approvalTxHash: null,
        txHash: null,
        providerSubstatus: null,
        failureCode: null,
      };
    }

    const legId = `leg_${swapIndex}`;
    swapIndex += 1;
    const base = {
      stepIndex,
      action: 'SWAP' as const,
      targetSymbol: step.targetSymbol,
      inputAsset: step.route.inputAsset,
      outputAsset: step.route.outputAsset,
      sourceChain: step.route.sourceChain,
      destinationChain: step.route.destinationChain,
      inputAmountRaw: step.route.inputAmountRaw,
      targetValueRaw: step.route.targetValueRaw,
      approvalTxHash: null,
      txHash: null,
      providerSubstatus: null,
      // Only a Composer step overrides this (below); BAG Router and
      // sequential steps never carry a provider-enforced minimum.
      providerEnforcedMinOutputRaw: null,
    };

    if (isComposer) {
      const expected = expectedByLegId.get(legId);
      if (!expected) {
        // Should not happen for a `mode: 'SINGLE_TX'` result the Composer
        // provider itself produced (every leg gets an entry) — handled
        // rather than assumed away, since this bridge must never silently
        // fabricate a PENDING step it has no data for.
        const failure = { failureCode: 'PROVIDER_ERROR' as const, message: `Composer result had no output for leg "${legId}".` };
        firstFailure = firstFailure ?? failure;
        return {
          ...base,
          outputAmountRaw: null,
          outputDecimals: null,
          minOutputRaw: null,
          route: null,
          lifiStep: null,
          status: 'FAILED' as const,
          failureCode: failure.failureCode,
        };
      }
      const composerOutputDecimals = resolveOutputDecimals(step.route.outputAsset);
      if (composerOutputDecimals === null) {
        const failure = {
          failureCode: 'PROVIDER_ERROR' as const,
          message: `Could not resolve decimals for Composer leg "${legId}" output ${step.route.outputAsset.chain}:${step.route.outputAsset.address}.`,
        };
        firstFailure = firstFailure ?? failure;
        return {
          ...base,
          outputAmountRaw: null,
          outputDecimals: null,
          minOutputRaw: null,
          route: null,
          lifiStep: null,
          status: 'FAILED' as const,
          failureCode: failure.failureCode,
        };
      }
      return {
        ...base,
        // `outputAmountRaw` is Composer's simulated (expected) output. Each
        // leg's swap IS protected on chain by LI.FI's own `amountOutMin`,
        // recorded as `providerEnforcedMinOutputRaw` — the provider's floor
        // at the swap boundary, not what is guaranteed to reach the wallet.
        // So BAG's own `minOutputRaw` stays `null` and verification checks
        // the receipt's actual transfers, exactly as before. `route` /
        // `lifiStep` stay `null` (no per-leg LI.FI route exists for a
        // shared Composer transaction). `outputDecimals` is real — see this
        // file's header.
        outputAmountRaw: expected.quotedOutputRaw,
        outputDecimals: composerOutputDecimals,
        minOutputRaw: null,
        providerEnforcedMinOutputRaw: expected.providerEnforcedMinOutputRaw ?? null,
        route: null,
        lifiStep: null,
        status: 'PENDING' as const,
        failureCode: null,
      };
    }

    if (isBagRouter) {
      const expected = expectedByLegId.get(legId);
      if (!expected) {
        // Should not happen — `bag-router-provider.ts`'s `compile()`
        // always emits one `ExpectedOutput` per graph leg — handled rather
        // than assumed away, same reasoning as Composer's identical guard
        // above.
        const failure = { failureCode: 'PROVIDER_ERROR' as const, message: `BAG Router result had no output for leg "${legId}".` };
        firstFailure = firstFailure ?? failure;
        return {
          ...base,
          outputAmountRaw: null,
          outputDecimals: null,
          minOutputRaw: null,
          route: null,
          lifiStep: null,
          status: 'FAILED' as const,
          failureCode: failure.failureCode,
        };
      }
      const outputDecimals = resolveOutputDecimals(step.route.outputAsset);
      if (outputDecimals === null) {
        // Never fabricate/default a decimals value — a registry-validated
        // graph should always resolve this, so hitting it is a real bug,
        // surfaced as an ordinary provider failure rather than silently
        // persisting a step accounting can never credit (item 5).
        const failure = {
          failureCode: 'PROVIDER_ERROR' as const,
          message: `Could not resolve output decimals for asset ${step.route.outputAsset.address} on leg "${legId}".`,
        };
        firstFailure = firstFailure ?? failure;
        return {
          ...base,
          outputAmountRaw: null,
          outputDecimals: null,
          minOutputRaw: null,
          route: null,
          lifiStep: null,
          status: 'FAILED' as const,
          failureCode: failure.failureCode,
        };
      }
      return {
        ...base,
        // The BAG Router contract ENFORCES this minimum on-chain, on the
        // router's own received balance (`InsufficientOutput` revert —
        // contracts/BagExecutionRouter.sol) — BAG's own floor, so, unlike a
        // Composer step (whose only on-chain floor is the provider's, at the
        // swap boundary), `minOutputRaw` and `outputDecimals` are real here,
        // never `null`. `outputAmountRaw` starts as the same quoted
        // minimum and is overwritten with the ACTUAL on-chain-received
        // amount once `verifyExecution()`/`trackBagRouterTransaction()`
        // confirms it (lib/blockchain/bag-router-status.ts) — same
        // "estimate until verified" convention the sequential path already
        // uses for `legResult.outputAmountRaw`.
        // Kept at the GUARANTEED floor (not the quote): accounting may fall back to this
        // pre-verification figure (purchase-execution.ts), so it must never over-state.
        outputAmountRaw: expected.minimumGuaranteedOutputRaw,
        outputDecimals,
        minOutputRaw: expected.minimumGuaranteedOutputRaw,
        route: null,
        lifiStep: null,
        status: 'PENDING' as const,
        failureCode: null,
      };
    }

    const legResult = legResults[legId];
    if (!legResult || !legResult.ok) {
      const failure = legResult && !legResult.ok
        ? { failureCode: legResult.failureCode, message: legResult.message }
        : { failureCode: 'PROVIDER_ERROR' as const, message: `No quote result for leg "${legId}".` };
      firstFailure = firstFailure ?? failure;
      return {
        ...base,
        outputAmountRaw: null,
        outputDecimals: null,
        minOutputRaw: null,
        route: null,
        lifiStep: null,
        status: 'FAILED' as const,
        failureCode: failure.failureCode,
      };
    }

    return {
      ...base,
      outputAmountRaw: legResult.outputAmountRaw,
      outputDecimals: legResult.outputDecimals,
      minOutputRaw: legResult.minOutputRaw,
      route: legResult.route,
      lifiStep: legResult.lifiStep,
      status: 'PENDING' as const,
      failureCode: null,
    };
  });

  const composerTransaction: ComposerTransactionSummary | null = isComposer
    ? {
        to: compiled.transactions[0]?.to ?? '',
        data: compiled.transactions[0]?.data ?? '',
        value: compiled.transactions[0]?.value ?? '0',
        chainId: compiled.chainId,
        userProxy: (compiled.providerMetadata?.userProxy as string | undefined) ?? '',
        approvals: (compiled.providerMetadata?.approvals as ComposerTransactionSummary['approvals']) ?? [],
      }
    : null;

  const bagRouterTransaction = isBagRouter
    ? {
        to: compiled.transactions[0]?.to ?? '',
        data: compiled.transactions[0]?.data ?? '',
        value: compiled.transactions[0]?.value ?? '0',
        chainId: compiled.chainId,
        inputToken: plan.inputAsset.address,
        inputAmountRaw: plan.inputAmountRaw,
        bagOnChainId:
          ((compiled.providerMetadata?.signedPlan as { bagId?: string } | undefined)?.bagId as string | undefined) ?? '',
      }
    : null;

  return {
    steps,
    allSwapsQuoted: firstFailure === null,
    firstFailure,
    composerTransaction,
    bagRouterTransaction,
  };
}

