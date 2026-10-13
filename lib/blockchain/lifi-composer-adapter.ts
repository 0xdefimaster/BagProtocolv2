import { createComposeSdk, guards, materialisers, resources } from '@lifi/composer-sdk';
import type { Bindable, ComposeSdkOptions } from '@lifi/composer-sdk';
import type { ProducedResource } from '@lifi/compose-spec';
import { ChainId } from '@/types/basket-protocol';
import { toLiFiChainId } from './lifi-config';
import { packFeeRateAndDeadline } from '@/lib/blockchain/redeem-settlement-eip712';
import { isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';

// -----------------------------------------------------------------------------
// lifi-composer-adapter.ts — genuinely single-signature multi-asset purchase,
// via LI.FI's Composer product (`@lifi/composer-sdk`, real published package,
// verified against its actual installed type definitions before writing this
// file — not from memory or marketing copy alone).
//
// WHY THIS EXISTS: lifi-purchase-quote.ts (the existing path) builds one
// `getQuote()` per target asset, and hooks/use-purchase-execution.ts
// deliberately executes them ONE AT A TIME — N target assets means N wallet
// signatures. That is a real, previously-documented limitation (see
// docs/PHASE_19X_REPORT.md, V13_DURUM_RAPORU.md section K). Composer bundles
// multiple on-chain actions into ONE transaction, so a same-chain multi-asset
// Bag purchase can become ONE signature instead of N. This module is that
// alternate path — NOT a replacement for lifi-purchase-quote.ts, which
// remains the only option for cross-chain and Solana-target purchases (see
// ELIGIBLE eligibility check below).
//
// HOW THE FAN-OUT IS BUILT: Composer's `core.split` op only ever produces
// TWO outputs from ONE bps ratio (verified against
// node_modules/@lifi/composer-sdk/dist/generated/operations.generated.d.ts's
// own doc comment: "Split a resource into two outputs by basis-point ratio"
// — there is no N-way split op). An N-leg purchase is therefore built as a
// CASCADE of N-1 two-way splits, each one splitting off the next leg's share
// from whatever remains, with each step's bps recomputed relative to the
// REMAINING pool (not the original total) so the final percentages come out
// right. The very last leg consumes the final remainder directly with no
// split at all — this is also where any bps-rounding dust lands, rather than
// being silently lost or requiring a separate sweep-in step.
//
// WHAT THIS MODULE DOES NOT DO: sign or broadcast anything. It returns
// compiled calldata (`transactionRequest`) for the caller's wallet layer to
// sign — same boundary as lifi-execution-adapter.ts. It also does not touch
// BagFactory, Supabase, or any existing execution path; wiring this in as an
// actual alternative to the sequential path is a separate, deliberate
// integration decision for whoever calls this.
// -----------------------------------------------------------------------------

/**
 * Chains this module will build a Composer flow for. Deliberately NOT the
 * same list as `SUPPORTED_CHAINS` (types/basket-protocol.ts) — Composer's
 * own docs say "EVM chains only" with no other chain-specific allowlist
 * published, but that's a claim about the product in general, not a
 * per-chain guarantee this project has independently confirmed for each of
 * its own chains:
 *   - 'solana' — excluded. Composer's docs explicitly say non-EVM chains
 *     are not supported.
 *   - 'robinhood' — included. LI.FI announced Composer support on Robinhood
 *     Chain from its launch (July 2026, "LI.FI Is Live on Robinhood Chain
 *     from Day One", li.fi knowledge hub). A Composer flow that fails to
 *     compile or quote here still degrades to the sequential path (see
 *     tryBuildComposerSteps in lifi-purchase-quote.ts), so a gap in that
 *     support costs signatures, never funds.
 */
export const COMPOSER_ELIGIBLE_CHAINS: readonly ChainId[] = ['ethereum', 'base', 'arbitrum', 'robinhood'];

export interface ComposerPurchaseLeg {
  /** Target ERC-20 address for this leg. */
  address: string;
  /** This leg's share of the total input, in basis points. All legs' weightBps must sum to exactly 10000. */
  weightBps: number;
  /** For error messages only — not sent to Composer. */
  symbol: string;
}

export interface ComposerPurchaseRequest {
  chain: ChainId;
  /**
   * Input token address: an ERC-20 (pulled with `transferFrom` after an
   * approval), or the native sentinel (NATIVE_ASSET_ADDRESS) for a native-ETH
   * payment, which the transaction carries as its `value` — no approval.
   */
  inputTokenAddress: string;
  /** Raw input amount (token's smallest unit), as a decimal string. */
  inputAmountRaw: string;
  legs: ComposerPurchaseLeg[];
  /** The wallet that will sign the compiled transaction. */
  signerAddress: string;
  /** Per-leg slippage tolerance in basis points (e.g. 100 = 1%). Applied uniformly — callers wanting per-leg values should call this module once per distinct tolerance and merge, not something this module infers on its own. */
  slippageBps: number;
  /** Composer's whole-purchase price-impact limit in bps. Omitted = Composer's default (500). Raised only after the buyer accepted a reported impact. */
  maxPriceImpactBps?: number;
  /** REQUIRED — verified against the installed `@lifi/composer-sdk` package's own types, not assumed: unlike the plain LI.FI quote API, Composer rejects unauthenticated requests outright. `LIFI_API_KEY` (.env.example) must be set for this path to work at all — this is a real, new requirement this integration adds, not something the existing sequential lifi-purchase-quote.ts path needed. */
  apiKey: string;
  /** Defaults to Composer's production API (`https://composer.li.quest`) per docs.li.fi's quickstart. Override only for the documented ETHGlobal preview environment or in tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ComposerIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposerIneligibleError';
  }
}

/**
 * True only when a Composer flow can plausibly express this purchase as one
 * same-chain transaction: the chain is one this module has actually been
 * pointed at Composer for (see `COMPOSER_ELIGIBLE_CHAINS`'s doc comment),
 * and there's at least one leg. Callers should fall back to
 * lifi-purchase-quote.ts's sequential path whenever this returns false —
 * this function never throws, so it's safe to call speculatively before
 * deciding which path to build.
 */
export function isComposerEligible(chain: ChainId, legs: readonly ComposerPurchaseLeg[]): boolean {
  return COMPOSER_ELIGIBLE_CHAINS.includes(chain) && legs.length > 0;
}

/** Recomputes each leg's split-bps relative to the REMAINING pool at that cascade step, not the original total — see this file's header comment for why. Exported standalone (pure, no SDK calls) so the math can be unit-tested without mocking fetch. */
export function computeCascadeSplitBps(legs: readonly ComposerPurchaseLeg[]): number[] {
  const totalBps = legs.reduce((sum, leg) => sum + leg.weightBps, 0);
  if (totalBps !== 10000) {
    throw new Error(`Leg weights must sum to exactly 10000 bps, got ${totalBps}.`);
  }
  const splitBpsByStep: number[] = [];
  let remainingBps = 10000;
  // Only the first N-1 legs need a split step — the last leg consumes
  // whatever's left directly (see header comment).
  for (let i = 0; i < legs.length - 1; i++) {
    const leg = legs[i];
    const stepBps = Math.round((leg.weightBps / remainingBps) * 10000);
    // Clamp defensively against floating-point drift landing on exactly
    // 10000 (which would leave nothing for the remainder handle) or
    // negative (shouldn't happen given the sum check above, but a leg with
    // weightBps <= 0 could get here from bad upstream data).
    splitBpsByStep.push(Math.min(9999, Math.max(1, stepBps)));
    remainingBps -= leg.weightBps;
  }
  return splitBpsByStep;
}

/** Verified against the actual installed `@lifi/compose-spec@0.5.0` `ComposeCompileSuccessData` type before adding this — see this file's own header doc on not assuming a newer SDK. `inputValueUsd`/`outputValueUsd` are already USD; `impactBps` is the SDK's own computed price impact, never re-derived here. */
export interface ComposerPriceImpact {
  inputValueUsd: number;
  outputValueUsd: number;
  impactBps: number;
  unpricedInputs: readonly string[];
  unpricedOutputs: readonly string[];
}

/** One `ComposeFee` entry, passed through as-is. `amount` is in `token`'s own raw units (input-token-denominated for every fee this flow charges), NOT USD — never treated as a USD figure by a caller (see `candidate-metrics.ts`'s own comment on why this is surfaced but not summed into `estimatedFeeUsd`). */
export interface ComposerFee {
  token: string;
  recipient: 'lifi' | 'integrator';
  bps: number;
  amount?: string;
}

export interface ComposerApproval {
  token: string;
  spender: string;
  amountRaw: string;
}

export interface ComposerPurchaseResult {
  /** Ready to pass to the wallet as-is: { to, data, value }. */
  transactionRequest: { to: string; data: string; value: string; chainId?: number };
  /** The Composer execution proxy this transaction runs through — informational, matches what CreatorRewardsVault/RedeemFeeRouter's own "who actually holds funds mid-transaction" documentation style expects callers to be told, not hidden. */
  userProxy: string;
  /**
   * ERC-20 approvals the signer still needs before `transactionRequest` can
   * succeed (already filtered against on-chain allowances by
   * `checkOnChainAllowances`). Only ever the purchase's own input token —
   * anything else makes this module refuse the flow. The wallet must send
   * these first, or the Composer transaction reverts.
   */
  approvals: ComposerApproval[];
  /** Per-leg simulated output, keyed by this module's own `swap_<index>` node ids — see buildLegNodeId(). Re-exports the SDK's own `ProducedResource` type as-is rather than a hand-narrowed shape, so a field this module doesn't use today doesn't silently get dropped for a future caller that needs it. */
  producedResources: Record<string, ProducedResource>;
  /**
   * `transactionRequest.gasLimit` — a gas UNIT estimate (e.g. `"210000"`),
   * NOT a USD amount. `null` when the compile response genuinely didn't
   * include one (the field is optional on the installed SDK's own type).
   * A caller wanting a USD gas figure would need a live gas-price read this
   * module deliberately does not add (candidate-metrics.ts item 6).
   */
  gasLimitRaw: string | null;
  /** `null` when the compile response didn't include one (optional on the installed SDK type — e.g. an input/output asset Composer couldn't price for the impact calculation itself). */
  priceImpact: ComposerPriceImpact | null;
  /** Empty array when the compile response reported none — never `null`, since "no fees" is itself meaningful information, unlike `priceImpact`/`gasLimitRaw` where absence means "not computed". */
  fees: ComposerFee[];
}

function buildLegNodeId(index: number): string {
  return `swap_${index}`;
}

/**
 * The minimum output LI.FI's swap for leg `legIndex` enforces ON CHAIN, as
 * reported by the SAME compile() response — `producedResources` entry
 * `swap_<i>.amountOut`, field `simulated.amountOutMin`. `null` when the
 * response does not carry it (never fabricated or derived).
 *
 * What it is — and is not:
 * - It is a PROVIDER-level floor at the SWAP BOUNDARY: the swap reverts
 *   (and with it the whole Composer transaction) if that leg's swap yields
 *   less. Verified against the live API (scripts/spike/composer-min-output-probe.ts):
 *   the value appears verbatim in the transaction calldata, and Composer
 *   rejects an extra output guard on `amountOut` because that port
 *   "provides its own minimum".
 * - It is NOT the amount guaranteed to land in the buyer's wallet: the
 *   proxy sweeps outputs to the buyer afterwards, and a transfer-fee token
 *   or any later step can reduce it. So it is never BAG's own minimum
 *   (`PurchaseIntentStepRecord.minOutputRaw`) and never a verification
 *   criterion — see `providerEnforcedMinOutputRaw`.
 *
 * Read from `producedResources`, deliberately NOT by decoding the calldata:
 * the calldata is LI.FI's own encoding of its Diamond/Composer program, not
 * a stable interface this app controls; the compile response is the
 * documented source for the same number.
 *
 * Keyed by OUTPUT PORT (`swap_0.amountOut`), which is how the live API keys
 * `producedResources` — not by node id (`swap_0`).
 */
export function composerLegEnforcedMinOutputRaw(
  producedResources: Record<string, ProducedResource>,
  legIndex: number
): string | null {
  const min = composerLegProducedResource(producedResources, legIndex)?.simulated?.amountOutMin;
  return min !== undefined && min !== null ? String(min) : null;
}

/**
 * Leg `legIndex`'s produced resource from a compile response. The live API
 * keys `producedResources` by OUTPUT PORT (`swap_0.amountOut`), not by node
 * id (`swap_0`) — reading the node id returned nothing, so every Composer
 * leg's simulated output used to be recorded as null. Single place both the
 * compiler-path provider and the legacy path read a leg's entry.
 */
export function composerLegProducedResource(
  producedResources: Record<string, ProducedResource>,
  legIndex: number
): ProducedResource | undefined {
  return producedResources[`${buildLegNodeId(legIndex)}.amountOut`];
}

/** Leg `legIndex`'s SIMULATED (expected, not guaranteed) output as a raw string, or null when the response carries none. */
export function composerLegSimulatedOutputRaw(
  producedResources: Record<string, ProducedResource>,
  legIndex: number
): string | null {
  const out = composerLegProducedResource(producedResources, legIndex)?.simulated?.amountOut;
  return out !== undefined && out !== null ? String(out) : null;
}

/**
 * Builds and compiles a single Composer Flow that swaps one input into all
 * of `request.legs` in one transaction, then returns the compiled calldata.
 * Throws `ComposerIneligibleError` if called for a chain/leg combination
 * `isComposerEligible` would have rejected — check that first; this
 * function re-checks and throws rather than silently degrading, since
 * building half a flow for an ineligible chain is worse than refusing
 * outright.
 */
export async function buildComposerPurchase(request: ComposerPurchaseRequest): Promise<ComposerPurchaseResult> {
  const nativeInput = isNativeAssetIdentity({ chain: request.chain, address: request.inputTokenAddress });
  if (!isComposerEligible(request.chain, request.legs)) {
    throw new ComposerIneligibleError(
      `Chain "${request.chain}" with ${request.legs.length} leg(s) is not eligible for a Composer flow — use the sequential lifi-purchase-quote.ts path instead.`
    );
  }

  const chainId = toLiFiChainId(request.chain);
  const sdkOptions: ComposeSdkOptions = {
    baseUrl: request.baseUrl ?? 'https://composer.li.quest',
    apiKey: request.apiKey,
  };
  if (request.fetchImpl !== undefined) {
    (sdkOptions as { fetch?: typeof fetch }).fetch = request.fetchImpl;
  }
  const sdk = createComposeSdk(sdkOptions);

  const builder = sdk.flow(chainId, {
    name: `bag-purchase-${request.legs.length}-legs`,
    inputs: {
      // Native ETH is deposited as msg.value (the SDK's `directDeposit`
      // materialiser: "native via msg.value, ERC-20 via transferFrom").
      amountIn: nativeInput ? resources.native(chainId) : resources.erc20(request.inputTokenAddress as `0x${string}`, chainId),
    },
  });

  const slippage = request.slippageBps / 10000;
  const splitBpsByStep = computeCascadeSplitBps(request.legs);

  let currentResource: Bindable<'resource'> = builder.inputs.amountIn;
  for (let i = 0; i < request.legs.length - 1; i++) {
    const leg = request.legs[i];
    const { a, b } = builder.core.split(`split_${i}`, {
      bind: { source: currentResource },
      config: { bps: splitBpsByStep[i] },
    });
    builder.lifi.swap(buildLegNodeId(i), {
      bind: { amountIn: a },
      config: {
        resourceOut: { kind: 'erc20', token: leg.address as `0x${string}`, chainId },
        slippage,
      },
      guards: [guards.slippage({ port: 'unspentIn', bps: request.slippageBps })],
    });
    currentResource = b;
  }

  // Last leg: whatever remains, no split needed.
  const lastIndex = request.legs.length - 1;
  const lastLeg = request.legs[lastIndex];
  builder.lifi.swap(buildLegNodeId(lastIndex), {
    bind: { amountIn: currentResource },
    config: {
      resourceOut: { kind: 'erc20', token: lastLeg.address as `0x${string}`, chainId },
      slippage,
    },
    guards: [guards.slippage({ port: 'unspentIn', bps: request.slippageBps })],
  });

  const result = await builder.compile({
    signer: request.signerAddress as `0x${string}`,
    inputs: {
      amountIn: materialisers.directDeposit({ amount: BigInt(request.inputAmountRaw) }),
    },
    sweepTo: { $ref: 'context.sender' },
    // Avoids an unnecessary approval step (and its own signature) when the
    // signer already approved this exact spend previously — see
    // ComposeRunInput's own doc comment on this flag.
    checkOnChainAllowances: true,
    ...(request.maxPriceImpactBps !== undefined ? { maxPriceImpactBps: request.maxPriceImpactBps } : {}),
  });

  if (result.status !== 'success') {
    throw new Error(`Composer flow compilation failed: ${result.error.kind} — ${result.error.message}`);
  }
  if (!result.transactionRequest) {
    // Not expected given `status === 'success'`, but this module never
    // hands a wallet layer a possibly-missing `to`/`data` without checking
    // — see the "never fabricate a transaction" principle applied
    // everywhere else in this codebase's blockchain adapters.
    throw new Error('Composer flow reported success but returned no transactionRequest.');
  }

  // Only ever approve the purchase's own input token, never more than the
  // purchase spends; any other request means something unexpected is being
  // asked of the wallet, so refuse (the caller falls back to sequential).
  const approvals: ComposerApproval[] = (result.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, amountRaw: a.amount }));
  const value = result.transactionRequest.value ?? '0';
  const valueWei = BigInt(value); // decimal or 0x-hex; anything else throws (and the purchase does not go ahead)
  if (nativeInput) {
    // A native payment needs no approval at all, and the transaction must
    // carry exactly the purchase's ETH — never more (it would be spent or
    // swept elsewhere) and never less (the flow would revert or underbuy).
    if (approvals.length > 0) throw new Error('Composer requested a token approval for a native-ETH purchase.');
    if (valueWei !== BigInt(request.inputAmountRaw)) {
      throw new Error(`Composer transaction value ${value} does not equal the purchase's ${request.inputAmountRaw} wei.`);
    }
  } else if (valueWei !== BigInt(0)) {
    // An ERC-20 purchase never spends the wallet's ETH (same rule as the sweep and settlement flows below).
    throw new Error('Composer returned an ERC-20 purchase transaction that also spends native ETH.');
  }
  for (const a of approvals) {
    if (a.token.toLowerCase() !== request.inputTokenAddress.toLowerCase()) {
      throw new Error(`Composer requested an approval for ${a.token}, not the purchase's input token.`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.spender) || !/^\d+$/.test(a.amountRaw) || BigInt(a.amountRaw) > BigInt(request.inputAmountRaw)) {
      throw new Error('Composer returned an approval with an invalid spender or an amount above the purchase input.');
    }
  }

  return {
    approvals,
    transactionRequest: {
      to: result.transactionRequest.to,
      data: result.transactionRequest.data,
      value: valueWei.toString(),
      chainId,
    },
    userProxy: result.userProxy,
    producedResources: result.producedResources,
    // Straight passthrough of what THIS `compile()` call already returned —
    // no second Composer call, no invented conversion. See this function's
    // own doc and `ComposerPurchaseResult`'s field comments above.
    gasLimitRaw: result.transactionRequest.gasLimit ?? null,
    priceImpact: result.priceImpact ?? null,
    fees: (result.fees ?? []).map((f) => ({ token: f.token, recipient: f.recipient, bps: f.bps, amount: f.amount })),
  };
}

// -----------------------------------------------------------------------------
// Wallet sweep ("dust sweeper"): several tokens the wallet holds → ONE output
// token (the chain's settlement stablecoin), in ONE Composer transaction. Same
// guards as a purchase: per-swap slippage guard, Composer's price-impact
// limit, approvals only for the tokens being sold and never above the amount
// sold. Not tied to any Bag — this is the user's own wallet.
// -----------------------------------------------------------------------------

export interface ComposerSweepInput {
  address: string;
  amountRaw: string;
  /** For error messages only. */
  symbol: string;
}

export interface ComposerSweepRequest {
  chain: ChainId;
  inputs: ComposerSweepInput[];
  outputTokenAddress: string;
  signerAddress: string;
  slippageBps: number;
  maxPriceImpactBps?: number;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Node id of the swap selling input `index` — `sweep_<i>`; its output port is `sweep_<i>.amountOut`. */
export function sweepNodeId(index: number): string {
  return `sweep_${index}`;
}

export async function buildComposerSweep(request: ComposerSweepRequest): Promise<ComposerPurchaseResult> {
  if (!COMPOSER_ELIGIBLE_CHAINS.includes(request.chain) || request.inputs.length === 0) {
    throw new ComposerIneligibleError(`Chain "${request.chain}" with ${request.inputs.length} token(s) cannot be swept through Composer.`);
  }
  const output = request.outputTokenAddress.toLowerCase();
  const seen = new Set<string>();
  for (const input of request.inputs) {
    const address = input.address.toLowerCase();
    if (address === output) throw new Error(`${input.symbol} is the output token; it cannot also be sold.`);
    if (seen.has(address)) throw new Error(`${input.symbol} is listed twice.`);
    if (!/^\d+$/.test(input.amountRaw) || BigInt(input.amountRaw) <= BigInt(0)) throw new Error(`${input.symbol}: amount must be a positive integer.`);
    seen.add(address);
  }

  const chainId = toLiFiChainId(request.chain);
  const sdkOptions: ComposeSdkOptions = { baseUrl: request.baseUrl ?? 'https://composer.li.quest', apiKey: request.apiKey };
  if (request.fetchImpl !== undefined) {
    (sdkOptions as { fetch?: typeof fetch }).fetch = request.fetchImpl;
  }
  const sdk = createComposeSdk(sdkOptions);

  const inputSchema: Record<string, ReturnType<typeof resources.erc20>> = {};
  request.inputs.forEach((input, i) => {
    inputSchema[`in_${i}`] = resources.erc20(input.address as `0x${string}`, chainId);
  });
  const builder = sdk.flow(chainId, { name: `wallet-sweep-${request.inputs.length}`, inputs: inputSchema });
  const slippage = request.slippageBps / 10000;
  const builderInputs = builder.inputs as Record<string, Bindable<'resource'>>;
  request.inputs.forEach((_input, i) => {
    builder.lifi.swap(sweepNodeId(i), {
      bind: { amountIn: builderInputs[`in_${i}`] },
      config: { resourceOut: { kind: 'erc20', token: request.outputTokenAddress as `0x${string}`, chainId }, slippage },
      guards: [guards.slippage({ port: 'unspentIn', bps: request.slippageBps })],
    });
  });

  const runInputs: Record<string, ReturnType<typeof materialisers.directDeposit>> = {};
  request.inputs.forEach((input, i) => {
    runInputs[`in_${i}`] = materialisers.directDeposit({ amount: BigInt(input.amountRaw) });
  });
  const result = await builder.compile({
    signer: request.signerAddress as `0x${string}`,
    inputs: runInputs as never,
    sweepTo: { $ref: 'context.sender' },
    checkOnChainAllowances: true,
    ...(request.maxPriceImpactBps !== undefined ? { maxPriceImpactBps: request.maxPriceImpactBps } : {}),
  });

  if (result.status !== 'success') {
    throw new Error(`Composer flow compilation failed: ${result.error.kind} — ${result.error.message}`);
  }
  if (!result.transactionRequest) {
    throw new Error('Composer flow reported success but returned no transactionRequest.');
  }

  // Only ERC-20s are sold: the transaction must not also take native ETH.
  if (BigInt(result.transactionRequest.value ?? '0') !== BigInt(0)) {
    throw new Error('Composer returned a sweep transaction that also spends native ETH.');
  }

  // Approvals only for tokens being sold, each at most the amount sold.
  const amountByToken = new Map(request.inputs.map((input) => [input.address.toLowerCase(), BigInt(input.amountRaw)]));
  const approvals: ComposerApproval[] = (result.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, amountRaw: a.amount }));
  for (const a of approvals) {
    const limit = amountByToken.get(a.token.toLowerCase());
    if (limit === undefined) throw new Error(`Composer requested an approval for ${a.token}, which is not being sold.`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.spender) || !/^\d+$/.test(a.amountRaw) || BigInt(a.amountRaw) > limit) {
      throw new Error('Composer returned an approval with an invalid spender or an amount above what is being sold.');
    }
  }

  return {
    approvals,
    transactionRequest: {
      to: result.transactionRequest.to,
      data: result.transactionRequest.data,
      value: result.transactionRequest.value ?? '0',
      chainId,
    },
    userProxy: result.userProxy,
    producedResources: result.producedResources,
    gasLimitRaw: result.transactionRequest.gasLimit ?? null,
    priceImpact: result.priceImpact ?? null,
    fees: (result.fees ?? []).map((f) => ({ token: f.token, recipient: f.recipient, bps: f.bps, amount: f.amount })),
  };
}

// -----------------------------------------------------------------------------
// Rebalance of one investor's position (R2): the overweight tokens the wallet
// holds → the underweight ones, in ONE Composer transaction, into the same
// wallet. The shortest shape that covers the trade:
//   one sell  → split straight across the buys          (one swap per buy)
//   one buy   → every sell swaps straight into it        (one swap per sell)
//   otherwise → sells → hub stablecoin → merged → split across the buys
// Same guards as purchase and sweep: per-swap slippage guard, Composer's
// price-impact limit, approvals only for tokens sold and never above the
// amount sold, no native ETH. Signs and sends nothing.
// -----------------------------------------------------------------------------

export interface ComposerRebalanceSell {
  address: string;
  amountRaw: string;
  symbol: string;
}

export interface ComposerRebalanceBuy {
  address: string;
  /** Share of the proceeds this token receives; all buys sum to exactly 10000. */
  weightBps: number;
  symbol: string;
}

export interface ComposerRebalanceRequest {
  chain: ChainId;
  sells: ComposerRebalanceSell[];
  buys: ComposerRebalanceBuy[];
  /** The stablecoin the many-to-many shape routes through (the chain's settlement stablecoin). */
  hubTokenAddress: string;
  signerAddress: string;
  slippageBps: number;
  maxPriceImpactBps?: number;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type RebalanceShape = 'ONE_SELL' | 'ONE_BUY' | 'HUB';

/** Node ids: `rb_sell_<i>` swaps sell i; `rb_buy_<j>` produces buy j (its output port is `rb_buy_<j>.amountOut`). */
export const rebalanceSellNodeId = (i: number) => `rb_sell_${i}`;
export const rebalanceBuyNodeId = (j: number) => `rb_buy_${j}`;

export function rebalanceShape(sells: number, buys: number): RebalanceShape {
  return sells === 1 ? 'ONE_SELL' : buys === 1 ? 'ONE_BUY' : 'HUB';
}

export async function buildComposerRebalance(request: ComposerRebalanceRequest): Promise<ComposerPurchaseResult & { shape: RebalanceShape }> {
  if (!COMPOSER_ELIGIBLE_CHAINS.includes(request.chain) || request.sells.length === 0 || request.buys.length === 0) {
    throw new ComposerIneligibleError(`Chain "${request.chain}" with ${request.sells.length} sell(s) and ${request.buys.length} buy(s) cannot be rebalanced through Composer.`);
  }
  const hub = request.hubTokenAddress.toLowerCase();
  const sold = new Set<string>();
  for (const s of request.sells) {
    const a = s.address.toLowerCase();
    if (sold.has(a)) throw new Error(`${s.symbol} is sold twice.`);
    if (!/^\d+$/.test(s.amountRaw) || BigInt(s.amountRaw) <= BigInt(0)) throw new Error(`${s.symbol}: sell amount must be a positive integer.`);
    sold.add(a);
  }
  const bought = new Set<string>();
  for (const b of request.buys) {
    const a = b.address.toLowerCase();
    if (sold.has(a)) throw new Error(`${b.symbol} cannot be both sold and bought.`);
    if (bought.has(a)) throw new Error(`${b.symbol} is bought twice.`);
    if (!Number.isInteger(b.weightBps) || b.weightBps <= 0) throw new Error(`${b.symbol}: weight must be a positive whole number of bps.`);
    bought.add(a);
  }
  if (request.buys.reduce((sum, b) => sum + b.weightBps, 0) !== 10000) throw new Error('Buy weights must sum to exactly 10000 bps.');
  if (sold.has(hub) || bought.has(hub)) {
    // The hub never appears as a basket trade here: a stablecoin holding would need its own no-swap leg.
    if (rebalanceShape(request.sells.length, request.buys.length) === 'HUB') throw new Error('The hub stablecoin cannot itself be sold or bought in a many-to-many rebalance.');
  }

  const chainId = toLiFiChainId(request.chain);
  const sdkOptions: ComposeSdkOptions = { baseUrl: request.baseUrl ?? 'https://composer.li.quest', apiKey: request.apiKey };
  if (request.fetchImpl !== undefined) {
    (sdkOptions as { fetch?: typeof fetch }).fetch = request.fetchImpl;
  }
  const sdk = createComposeSdk(sdkOptions);

  const inputSchema: Record<string, ReturnType<typeof resources.erc20>> = {};
  request.sells.forEach((s, i) => {
    inputSchema[`in_${i}`] = resources.erc20(s.address as `0x${string}`, chainId);
  });
  const shape = rebalanceShape(request.sells.length, request.buys.length);
  const builder = sdk.flow(chainId, { name: `bag-rebalance-${request.sells.length}-to-${request.buys.length}`, inputs: inputSchema });
  const builderInputs = builder.inputs as Record<string, Bindable<'resource'>>;
  const slippage = request.slippageBps / 10000;
  const swap = (id: string, source: Bindable<'resource'>, token: string) =>
    builder.lifi.swap(id, {
      bind: { amountIn: source },
      config: { resourceOut: { kind: 'erc20', token: token as `0x${string}`, chainId }, slippage },
      guards: [guards.slippage({ port: 'unspentIn', bps: request.slippageBps })],
    });
  // Cascade split of `source` across the buys (same arithmetic as the purchase flow).
  const splitAcrossBuys = (source: Bindable<'resource'>) => {
    const steps = computeCascadeSplitBps(request.buys);
    let current = source;
    for (let j = 0; j < request.buys.length - 1; j++) {
      const { a, b } = builder.core.split(`rb_split_${j}`, { bind: { source: current }, config: { bps: steps[j] } });
      swap(rebalanceBuyNodeId(j), a, request.buys[j].address);
      current = b;
    }
    swap(rebalanceBuyNodeId(request.buys.length - 1), current, request.buys[request.buys.length - 1].address);
  };

  if (shape === 'ONE_SELL') {
    splitAcrossBuys(builderInputs.in_0);
  } else if (shape === 'ONE_BUY') {
    // Each sell swaps straight into the one buy; the buy's output is each sell node's own output.
    request.sells.forEach((_s, i) => swap(rebalanceSellNodeId(i), builderInputs[`in_${i}`], request.buys[0].address));
  } else {
    const parts = request.sells.map((_s, i) => swap(rebalanceSellNodeId(i), builderInputs[`in_${i}`], request.hubTokenAddress).amountOut);
    let merged = parts[0];
    for (let i = 1; i < parts.length; i++) merged = builder.core.merge(`rb_merge_${i}`, { bind: { a: merged, b: parts[i] } }).merged;
    splitAcrossBuys(merged);
  }

  const runInputs: Record<string, ReturnType<typeof materialisers.directDeposit>> = {};
  request.sells.forEach((s, i) => {
    runInputs[`in_${i}`] = materialisers.directDeposit({ amount: BigInt(s.amountRaw) });
  });
  const result = await builder.compile({
    signer: request.signerAddress as `0x${string}`,
    inputs: runInputs as never,
    sweepTo: { $ref: 'context.sender' },
    checkOnChainAllowances: true,
    ...(request.maxPriceImpactBps !== undefined ? { maxPriceImpactBps: request.maxPriceImpactBps } : {}),
  });

  if (result.status !== 'success') {
    throw new Error(`Composer flow compilation failed: ${result.error.kind} — ${result.error.message}`);
  }
  if (!result.transactionRequest) {
    throw new Error('Composer flow reported success but returned no transactionRequest.');
  }
  if (BigInt(result.transactionRequest.value ?? '0') !== BigInt(0)) {
    throw new Error('Composer returned a rebalance transaction that also spends native ETH.');
  }
  const amountByToken = new Map(request.sells.map((s) => [s.address.toLowerCase(), BigInt(s.amountRaw)]));
  const approvals: ComposerApproval[] = (result.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, amountRaw: a.amount }));
  for (const a of approvals) {
    const limit = amountByToken.get(a.token.toLowerCase());
    if (limit === undefined) throw new Error(`Composer requested an approval for ${a.token}, which is not being sold.`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.spender) || !/^\d+$/.test(a.amountRaw) || BigInt(a.amountRaw) > limit) {
      throw new Error('Composer returned an approval with an invalid spender or an amount above what is being sold.');
    }
  }

  return {
    shape,
    approvals,
    transactionRequest: { to: result.transactionRequest.to, data: result.transactionRequest.data, value: result.transactionRequest.value ?? '0', chainId },
    userProxy: result.userProxy,
    producedResources: result.producedResources,
    gasLimitRaw: result.transactionRequest.gasLimit ?? null,
    priceImpact: result.priceImpact ?? null,
    fees: (result.fees ?? []).map((f) => ({ token: f.token, recipient: f.recipient, bps: f.bps, amount: f.amount })),
  };
}

// -----------------------------------------------------------------------------
// Fee-paying redemption through RedeemSettlement (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §8–§9): every
// held token sold into USDG (a USDG holding goes in as is), the outputs merged, the merged USDG transferred to the
// settlement contract, then `settleFlat` called — the push shape proven live (P1 SP/SP2). The settle arguments are
// flow inputs (static types only: bytes32 / address / uint256), the attestor's signature in EIP-2098 compact form.
// A core.transfer is a tracked output, so Composer's own price-impact guard stays on. Signs and sends nothing.
// -----------------------------------------------------------------------------

export const SETTLE_FLAT_SIGNATURE =
  'function settleFlat(bytes32 redemptionId,address user,address creator,address rootCreator,bytes32 contextHash,uint256 consumedBasis,uint256 lossCarry,uint256 minUserProceeds,uint256 feeRateAndDeadline,bytes32 r,bytes32 vs) returns (uint256)';

export interface ComposerSettlementRedeemRequest {
  chain: ChainId;
  inputs: ComposerSweepInput[];
  /** USDG. */
  outputTokenAddress: string;
  settlementAddress: string;
  settle: {
    redemptionId: `0x${string}`;
    user: `0x${string}`;
    creator: `0x${string}`;
    /** A fork's root creator (gets FORK_ROYALTY_SHARE_BPS of the fee), zero address otherwise. */
    rootCreator: `0x${string}`;
    contextHash: `0x${string}`;
    consumedBasis: bigint;
    lossCarry: bigint;
    feeRateBps: bigint;
    minUserProceeds: bigint;
    deadline: bigint;
    r: `0x${string}`;
    vs: `0x${string}`;
  };
  signerAddress: string;
  slippageBps: number;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function buildComposerSettlementRedeem(request: ComposerSettlementRedeemRequest): Promise<ComposerPurchaseResult> {
  if (!COMPOSER_ELIGIBLE_CHAINS.includes(request.chain) || request.inputs.length === 0) {
    throw new ComposerIneligibleError(`Chain "${request.chain}" with ${request.inputs.length} token(s) cannot settle through Composer.`);
  }
  const output = request.outputTokenAddress.toLowerCase();
  const seen = new Set<string>();
  for (const input of request.inputs) {
    const address = input.address.toLowerCase();
    if (seen.has(address)) throw new Error(`${input.symbol} is listed twice.`);
    if (!/^\d+$/.test(input.amountRaw) || BigInt(input.amountRaw) <= BigInt(0)) throw new Error(`${input.symbol}: amount must be a positive integer.`);
    seen.add(address);
  }

  const chainId = toLiFiChainId(request.chain);
  const sdkOptions: ComposeSdkOptions = { baseUrl: request.baseUrl ?? 'https://composer.li.quest', apiKey: request.apiKey };
  if (request.fetchImpl !== undefined) {
    (sdkOptions as { fetch?: typeof fetch }).fetch = request.fetchImpl;
  }
  const sdk = createComposeSdk(sdkOptions);

  const inputSchema: Record<string, unknown> = {
    settlementAddress: 'address',
    redemptionId: 'bytes32',
    user: 'address',
    creator: 'address',
    rootCreator: 'address',
    contextHash: 'bytes32',
    consumedBasis: 'uint256',
    lossCarry: 'uint256',
    minUserProceeds: 'uint256',
    feeRateAndDeadline: 'uint256',
    r: 'bytes32',
    vs: 'bytes32',
  };
  request.inputs.forEach((input, i) => {
    inputSchema[`in_${i}`] = resources.erc20(input.address as `0x${string}`, chainId);
  });
  const builder = sdk.flow(chainId, { name: `settlement-redeem-${request.inputs.length}`, inputs: inputSchema as never });
  const b = builder.inputs as Record<string, Bindable<'resource'>>;
  const slippage = request.slippageBps / 10000;

  const usdgParts: Bindable<'resource'>[] = request.inputs.map((input, i) => {
    if (input.address.toLowerCase() === output) return b[`in_${i}`];
    return builder.lifi.swap(sweepNodeId(i), {
      bind: { amountIn: b[`in_${i}`] },
      config: { resourceOut: { kind: 'erc20', token: request.outputTokenAddress as `0x${string}`, chainId }, slippage },
      guards: [guards.slippage({ port: 'unspentIn', bps: request.slippageBps })],
    }).amountOut;
  });
  let merged = usdgParts[0];
  for (let i = 1; i < usdgParts.length; i++) {
    merged = builder.core.merge(`merge_${i}`, { bind: { a: merged, b: usdgParts[i] } }).merged;
  }
  builder.core.transfer('push', { bind: { amount: merged, recipient: b.settlementAddress as never }, config: {} });
  const names = ['redemptionId', 'user', 'creator', 'rootCreator', 'contextHash', 'consumedBasis', 'lossCarry', 'minUserProceeds', 'feeRateAndDeadline', 'r', 'vs'];
  builder.core.call('settle', {
    bind: Object.fromEntries(names.map((n) => [n, b[n]])) as never,
    config: { target: request.settlementAddress as `0x${string}`, functionSignature: SETTLE_FLAT_SIGNATURE },
  });

  const runInputs: Record<string, unknown> = {
    settlementAddress: request.settlementAddress,
    redemptionId: request.settle.redemptionId,
    user: request.settle.user,
    creator: request.settle.creator,
    rootCreator: request.settle.rootCreator,
    contextHash: request.settle.contextHash,
    consumedBasis: request.settle.consumedBasis.toString(),
    lossCarry: request.settle.lossCarry.toString(),
    minUserProceeds: request.settle.minUserProceeds.toString(),
    // settleFlat takes the fee rate and the deadline in one word (deadline << 16 | feeRateBps).
    feeRateAndDeadline: packFeeRateAndDeadline(request.settle.feeRateBps, request.settle.deadline).toString(),
    r: request.settle.r,
    vs: request.settle.vs,
  };
  request.inputs.forEach((input, i) => {
    runInputs[`in_${i}`] = materialisers.directDeposit({ amount: BigInt(input.amountRaw) });
  });
  const result = await builder.compile({
    signer: request.signerAddress as `0x${string}`,
    inputs: runInputs as never,
    sweepTo: { $ref: 'context.sender' },
    checkOnChainAllowances: true,
  } as never);

  if (result.status !== 'success') {
    throw new Error(`Composer flow compilation failed: ${result.error.kind} — ${result.error.message}`);
  }
  if (!result.transactionRequest) {
    throw new Error('Composer flow reported success but returned no transactionRequest.');
  }
  if (BigInt(result.transactionRequest.value ?? '0') !== BigInt(0)) {
    throw new Error('Composer returned a settlement transaction that also spends native ETH.');
  }
  const amountByToken = new Map(request.inputs.map((input) => [input.address.toLowerCase(), BigInt(input.amountRaw)]));
  const approvals: ComposerApproval[] = (result.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, amountRaw: a.amount }));
  for (const a of approvals) {
    const limit = amountByToken.get(a.token.toLowerCase());
    if (limit === undefined) throw new Error(`Composer requested an approval for ${a.token}, which is not being sold.`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.spender) || !/^\d+$/.test(a.amountRaw) || BigInt(a.amountRaw) > limit) {
      throw new Error('Composer returned an approval with an invalid spender or an amount above what is being sold.');
    }
  }
  return {
    approvals,
    transactionRequest: { to: result.transactionRequest.to, data: result.transactionRequest.data, value: result.transactionRequest.value ?? '0', chainId },
    userProxy: result.userProxy,
    producedResources: result.producedResources,
    gasLimitRaw: result.transactionRequest.gasLimit ?? null,
    priceImpact: result.priceImpact ?? null,
    fees: (result.fees ?? []).map((f) => ({ token: f.token, recipient: f.recipient, bps: f.bps, amount: f.amount })),
  };
}
