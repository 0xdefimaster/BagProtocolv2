import { BaseError, getQuote, HTTPError, LiFiErrorCode, SDKError } from '@lifi/sdk';
import { AssetIdentity, ChainId, ExecutionPlan } from '@/types/basket-protocol';
import {
  ExecutionAdapter,
  ExecutionQuoteError,
  ExecutionResult,
  ExecutionStepQuote,
  ExecutionStepResult,
} from './execution-adapter';
import { getLiFiClient, toLiFiChainId, UnsupportedChainError } from './lifi-config';

// -----------------------------------------------------------------------------
// Phase 14 — LI.FI Live Quote Adapter.
//
// Implements the SAME `ExecutionAdapter` interface `MockExecutionAdapter`
// already implements (execution-adapter.ts) — nothing upstream of
// `quoteExecutionPlan()` (buildExecutionPlan, calculateDepositAllocation,
// the `/purchase-preview` route) changes to use this. `quoteExecutionPlan()`
// ONLY calls LI.FI's `getQuote()` (a GET request under the hood) — see the
// module doc on execution-adapter.ts for the "quotes only, never signs or
// sends anything" guarantee this file upholds for real, not just in a mock.
//
// ## KEEP steps
// Never quoted — same as `MockExecutionAdapter` (spec section 5).
//
// ## Amount consolidation (spec section 14)
// No extra bookkeeping needed here: `ExecutionPlan.steps` already excludes
// every `KEEP` allocation's value (see execution-plan.ts) and this adapter
// quotes exactly the steps it's given — so the sum of every `SWAP` step's
// `inputAmountRaw` sent to LI.FI is, by construction, `plan.inputAmountRaw
// - (sum of every KEEP allocation's valueRaw) - plan.unallocatedRaw`, i.e.
// never more than what was actually deposited.
//
// ## fromAddress (spec: LI.FI requires a sending wallet address per quote)
// This phase has no connected wallet anywhere in the preview flow (Phase
// 12/13 — `computePurchasePreview()` never takes one, and no wallet-connect
// UI backs `PurchasePreviewModal`). `getQuote()` still requires SOME
// `fromAddress` to return a route. `PLACEHOLDER_ADDRESS` below is used
// instead — a well-known, non-owned address per chain family, NEVER a real
// user's wallet. This is a deliberate, documented limitation: LI.FI's
// balance/allowance-aware route choices (e.g. Permit2 usage) may differ
// slightly for a real wallet with an existing approval; the quoted
// price/route itself is not wallet-specific. See PHASE_14_REPORT.md,
// section "fromAddress", for the follow-up this implies once an execution
// phase actually connects a wallet.
// -----------------------------------------------------------------------------

/** Well-known "nobody owns this" addresses — used only as `fromAddress`/`toAddress` for a QUOTE request, never sent a transaction. */
const EVM_PLACEHOLDER_ADDRESS = '0x000000000000000000000000000000000000dEaD';
/** Solana's System Program id — a valid, well-known base58 address that owns no tokens; same "placeholder, not a real wallet" role as the EVM constant above. */
const SOLANA_PLACEHOLDER_ADDRESS = '11111111111111111111111111111111';

function placeholderAddressFor(chain: ChainId): string {
  return chain === 'solana' ? SOLANA_PLACEHOLDER_ADDRESS : EVM_PLACEHOLDER_ADDRESS;
}

/**
 * Maps any error `getQuote()` can throw to one of spec section 10's four
 * typed codes — the UI never sees a raw provider stack trace. Exported
 * (Phase 17) so `lib/blockchain/lifi-purchase-quote.ts` — the real-wallet
 * requoting path used when creating a `PurchaseIntent` — reuses the exact
 * same mapping rather than duplicating it for a second `getQuote()` call
 * site.
 */
export function mapLiFiError(err: unknown): ExecutionQuoteError {
  // The SDK's request layer rethrows HTTP failures wrapped in SDKError
  // (e.g. "[HTTPError] [NotFoundError] ... 404"), so classify the cause.
  if (err instanceof SDKError && err.cause) return mapLiFiError(err.cause);
  if (err instanceof HTTPError) {
    if (err.status === 404) {
      return { code: 'QUOTE_UNAVAILABLE', message: 'No route is currently available for this swap.' };
    }
    if (err.status === 400) {
      return { code: 'UNSUPPORTED_ROUTE', message: 'LI.FI rejected this swap request as invalid.' };
    }
    return { code: 'PROVIDER_ERROR', message: `LI.FI returned an unexpected error (HTTP ${err.status}).` };
  }
  if (err instanceof UnsupportedChainError) {
    return { code: 'INVALID_ASSET', message: err.message };
  }
  if (err instanceof BaseError) {
    switch (err.code) {
      case LiFiErrorCode.Timeout:
      case LiFiErrorCode.RpcUnavailable:
      case LiFiErrorCode.ProviderUnavailable:
      case LiFiErrorCode.RateLimitExceeded:
        return { code: 'PROVIDER_ERROR', message: err.message || 'LI.FI is temporarily unavailable.' };
      case LiFiErrorCode.ValidationError:
        return { code: 'UNSUPPORTED_ROUTE', message: err.message || 'This swap is not supported by LI.FI.' };
      case LiFiErrorCode.NotFound:
        return { code: 'QUOTE_UNAVAILABLE', message: err.message || 'No route found for this swap.' };
      default:
        return { code: 'PROVIDER_ERROR', message: err.message || 'LI.FI returned an unexpected error.' };
    }
  }
  if (err instanceof Error) {
    return { code: 'PROVIDER_ERROR', message: err.message || 'Unknown LI.FI error.' };
  }
  return { code: 'PROVIDER_ERROR', message: 'Unknown LI.FI error.' };
}

/** Sums a LI.FI `feeCosts`/`gasCosts`-shaped array's `amount` fields that are denominated in the SAME token — this phase only surfaces a total when every entry shares one token (mixed-token totals would not be a meaningful single raw number). Returns `null` if the array is empty/absent or spans more than one token. `address` is the raw LI.FI token address; the caller resolves it into this protocol's own `AssetIdentity` (it already knows which side — source/destination — the token belongs to; this helper only sums amounts, it never guesses a `ChainId`). */
function sumSingleTokenRawAmounts(
  entries: ReadonlyArray<{ amount?: string; token: { address: string; chainId: number } }> | undefined
): { amountRaw: string; address: string } | null {
  if (!entries || entries.length === 0) return null;
  const first = entries[0].token;
  const sameToken = entries.every((e) => e.token.address.toLowerCase() === first.address.toLowerCase() && e.token.chainId === first.chainId);
  if (!sameToken) return null;
  let total = BigInt(0);
  for (const e of entries) {
    if (!e.amount) return null;
    total += BigInt(e.amount);
  }
  return { amountRaw: total.toString(), address: first.address };
}

export async function quoteSwapStep(
  inputAsset: AssetIdentity,
  outputAsset: AssetIdentity,
  sourceChain: ChainId,
  destinationChain: ChainId,
  inputAmountRaw: string,
  slippageBps: number | undefined
): Promise<{ quote: ExecutionStepQuote | null; error: ExecutionQuoteError | null }> {
  try {
    const fromChainId = toLiFiChainId(sourceChain);
    const toChainId = toLiFiChainId(destinationChain);
    const client = getLiFiClient();

    const step = await getQuote(client, {
      fromChain: fromChainId,
      toChain: toChainId,
      // LI.FI's REST/SDK layer accepts a token symbol OR an address for
      // `fromToken`/`toToken` — this adapter ALWAYS sends the registry-
      // resolved `address` (never a symbol) per spec section 6: the
      // ExecutionPlan/ExecutionRouteRequest it was handed never carries a
      // symbol to begin with, only `AssetIdentity { chain, address }`.
      fromToken: inputAsset.address,
      toToken: outputAsset.address,
      fromAmount: inputAmountRaw,
      fromAddress: placeholderAddressFor(sourceChain),
      toAddress: placeholderAddressFor(destinationChain),
      slippage: slippageBps !== undefined ? slippageBps / 10000 : undefined,
    });

    const gas = sumSingleTokenRawAmounts(step.estimate.gasCosts);
    const fee = sumSingleTokenRawAmounts(step.estimate.feeCosts);

    const quote: ExecutionStepQuote = {
      provider: 'lifi',
      outputAmountRaw: step.estimate.toAmount,
      outputDecimals: step.action.toToken.decimals,
      // LI.FI's request-level `slippage` is a fraction (e.g. 0.005 = 0.5%);
      // `step.action.slippage` echoes back what was actually applied —
      // convert to bps for this field's existing convention.
      slippageBps: step.action.slippage !== undefined ? Math.round(step.action.slippage * 10000) : 0,
      // No protocol-level fee exists yet (spec section 13's own module doc,
      // types/basket-protocol.ts "Performance fee — NOT IMPLEMENTED") —
      // this stays "0" exactly like the mock adapter; LI.FI's OWN fee is
      // reported via `executionFeeRaw` below, never conflated with this.
      protocolFeeRaw: '0',
      executionFeeRaw: fee ? fee.amountRaw : '0',
      minOutputRaw: step.estimate.toAmountMin,
      route: step.tool,
      // LI.FI's /v1/quote does not return a top-level price-impact figure
      // as of this phase — never fabricated (see execution-adapter.ts's
      // module doc on this field).
      priceImpact: null,
      gasCostRaw: gas ? gas.amountRaw : null,
      gasCostAsset: gas ? { chain: sourceChain, address: gas.address } : null,
      timestamp: new Date().toISOString(),
    };

    return { quote, error: null };
  } catch (err) {
    return { quote: null, error: mapLiFiError(err) };
  }
}

/** Per-leg cap for preview quotes (quoteExecutionPlan). */
export const PREVIEW_QUOTE_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const liFiExecutionAdapter: ExecutionAdapter = {
  name: 'lifi',
  isLive: true,

  async quoteExecutionPlan(plan: ExecutionPlan): Promise<ExecutionResult> {
    const steps: ExecutionStepResult[] = await Promise.all(
      plan.steps.map(async (step): Promise<ExecutionStepResult> => {
        // KEEP steps are never swapped — nothing to ask LI.FI for (spec
        // section 5), same as MockExecutionAdapter.
        if (step.action === 'KEEP') {
          return { step, quote: null, error: null };
        }

        // One slow leg must not hold the whole preview hostage: past the
        // timeout it reports a PROVIDER_ERROR (never NO_ROUTE), like any
        // other transient LI.FI failure.
        const { quote, error } = await withTimeout(
          quoteSwapStep(
            step.route.inputAsset,
            step.route.outputAsset,
            step.route.sourceChain,
            step.route.destinationChain,
            step.route.inputAmountRaw,
            step.route.slippageBps
          ),
          PREVIEW_QUOTE_TIMEOUT_MS,
          { quote: null, error: { code: 'PROVIDER_ERROR', message: 'Getting a quote took too long. Try again.' } }
        );
        return { step, quote, error };
      })
    );

    return {
      bagId: plan.bagId,
      inputAsset: plan.inputAsset,
      inputAmountRaw: plan.inputAmountRaw,
      steps,
      unallocatedRaw: plan.unallocatedRaw,
    };
  },
};
