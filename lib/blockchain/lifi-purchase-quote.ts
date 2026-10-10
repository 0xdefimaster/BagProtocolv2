import { getQuote } from '@lifi/sdk';
import { ChainId, ExecutionStep } from '@/types/basket-protocol';
import { ComposerFallbackNotice, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import { getLiFiClient, toLiFiChainId } from './lifi-config';
import { getLiFiTokenData } from './lifi-token-data';
import { mapLiFiError } from './lifi-execution-adapter';
import { isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import { buildComposerPurchase, composerLegEnforcedMinOutputRaw, composerLegSimulatedOutputRaw, ComposerIneligibleError, ComposerPurchaseLeg, isComposerEligible } from './lifi-composer-adapter';

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 1/4: "fromAddress placeholder tamamen kaldırılacak.
// Gerçek wallet address kullanılacak." This module is DELIBERATELY separate
// from lifi-execution-adapter.ts (Phase 14): that adapter still exists,
// unchanged, and still backs Purchase Preview's `?quotes=true` allocation
// display for a wallet that isn't connected yet (PLACEHOLDER_ADDRESS is
// still exactly right for "show me roughly what this would cost" before
// any wallet is involved). This module is ONLY called once, at
// PurchaseIntent-creation time (lib/server/purchase-execution.ts), when a
// real session + real connected wallet address already exist — every quote
// it produces is fromAddress = the actual signing wallet, and every
// resulting `LiFiStep` is what will actually be executed, not a display
// estimate.
//
// Chain support: this protocol's only real wallet today is an EIP-1193 EVM
// wallet (lib/wallet-context.tsx — no Solana wallet-adapter connection
// exists anywhere in this codebase). A step whose source OR destination
// chain is 'solana' is therefore rejected here with `UNSUPPORTED_ROUTE`
// rather than silently reusing the EVM address as a Solana address (which
// would not be a valid Solana public key and would either error inside
// LI.FI or, worse, resolve to nothing meaningful) — documented limitation,
// not a bug: adding real Solana execution needs a Solana wallet connection
// in lib/wallet-context.tsx first, which is out of scope for this phase.
// -----------------------------------------------------------------------------

export interface RealSwapQuoteResult {
  ok: true;
  step: Pick<
    PurchaseIntentStepRecord,
    'outputAmountRaw' | 'outputDecimals' | 'minOutputRaw' | 'route' | 'lifiStep'
  >;
}
export interface RealSwapQuoteFailure {
  ok: false;
  failureCode: 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR';
  message: string;
}

// Exported (previously module-private) so `lib/execution/providers/
// lifi-sequential-provider.ts` can reuse the exact same per-step quoting
// logic instead of re-implementing it against `@lifi/sdk` a second time —
// no behavior change, just a visibility change on an existing function.
export async function quoteRealSwapStep(
  step: ExecutionStep,
  walletAddress: string
): Promise<RealSwapQuoteResult | RealSwapQuoteFailure> {
  if (step.route.sourceChain === 'solana' || step.route.destinationChain === 'solana') {
    return {
      ok: false,
      failureCode: 'UNSUPPORTED_ROUTE',
      message: 'This route involves Solana, which has no connected wallet in this deployment yet.',
    };
  }

  try {
    const client = getLiFiClient();
    const fromChainId = toLiFiChainId(step.route.sourceChain);
    const toChainId = toLiFiChainId(step.route.destinationChain);

    const lifiStep = await getQuote(client, {
      fromChain: fromChainId,
      toChain: toChainId,
      // Registry-resolved addresses only — never a symbol, same invariant
      // as lifi-execution-adapter.ts (spec section 6, still true here).
      fromToken: step.route.inputAsset.address,
      toToken: step.route.outputAsset.address,
      fromAmount: step.route.inputAmountRaw,
      // THE fix this phase makes: real connected wallet address, not
      // PLACEHOLDER_ADDRESS. Same address used for `toAddress` — see this
      // file's module doc on why a different recipient isn't supported yet.
      fromAddress: walletAddress,
      toAddress: walletAddress,
      slippage: step.route.slippageBps !== undefined ? step.route.slippageBps / 10000 : undefined,
    });

    // The quote already carries both tokens (with priceUSD): seed the shared
    // LI.FI token cache so valuation does not fetch them a second time.
    getLiFiTokenData().prime(lifiStep.action?.fromToken);
    getLiFiTokenData().prime(lifiStep.action?.toToken);

    return {
      ok: true,
      step: {
        outputAmountRaw: lifiStep.estimate.toAmount,
        outputDecimals: lifiStep.action.toToken.decimals,
        minOutputRaw: lifiStep.estimate.toAmountMin,
        route: lifiStep.tool,
        lifiStep,
      },
    };
  } catch (err) {
    const mapped = mapLiFiError(err);
    const failureCode = mapped.code === 'UNSUPPORTED_ROUTE' ? 'UNSUPPORTED_ROUTE' : 'PROVIDER_ERROR';
    return { ok: false, failureCode, message: mapped.message };
  }
}

/**
 * Default per-leg slippage tolerance for a Composer-executed deposit, in
 * basis points (100 = 1%). The sequential LI.FI path doesn't need an
 * equivalent constant — its slippage comes back as part of each
 * `LiFiStep` quote itself (`step.route.slippageBps`, set upstream in
 * execution-plan.ts) — but Composer's `lifi.swap` op takes slippage as an
 * explicit per-swap input the caller must supply, so this needs a real
 * default rather than inventing one silently inside
 * `tryBuildComposerSteps()`. 1% matches this project's other DeFi-typical
 * defaults (see lifi-composer-adapter.test.ts's own examples) — revisit
 * per-bag/per-asset if that turns out too tight for a volatile target.
 */
export const DEFAULT_COMPOSER_SLIPPAGE_BPS = 100;

/** Upper bound on one Composer compile before falling back to sequential quotes. */
export const COMPOSER_COMPILE_TIMEOUT_MS = 15_000;

export interface ComposerTransactionSummary {
  to: string;
  data: string;
  value: string;
  chainId: number;
  /** The Composer execution proxy this transaction runs through — see lifi-composer-adapter.ts's ComposerPurchaseResult doc for why this is surfaced rather than hidden. */
  userProxy: string;
  /** ERC-20 approvals to send before this transaction (input token only) — see ComposerPurchaseResult.approvals. */
  approvals?: { token: string; spender: string; amountRaw: string }[];
}

export interface BuildPurchaseIntentStepsResult {
  steps: PurchaseIntentStepRecord[];
  /** True iff every SWAP step quoted successfully — the intent-creation caller sets the intent's overall status/failureCode from this. */
  allSwapsQuoted: boolean;
  firstFailure: { failureCode: 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR' | 'SLIPPAGE_EXCEEDED'; message: string } | null;
  /**
   * Non-null iff every SWAP step above was executed as ONE shared Composer
   * transaction (lifi-composer-adapter.ts) rather than N independent LI.FI
   * routes. When present, every SWAP step's `lifiStep` is null — there is
   * no per-step route to replay client-side; this field is what the
   * wallet actually signs ONCE, and its result (a single tx hash) is what
   * gets reported back for every SWAP step index, not one hash per step.
   * Always null when `composerOptions` wasn't passed in (redeem-execution
   * .ts never passes it — see this function's own doc for why).
   */
  composerTransaction: ComposerTransactionSummary | null;
  /** Set when Composer was attempted and refused. The purchase then FAILS (no per-asset fallback): a price-impact refusal is shown to the buyer, who may accept it and retry as one transaction. */
  composerFallback?: ComposerFallbackNotice | null;
}

/**
 * Reads LI.FI Composer's refusal message into a notice. Only the figures
 * Composer itself printed are used, e.g.
 * "Price impact 551 bps exceeds maximum 500 bps (input: $0.9991, output: $0.9440)".
 */
export function parseComposerFallback(message: string): ComposerFallbackNotice {
  const impact = message.match(/price impact\s+(\d+)\s*bps\s+exceeds\s+maximum\s+(\d+)\s*bps/i);
  const input = message.match(/input:\s*\$([\d.]+)/i);
  const output = message.match(/output:\s*\$([\d.]+)/i);
  return {
    reason: impact ? 'PRICE_IMPACT' : 'UNAVAILABLE',
    message,
    priceImpactBps: impact ? Number(impact[1]) : null,
    maxPriceImpactBps: impact ? Number(impact[2]) : null,
    inputUsd: input ? input[1] : null,
    outputUsd: output ? output[1] : null,
  };
}

/**
 * Opt-in only — `redeem-execution.ts` calls `buildPurchaseIntentSteps`
 * without this and must keep doing so: a redemption's SWAP steps have
 * DIFFERENT `inputAsset`s per step (selling several distinct holdings into
 * one output — see redeem/allocation.ts), the opposite shape from what
 * lifi-composer-adapter.ts's cascading-split fan-out (one input, N
 * outputs) was built for. Passing this to a redeem call wouldn't just be
 * unnecessary, it would silently attempt to build a nonsensical flow —
 * the eligibility check below only tests for a matching output chain per
 * leg, not that every leg SHARES ONE input, so a redeem call sneaking
 * this in is exactly the mistake `tryBuildComposerSteps`'s own same-input
 * check exists to catch, but doesn't rely on catching alone: this stays a
 * deposit-only, explicitly-passed parameter, not an auto-detected one.
 */
export interface ComposerAttemptOptions {
  apiKey: string;
  slippageBps: number;
  /**
   * Decimals of each leg's output asset (from the recipe). Composer does not
   * report them, and a SWAP step without decimals is left out of the holdings
   * credit while shares are still minted — so if any leg cannot be resolved,
   * Composer is skipped and the sequential path (which gets decimals from
   * LI.FI) is used instead.
   */
  resolveOutputDecimals: (asset: ExecutionStep['route']['outputAsset']) => number | null;
  /** Passed to Composer as its price-impact limit; set only after the buyer accepted a reported impact. */
  maxPriceImpactBps?: number;
}

/**
 * Attempts to build every SWAP step's execution data as ONE Composer
 * transaction instead of N separate LI.FI quotes. Never throws. Returns
 * `null` when Composer does not apply at all (ineligible chain, mixed input
 * assets, no SWAP steps, unknown output decimals) — those purchases keep the
 * sequential path. When Composer applies but refuses (price impact over its
 * limit, network error, simulation failure, timeout) it returns the reason
 * as `{ composerFallback }` and the purchase fails instead of silently
 * becoming one transaction per asset.
 */
async function tryBuildComposerSteps(
  steps: ExecutionStep[],
  walletAddress: string,
  inputDecimals: number,
  options: ComposerAttemptOptions
): Promise<BuildPurchaseIntentStepsResult | { composerFallback: ComposerFallbackNotice } | null> {
  const swapSteps = steps.filter((s) => s.action === 'SWAP');
  if (swapSteps.length === 0) return null;

  const outputDecimalsByStep = new Map<ExecutionStep, number>();
  for (const s of swapSteps) {
    const decimals = options.resolveOutputDecimals(s.route.outputAsset);
    if (decimals === null) return null;
    outputDecimalsByStep.set(s, decimals);
  }

  const inputAsset = swapSteps[0].route.inputAsset;
  const sameInputAsset = swapSteps.every(
    (s) => s.route.inputAsset.chain === inputAsset.chain && s.route.inputAsset.address === inputAsset.address
  );
  if (!sameInputAsset) return null;
  // Composer only pulls an ERC-20 input; a native-ETH payment takes the
  // sequential LI.FI path, where each swap sends its ETH as the tx value.
  if (isNativeAssetIdentity(inputAsset)) return null;

  const chain = swapSteps[0].route.sourceChain;
  const sameChain = swapSteps.every((s) => s.route.sourceChain === chain && s.route.destinationChain === chain);
  if (!sameChain) return null;

  const totalInputRaw = swapSteps.reduce((sum, s) => sum + BigInt(s.route.inputAmountRaw), BigInt(0));
  if (totalInputRaw === BigInt(0)) return null;

  // bps per leg from the SAME per-leg raw amounts calculateDepositAllocation
  // already computed — this reuses the existing allocation math verbatim,
  // it does not recompute weights independently. The last leg absorbs
  // whatever's left after the others round down, so the legs' bps always
  // sum to exactly 10000 regardless of integer-division remainder — same
  // "dust lands on the last leg" choice lifi-composer-adapter.ts's own
  // cascading split already makes, applied one level up here too.
  let assignedBps = 0;
  const legs: ComposerPurchaseLeg[] = swapSteps.map((s, i) => {
    const isLast = i === swapSteps.length - 1;
    const bps = isLast
      ? 10000 - assignedBps
      : Number((BigInt(s.route.inputAmountRaw) * BigInt(10000)) / totalInputRaw);
    if (!isLast) assignedBps += bps;
    return { address: s.route.outputAsset.address, weightBps: bps, symbol: s.targetSymbol };
  });

  if (!isComposerEligible(chain as ChainId, legs) || legs.some((l) => l.weightBps <= 0)) return null;

  let composerResult;
  try {
    // Capped so a stuck Composer compile fails with a reason the buyer can
    // retry, instead of keeping them waiting for the wallet prompt.
    let timer: ReturnType<typeof setTimeout> | undefined;
    composerResult = await Promise.race([
      buildComposerPurchase({
        chain: chain as ChainId,
        inputTokenAddress: inputAsset.address,
        inputAmountRaw: totalInputRaw.toString(),
        legs,
        signerAddress: walletAddress,
        slippageBps: options.slippageBps,
        apiKey: options.apiKey,
        ...(options.maxPriceImpactBps !== undefined ? { maxPriceImpactBps: options.maxPriceImpactBps } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Composer compile took longer than ${COMPOSER_COMPILE_TIMEOUT_MS}ms`)), COMPOSER_COMPILE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    if (err instanceof ComposerIneligibleError) return null;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[composer] single-transaction route refused: ${message}`);
    // A real Composer refusal (price impact, network, simulation revert,
    // timeout). Returned as-is so the buyer sees why; no per-asset fallback.
    return { composerFallback: parseComposerFallback(message) };
  }

  const stepRecords: PurchaseIntentStepRecord[] = steps.map((step, stepIndex) => {
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

    const legIndex = swapSteps.indexOf(step);
    const simulatedOut = composerLegSimulatedOutputRaw(composerResult.producedResources, legIndex);

    return {
      stepIndex,
      action: 'SWAP',
      targetSymbol: step.targetSymbol,
      inputAsset: step.route.inputAsset,
      outputAsset: step.route.outputAsset,
      sourceChain: step.route.sourceChain,
      destinationChain: step.route.destinationChain,
      inputAmountRaw: step.route.inputAmountRaw,
      targetValueRaw: step.route.targetValueRaw,
      // Simulated, not guaranteed — same caveat as a normal LI.FI quote's
      // outputAmountRaw. Falls back to the pre-allocation target value
      // only if Composer's simulation genuinely omitted this leg (should
      // not happen for a 'success' compile, but this never fabricates a
      // number it doesn't have either way).
      outputAmountRaw: simulatedOut,
      outputDecimals: outputDecimalsByStep.get(step) ?? null,
      // BAG's own floor stays unset; the swap's on-chain floor is the
      // provider's (see composerLegEnforcedMinOutputRaw) and is recorded
      // separately, never used for verification.
      minOutputRaw: null,
      providerEnforcedMinOutputRaw: composerLegEnforcedMinOutputRaw(composerResult.producedResources, legIndex),
      route: null,
      // No per-step LI.FI route — see this type's own doc comment on why
      // `lifiStep` is null whenever `composerTransaction` is set.
      lifiStep: null,
      status: 'PENDING',
      approvalTxHash: null,
      txHash: null,
      providerSubstatus: null,
      failureCode: null,
    };
  });

  return {
    steps: stepRecords,
    allSwapsQuoted: true,
    firstFailure: null,
    composerTransaction: {
      to: composerResult.transactionRequest.to,
      data: composerResult.transactionRequest.data,
      value: composerResult.transactionRequest.value,
      chainId: composerResult.transactionRequest.chainId ?? toLiFiChainId(chain as ChainId),
      userProxy: composerResult.userProxy,
      approvals: composerResult.approvals,
    },
  };
}

/**
 * Quotes every SWAP step of `steps` against the REAL connected wallet
 * address, in parallel — the Phase 17 counterpart to
 * `liFiExecutionAdapter.quoteExecutionPlan()`. KEEP steps are never quoted
 * (same convention as Phase 14) and are recorded as `NOT_NEEDED` — nothing
 * to sign, nothing to execute.
 *
 * Takes `ExecutionStep[]` directly (not a whole `ExecutionPlan`) — this
 * function only ever read `plan.steps`, never `plan.bagId`/`inputAsset`/
 * `inputAmountRaw`/`unallocatedRaw`, so narrowing the parameter to just
 * the steps is a pure simplification (deposit callers now pass
 * `executionPlan.steps`, unchanged behavior). This also lets Phase 21's
 * redeem flow reuse this same function: a redemption's steps span
 * multiple distinct SOURCE assets (see redeem/allocation.ts), so it has
 * no single top-level `inputAsset`/`inputAmountRaw` an `ExecutionPlan`
 * would require it to fabricate.
 *
 * `composerOptions` — deposit-only, see `ComposerAttemptOptions`'s own
 * doc for why `redeem-execution.ts` must never pass this.
 */
export async function buildPurchaseIntentSteps(
  steps: ExecutionStep[],
  walletAddress: string,
  /** A KEEP step's `outputAsset === inputAsset` by construction (see execution-plan.ts / redeem/allocation.ts), so its accounting-relevant decimals are exactly this asset's own decimals, never something LI.FI reports (KEEP steps are never quoted). For a deposit, this is the single input asset's decimals; for a redemption, the single output asset's decimals — either way, the one asset every KEEP step in this batch necessarily equals. */
  inputDecimals: number,
  composerOptions?: ComposerAttemptOptions
): Promise<BuildPurchaseIntentStepsResult> {
  if (composerOptions) {
    const composerAttempt = await tryBuildComposerSteps(steps, walletAddress, inputDecimals, composerOptions);
    if (composerAttempt && 'steps' in composerAttempt) return composerAttempt;
    if (composerAttempt) {
      // Composer was eligible but refused. Never degrade to one transaction
      // per asset: the caller fails this intent and the buyer decides
      // (accept the reported price impact and retry as one transaction).
      const notice = composerAttempt.composerFallback;
      return {
        steps: [],
        allSwapsQuoted: false,
        firstFailure: { failureCode: notice.reason === 'PRICE_IMPACT' ? 'SLIPPAGE_EXCEEDED' : 'PROVIDER_ERROR', message: notice.message },
        composerTransaction: null,
        composerFallback: notice,
      };
    }
  }

  const results = await Promise.all(
    steps.map(async (step, stepIndex): Promise<PurchaseIntentStepRecord> => {
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

      const quoted = await quoteRealSwapStep(step, walletAddress);
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
      };

      if (!quoted.ok) {
        return {
          ...base,
          outputAmountRaw: null,
          outputDecimals: null,
          minOutputRaw: null,
          route: null,
          lifiStep: null,
          status: 'FAILED',
          failureCode: quoted.failureCode,
        };
      }

      return {
        ...base,
        outputAmountRaw: quoted.step.outputAmountRaw,
        outputDecimals: quoted.step.outputDecimals,
        minOutputRaw: quoted.step.minOutputRaw,
        route: quoted.step.route,
        lifiStep: quoted.step.lifiStep,
        status: 'PENDING',
        failureCode: null,
      };
    })
  );

  const failed = results.find((r) => r.action === 'SWAP' && r.status === 'FAILED');

  return {
    steps: results,
    allSwapsQuoted: !failed,
    firstFailure: failed
      ? { failureCode: (failed.failureCode as 'UNSUPPORTED_ROUTE' | 'PROVIDER_ERROR') ?? 'PROVIDER_ERROR', message: 'One or more swap routes could not be quoted for your wallet.' }
      : null,
    composerTransaction: null,
  };
}
