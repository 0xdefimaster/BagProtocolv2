import { normalizeAddress } from './chains';
import { BagSdkError, type BagSdkErrorCode } from './errors';
import { planPurchase, type PurchasePlan, type PurchaseRequest } from './purchase';
import type { BagDocument, Hex } from './types';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem';

// -----------------------------------------------------------------------------
// quoteBag / compileBag / simulateBag. The SDK builds an UNSIGNED transaction
// for the buyer's own wallet. It never signs, never sends, holds no key and
// owns no endpoint: routing comes from a ComposerProvider the caller passes in
// (e.g. `lifiComposer({ apiKey })` from @bag-protocol/sdk/lifi, with the
// caller's own LI.FI credentials), chain reads from the caller's viem client.
//
// The caller trust policy and purchase plan are checked before the provider
// call. Provider-returned transaction chain/target, approval token/spender/
// amount, planned output legs, and price impact are checked after the response
// and before returning an unsigned transaction.
// -----------------------------------------------------------------------------

/** What the SDK asks a routing provider to build. Provider-neutral. */
export interface ComposerCompileRequest {
  chainId: number;
  inputToken: string;
  /** 'native': declare the input as the chain's native coin (deposited as msg.value). 'erc20': an ERC-20 input. */
  inputKind: 'native' | 'erc20';
  /** Amount to swap (the plan's `swapAmountRaw`). */
  amountRaw: bigint;
  signer: string;
  /** Legs in order, each with its whole-bp share of `amountRaw` (summing to 10000). Build the partition with `planPartition(legs.map(l => l.legBps))`. */
  legs: { token: string; legBps: number }[];
  slippageBps: number;
  maxPriceImpactBps: number;
}

/** Provider-reported fee metadata; a role/tag is not a wallet address. */
export interface ProviderFee {
  token: string;
  /** Provider role/tag (e.g. LI.FI's 'lifi' or 'integrator'), preserved for compatibility. */
  recipient: string;
  /** Actual recipient address, if reported. Optional for existing custom providers. */
  recipientAddress?: string | null;
  bps: number;
  amountRaw: string | null;
}

/** A normalized quoted fee. An unreported address remains unknown, never inferred from the role. */
export interface QuotedFee extends ProviderFee {
  recipientAddress: string | null;
}

/** Untrusted provider text, copied as data. Render as text, not HTML or instructions. */
export interface ProviderWarning {
  kind: string;
  message: string;
  path?: string;
  port?: string;
  fix?: string;
}

/** Provider-reported USD values of the priced input and outputs. Not an independent price check. */
export interface PriceImpactUsd {
  inputValueUsd: number;
  outputValueUsd: number;
  /** Assets the provider could not price; non-empty lists make the USD comparison partial. */
  unpricedInputs: string[];
  unpricedOutputs: string[];
}

/**
 * Providers whose signed impact (negative = priced output worth more than priced input) may be
 * accepted when it is consistent with their own USD values. Populated only by lifiComposer;
 * deliberately not exported from the package, so other providers keep the non-negative rule.
 */
const signedUsdImpactProviders = new WeakSet<ComposerProvider>();
export function markSignedUsdPriceImpactProvider<T extends ComposerProvider>(provider: T): T {
  signedUsdImpactProviders.add(provider);
  return provider;
}

/**
 * Observed-behaviour compatibility tolerance, not an official formula: LI.FI Composer 0.11.3
 * returned impactBps = -6 for (inputValueUsd − outputValueUsd) / inputValueUsd × 10 000 = −6.33.
 * The exact rounding is undocumented, so a reported value must lie within ±1 bps of that ratio.
 */
export const SIGNED_PRICE_IMPACT_TOLERANCE_BPS = 1;

/** Logged once per output token by a delivery-proof program: `BagDelivered(token, recipient, before, after)`. */
export const DELIVERY_PROOF_SIGNATURE = 'BagDelivered(address,address,uint256,uint256)';

/**
 * The program measures and logs each output's delivery (lifiComposer `deliveryProof`). The log is emitted by the
 * executor; verifyPurchaseReceipt's 'DELIVERY_LOG' mode reads it instead of historical balance state.
 */
export interface DeliveryProof {
  signature: typeof DELIVERY_PROOF_SIGNATURE;
  /** The signer: every output is transferred to it before the second balance read. */
  recipient: string;
  /** Output tokens in leg order. */
  tokens: string[];
}

/** A provider's compiled purchase, normalized. `null` = the provider did not report it (never guessed). */
export interface ComposerCompileResult {
  transaction: { to: string; data: string; value: string; chainId: number | null };
  /** Contract that executes the program on the signer's behalf (informational). */
  executor: string | null;
  approvals: { token: string; spender: string; amountRaw: string }[];
  /** Each leg needs positive expected/minimum output in the same token units to enforce the requested slippage. */
  legs: { token: string | null; expectedOutRaw: string | null; minOutRaw: string | null }[];
  priceImpactBps: number | null;
  /**
   * The USD valuation behind `priceImpactBps`, as the provider reported it. Only the LI.FI Composer
   * adapter supplies it; it is what allows a negative (favorable) impact for that adapter alone.
   */
  priceImpactUsd?: PriceImpactUsd | null;
  gasLimit: string | null;
  fees: ProviderFee[];
  /** Provider deadline as Unix milliseconds. Omitted/null means unknown, not unlimited validity. */
  validUntilMs?: number | null;
  /** Optional for existing custom providers; no provider-specific objects are passed through. */
  warnings?: ProviderWarning[];
  /** Present when the program logs its own measured delivery. */
  deliveryProof?: DeliveryProof | null;
}

export interface ComposerProvider {
  readonly name: string;
  compile(request: ComposerCompileRequest): Promise<ComposerCompileResult>;
}

/** Caller-owned trust boundary for contracts the wallet may be asked to call or approve. */
export interface ExecutionTrustPolicy {
  /** Must equal the strategy chain. Address allowlists are never shared across chains. */
  chainId: number;
  /** Explicit contracts allowed as the compiled transaction target. */
  allowedTransactionTargets: readonly string[];
  /** Explicit contracts allowed to receive an ERC-20 approval. May be empty if no approval is needed. */
  allowedApprovalSpenders: readonly string[];
}

export interface QuotedLeg {
  token: string;
  /** Exact target input for this leg (the on-chain split stays within the v1 execution bound of it). */
  targetInputRaw: bigint;
  /** Simulated output: an estimate, not a guarantee. */
  expectedOutRaw: string | null;
  /** The provider's on-chain minimum at the swap: the transaction reverts below it. */
  minOutRaw: string | null;
}

export interface PurchaseQuote {
  plan: PurchasePlan;
  provider: string;
  legs: QuotedLeg[];
  /** Negative only for the LI.FI Composer adapter, and only when consistent with `priceImpactUsd`. */
  priceImpactBps: number;
  /** The provider's USD valuation as reported (LI.FI Composer only), otherwise null. */
  priceImpactUsd: PriceImpactUsd | null;
  fees: QuotedFee[];
  gasLimit: string | null;
  /** Local clock immediately before asking the provider. Not an upstream quote creation time. */
  requestedAtMs: number;
  /** Local clock immediately after the provider responds. */
  receivedAtMs: number;
  /** Provider deadline, or null if unknown. Neither local timestamp supplies a provider guarantee. */
  validUntilMs: number | null;
  warnings: ProviderWarning[];
}

export interface CompiledPurchase {
  quote: PurchaseQuote;
  /** Unsigned. The buyer's wallet signs and sends it, after the approvals. */
  transaction: { to: Hex; data: Hex; value: bigint; chainId: number };
  approvals: { token: Hex; spender: Hex; amountRaw: bigint }[];
  executor: string | null;
  /** Absent or null: the program carries no delivery log (verify with balance evidence). */
  deliveryProof?: DeliveryProof | null;
}

export class ProviderResponseError extends BagSdkError {
  constructor(message: string, code: BagSdkErrorCode = 'PROVIDER_RESPONSE_INVALID') {
    super(code, message);
    this.name = 'ProviderResponseError';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const UINT_RE = /^\d+$/;
/** A transaction value: decimal or 0x-hex (providers use either). */
const VALUE_RE = /^(\d+|0x[0-9a-fA-F]+)$/;

interface TrustedContracts {
  targets: Set<string>;
  spenders: Set<string>;
}

function trustedContracts(plan: PurchasePlan, provider: string, trust: ExecutionTrustPolicy): TrustedContracts {
  const fail = (m: string, code: BagSdkErrorCode = 'PROVIDER_RESPONSE_INVALID'): never => {
    throw new ProviderResponseError(`${provider}: ${m}`, code);
  };
  if (!trust || trust.chainId !== plan.chainId) fail(`trust policy chain ${trust?.chainId ?? 'missing'} does not match plan chain ${plan.chainId}.`, 'TRUST_POLICY_INVALID');
  if (!Array.isArray(trust.allowedTransactionTargets) || trust.allowedTransactionTargets.length === 0 || trust.allowedTransactionTargets.some((a) => typeof a !== 'string' || !ADDRESS_RE.test(a))) {
    fail('trust policy must contain at least one valid transaction target.', 'TRUST_POLICY_INVALID');
  }
  if (!Array.isArray(trust.allowedApprovalSpenders) || trust.allowedApprovalSpenders.some((a) => typeof a !== 'string' || !ADDRESS_RE.test(a))) {
    fail('trust policy contains an invalid approval spender list.', 'TRUST_POLICY_INVALID');
  }
  return {
    targets: new Set(trust.allowedTransactionTargets.map((a) => a.toLowerCase())),
    spenders: new Set(trust.allowedApprovalSpenders.map((a) => a.toLowerCase())),
  };
}

function requestFor(plan: PurchasePlan): ComposerCompileRequest {
  return {
    chainId: plan.chainId,
    inputToken: plan.inputToken,
    inputKind: plan.inputKind,
    amountRaw: plan.swapAmountRaw,
    signer: plan.signer,
    legs: plan.legs.map((l) => ({ token: l.token, legBps: l.legBps })),
    slippageBps: plan.slippageBps,
    maxPriceImpactBps: plan.maxPriceImpactBps,
  };
}

/** Checks a provider answer against the plan. Throws ProviderResponseError on anything unexpected. */
function checked(plan: PurchasePlan, provider: string, r: ComposerCompileResult, trusted: TrustedContracts, requestedAtMs: number, receivedAtMs: number, signedUsdImpact = false): CompiledPurchase {
  const fail = (m: string, code: BagSdkErrorCode = 'PROVIDER_RESPONSE_INVALID'): never => {
    throw new ProviderResponseError(`${provider}: ${m}`, code);
  };
  const tx = r.transaction;
  if (!ADDRESS_RE.test(tx.to) || !HEX_RE.test(tx.data) || tx.data.length < 10 || !VALUE_RE.test(tx.value)) fail('malformed transaction.');
  if (tx.chainId === null || tx.chainId !== plan.chainId) fail(`transaction chain ${tx.chainId ?? 'missing'} does not match plan chain ${plan.chainId}.`, 'CHAIN_MISMATCH');
  if (!trusted.targets.has(tx.to.toLowerCase())) fail(`transaction target ${tx.to} is not in the caller's trusted target allowlist.`, 'UNTRUSTED_TARGET');
  const value = BigInt(tx.value);
  if (plan.inputKind === 'native') {
    // The purchase's ETH travels as msg.value: exactly the swapped amount, never more (it would be spent or swept
    // elsewhere), never less (the program would revert or under-buy). Nothing to approve.
    if (value !== plan.swapAmountRaw) fail(`a native purchase must send exactly ${plan.swapAmountRaw} wei, the transaction sends ${value}.`);
    if (r.approvals.length > 0) fail('a native purchase needs no approval, the provider requested one.', 'APPROVAL_INVALID');
  } else if (value !== BigInt(0)) {
    fail('an ERC-20 purchase must not send native value.');
  }

  const seenSpenders = new Set<string>();
  const approvals = r.approvals.map((a) => {
    if (normalizeAddress(a.token) !== plan.inputToken) fail(`approval requested for ${a.token}, not the input token.`, 'APPROVAL_INVALID');
    if (!ADDRESS_RE.test(a.spender) || !UINT_RE.test(a.amountRaw)) fail('malformed approval.', 'APPROVAL_INVALID');
    // One input token: a second approval to the same spender is not a plan, it only overwrites the first allowance.
    if (seenSpenders.has(a.spender.toLowerCase())) fail(`duplicate approval for spender ${a.spender}.`, 'APPROVAL_INVALID');
    seenSpenders.add(a.spender.toLowerCase());
    if (!trusted.spenders.has(a.spender.toLowerCase())) fail(`approval spender ${a.spender} is not in the caller's trusted spender allowlist.`, 'UNTRUSTED_SPENDER');
    if (BigInt(a.amountRaw) > plan.swapAmountRaw) fail('approval above the swapped amount.', 'APPROVAL_INVALID');
    return { token: plan.inputToken as Hex, spender: a.spender as Hex, amountRaw: BigInt(a.amountRaw) };
  });

  if (r.legs.length !== plan.legs.length) fail(`returned ${r.legs.length} legs, planned ${plan.legs.length}.`, 'OUTPUT_INVALID');
  const legs: QuotedLeg[] = plan.legs.map((l, i) => {
    const got = r.legs[i];
    if (got.token === null) fail(`leg ${i} has no output token identity.`, 'OUTPUT_INVALID');
    const outputToken = got.token as string;
    if (normalizeAddress(outputToken) !== l.token) fail(`leg ${i} delivers ${outputToken}, planned ${l.token}.`, 'OUTPUT_INVALID');
    for (const v of [got.expectedOutRaw, got.minOutRaw]) if (v !== null && (typeof v !== 'string' || !UINT_RE.test(v))) fail(`leg ${i} has a malformed amount.`, 'OUTPUT_INVALID');
    if (got.minOutRaw === null) fail(`leg ${i} has no positive on-chain minimum output; refusing an unbounded swap.`, 'OUTPUT_INVALID');
    const minOutRaw = got.minOutRaw as string;
    const minimum = BigInt(minOutRaw);
    if (minimum === BigInt(0)) fail(`leg ${i} has no positive on-chain minimum output; refusing an unbounded swap.`, 'OUTPUT_INVALID');
    if (got.expectedOutRaw === null) fail(`leg ${i} has no expected output; cannot enforce the configured slippage.`, 'SLIPPAGE_EXCEEDED');
    const expected = BigInt(got.expectedOutRaw as string);
    if (expected === BigInt(0)) fail(`leg ${i} has no positive expected output; cannot enforce the configured slippage.`, 'SLIPPAGE_EXCEEDED');
    if (minimum > expected) fail(`leg ${i} minimum output is above its expected output.`, 'OUTPUT_INVALID');
    // Compare reported amounts with integer arithmetic, allowing only raw-unit
    // floor rounding. This checks quote consistency, not arbitrary calldata.
    const requiredMinimum = expected * BigInt(10_000 - plan.slippageBps) / BigInt(10_000);
    if (minimum < requiredMinimum) fail(`leg ${i} minimum output ${minimum} is below ${requiredMinimum}, required by the configured slippage ${plan.slippageBps} bps.`, 'SLIPPAGE_EXCEEDED');
    return { token: l.token, targetInputRaw: l.targetInputRaw, expectedOutRaw: got.expectedOutRaw, minOutRaw };
  });

  const priceImpactBps = r.priceImpactBps;
  if (priceImpactBps === null) {
    throw new ProviderResponseError(`${provider}: provider did not report price impact; cannot enforce the configured limit.`, 'PRICE_IMPACT_INVALID');
  }
  if (!Number.isSafeInteger(priceImpactBps)) fail(`malformed price impact ${priceImpactBps} bps.`, 'PRICE_IMPACT_INVALID');
  const reportedUsd = r.priceImpactUsd ?? null;
  let priceImpactUsd: PriceImpactUsd | null = null;
  if (signedUsdImpact && reportedUsd !== null) {
    const u = reportedUsd;
    if (!u || typeof u !== 'object' || !Array.isArray(u.unpricedInputs) || !Array.isArray(u.unpricedOutputs) ||
        [...u.unpricedInputs, ...u.unpricedOutputs].some((x) => typeof x !== 'string')) fail('malformed price impact USD values.', 'PRICE_IMPACT_INVALID');
    priceImpactUsd = { inputValueUsd: u.inputValueUsd, outputValueUsd: u.outputValueUsd, unpricedInputs: [...u.unpricedInputs], unpricedOutputs: [...u.unpricedOutputs] };
  }
  if (priceImpactBps < 0) {
    // A favorable impact is accepted only from a provider that reports signed USD-based impact,
    // and only when it is consistent with that provider's own complete USD valuation.
    if (!signedUsdImpact) fail(`malformed price impact ${priceImpactBps} bps.`, 'PRICE_IMPACT_INVALID');
    if (priceImpactUsd === null) fail(`negative price impact ${priceImpactBps} bps without its USD values.`, 'PRICE_IMPACT_INVALID');
    const { inputValueUsd, outputValueUsd, unpricedInputs, unpricedOutputs } = priceImpactUsd!;
    if (typeof inputValueUsd !== 'number' || !Number.isFinite(inputValueUsd) || inputValueUsd <= 0) fail('negative price impact with a non-positive or non-finite input USD value.', 'PRICE_IMPACT_INVALID');
    if (typeof outputValueUsd !== 'number' || !Number.isFinite(outputValueUsd) || outputValueUsd <= inputValueUsd) fail('negative price impact, but the output USD value is not above the input USD value.', 'PRICE_IMPACT_INVALID');
    if (unpricedInputs.length || unpricedOutputs.length) fail('negative price impact from a partial USD valuation (unpriced assets).', 'PRICE_IMPACT_INVALID');
    const ratioBps = (inputValueUsd - outputValueUsd) / inputValueUsd * 10_000;
    if (!Number.isFinite(ratioBps) || Math.abs(priceImpactBps - ratioBps) > SIGNED_PRICE_IMPACT_TOLERANCE_BPS) {
      fail(`negative price impact ${priceImpactBps} bps is inconsistent with its USD values (${ratioBps.toFixed(2)} bps).`, 'PRICE_IMPACT_INVALID');
    }
    // The same bound applies in both directions: a favorable gap larger than the loss limit more
    // likely means a stale or wrong reference price than a real gain.
    if (-priceImpactBps > plan.maxPriceImpactBps) {
      fail(`favorable price impact ${priceImpactBps} bps is beyond the limit of ${plan.maxPriceImpactBps} bps in either direction.`, 'PRICE_IMPACT_EXCEEDED');
    }
  }
  // The caller's maximum-loss limit is unchanged and applies to every reported value.
  if (priceImpactBps > plan.maxPriceImpactBps) {
    fail(`price impact ${priceImpactBps} bps is above the limit ${plan.maxPriceImpactBps} bps.`, 'PRICE_IMPACT_EXCEEDED');
  }

  const validUntilMs = r.validUntilMs ?? null;
  if (validUntilMs !== null) {
    if (!Number.isSafeInteger(validUntilMs) || validUntilMs <= 0) fail('malformed quote deadline; expected positive Unix milliseconds.', 'QUOTE_TIMING_INVALID');
    if (validUntilMs <= receivedAtMs) fail('quote expired before the provider response was received; recompile before signing.', 'QUOTE_EXPIRED');
  }
  if (!Array.isArray(r.fees)) fail('malformed fee list.', 'FEE_METADATA_INVALID');
  const fees: QuotedFee[] = r.fees.map((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.token !== 'string' || !ADDRESS_RE.test(f.token) || typeof f.recipient !== 'string' || !f.recipient.trim()) fail(`fee ${i} has a malformed token or recipient role.`, 'FEE_METADATA_INVALID');
    if (typeof f.bps !== 'number' || !Number.isFinite(f.bps) || f.bps < 0 || f.bps > 10_000) fail(`fee ${i} has malformed basis points.`, 'FEE_METADATA_INVALID');
    if (f.amountRaw !== null && (typeof f.amountRaw !== 'string' || !UINT_RE.test(f.amountRaw))) fail(`fee ${i} has a malformed amount.`, 'FEE_METADATA_INVALID');
    const recipientAddress = f.recipientAddress ?? null;
    if (recipientAddress !== null && (typeof recipientAddress !== 'string' || !ADDRESS_RE.test(recipientAddress))) fail(`fee ${i} has a malformed recipient address.`, 'FEE_METADATA_INVALID');
    return { token: f.token, recipient: f.recipient, recipientAddress, bps: f.bps, amountRaw: f.amountRaw };
  });
  const reportedWarnings = r.warnings === undefined ? [] : r.warnings;
  if (!Array.isArray(reportedWarnings)) fail('malformed warning list.', 'WARNING_METADATA_INVALID');
  const warnings: ProviderWarning[] = reportedWarnings.map((w, i) => {
    if (!w || typeof w !== 'object' || typeof w.kind !== 'string' || !w.kind.trim() || typeof w.message !== 'string') fail(`warning ${i} has a malformed kind or message.`, 'WARNING_METADATA_INVALID');
    const warning: ProviderWarning = { kind: w.kind, message: w.message };
    for (const key of ['path', 'port', 'fix'] as const) {
      if (w[key] !== undefined) {
        if (typeof w[key] !== 'string') fail(`warning ${i} has a malformed ${key}.`, 'WARNING_METADATA_INVALID');
        warning[key] = w[key];
      }
    }
    return warning;
  });

  let deliveryProof: DeliveryProof | null = null;
  if (r.deliveryProof != null) {
    const d = r.deliveryProof;
    // The verifier trusts the log only from the executor that ran the program for this signer and these legs.
    if (d.signature !== DELIVERY_PROOF_SIGNATURE || typeof d.recipient !== 'string' || d.recipient.toLowerCase() !== plan.signer ||
        !Array.isArray(d.tokens) || d.tokens.length !== plan.legs.length ||
        d.tokens.some((t, i) => typeof t !== 'string' || t.toLowerCase() !== plan.legs[i].token) ||
        typeof r.executor !== 'string' || !ADDRESS_RE.test(r.executor)) {
      fail('delivery proof does not match the plan, its signer or an executor address.', 'OUTPUT_INVALID');
    }
    deliveryProof = { signature: DELIVERY_PROOF_SIGNATURE, recipient: plan.signer, tokens: plan.legs.map(l => l.token) };
  }

  return {
    quote: { plan, provider, legs, priceImpactBps, priceImpactUsd, fees, gasLimit: r.gasLimit, requestedAtMs, receivedAtMs, validUntilMs, warnings },
    transaction: { to: tx.to as Hex, data: tx.data as Hex, value, chainId: plan.chainId },
    approvals,
    executor: r.executor,
    ...(deliveryProof ? { deliveryProof } : {}),
  };
}

/** Plans the purchase and asks the provider for a priced route. Returns the quote only (no transaction). */
export async function quoteBag(bag: BagDocument, req: PurchaseRequest, options: { provider: ComposerProvider; trust: ExecutionTrustPolicy }): Promise<PurchaseQuote> {
  return (await compileBag(bag, req, options)).quote;
}

/** Plans the purchase, compiles it with the provider, checks the answer and returns the unsigned transaction. */
export async function compileBag(bag: BagDocument, req: PurchaseRequest, options: { provider: ComposerProvider; trust: ExecutionTrustPolicy }): Promise<CompiledPurchase> {
  const plan = planPurchase(bag, req);
  const trusted = trustedContracts(plan, options.provider.name, options.trust);
  // The provider response is the first point where the compiled target and
  // approval spenders are available to compare with the caller's allowlists.
  const requestedAtMs = Date.now();
  const result = await options.provider.compile(requestFor(plan));
  return checked(plan, options.provider.name, result, trusted, requestedAtMs, Date.now(), signedUsdImpactProviders.has(options.provider));
}

/** Anything with viem's `getCode`, `readContract` and `call` (a viem PublicClient on the strategy's chain); `getBalance` for a native purchase. */
export interface SimulationClient {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  getBalance?(args: { address: Hex }): Promise<bigint>;
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  /** `stateOverride` is only used with `assumeApprovals` (viem's PublicClient.call supports it). */
  call(args: { account?: Hex; to: Hex; data: Hex; value?: bigint; stateOverride?: { address: Hex; stateDiff: { slot: Hex; value: Hex }[] }[] }): Promise<unknown>;
}

export type SimulationResult =
  | { status: 'OK' }
  | { status: 'QUOTE_EXPIRED'; source: 'PROVIDER' | 'LOCAL_MAX_AGE'; expiresAtMs: number; checkedAtMs: number }
  | { status: 'INVALID_TARGET'; address: Hex }
  | { status: 'NEEDS_APPROVAL'; missing: CompiledPurchase['approvals'] }
  /**
   * `assumeApprovals` only: the purchase call succeeded in an eth_call where the missing allowances were set by a
   * state override. The approvals are still NOT on chain; the wallet must send them first.
   */
  | { status: 'OK_WITH_ASSUMED_APPROVALS'; assumed: CompiledPurchase['approvals']; overrides: { token: Hex; slot: Hex; layout: 'solidity' | 'vyper' }[] }
  /** `assumeApprovals` only: the allowance storage of a token could not be located and verified; nothing was assumed. */
  | { status: 'APPROVAL_OVERRIDE_UNAVAILABLE'; missing: CompiledPurchase['approvals'] }
  | { status: 'INSUFFICIENT_BALANCE'; balanceRaw: bigint; requiredRaw: bigint }
  | { status: 'REVERTED'; reason: string };

export interface SimulateBagOptions {
  client: SimulationClient;
  /** Optional local age limit from quote.requestedAtMs, independent of the provider's deadline. */
  maxQuoteAgeMs?: number;
  /**
   * Read-only pre-flight for a wallet that has not approved yet: when allowances are missing, locate each token's
   * allowance slot (standard Solidity or Vyper mapping layout, base slots 0–20), VERIFY it by reading
   * `allowance(owner, spender)` under the override, then eth_call the purchase with the overrides. Nothing is
   * written anywhere. A token whose slot cannot be verified yields APPROVAL_OVERRIDE_UNAVAILABLE, never a guess.
   */
  assumeApprovals?: boolean;
}

const MAX_ALLOWANCE_SLOT = 20;
const ALLOWANCE_ABI = [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

function allowanceSlot(layout: 'solidity' | 'vyper', base: number, owner: Hex, spender: Hex): Hex {
  const word = (t: 'address' | 'uint256' | 'bytes32', v: unknown) => ({ t, v });
  const enc = (a: ReturnType<typeof word>, b: ReturnType<typeof word>) =>
    keccak256(encodeAbiParameters([{ type: a.t }, { type: b.t }], [a.v, b.v] as never));
  if (layout === 'solidity') {
    const inner = enc(word('address', owner), word('uint256', BigInt(base)));
    return enc(word('address', spender), word('bytes32', inner));
  }
  const inner = enc(word('uint256', BigInt(base)), word('address', owner));
  return enc(word('bytes32', inner), word('address', spender));
}

/** Finds and verifies the storage slot holding allowance(owner, spender) of `token`; null when not found. */
async function locateAllowanceSlot(client: SimulationClient, token: Hex, owner: Hex, spender: Hex, value: bigint): Promise<{ slot: Hex; layout: 'solidity' | 'vyper' } | null> {
  const data = encodeFunctionData({ abi: ALLOWANCE_ABI, functionName: 'allowance', args: [owner, spender] });
  const valueHex = ('0x' + value.toString(16).padStart(64, '0')) as Hex;
  for (const layout of ['solidity', 'vyper'] as const) {
    for (let base = 0; base <= MAX_ALLOWANCE_SLOT; base++) {
      const slot = allowanceSlot(layout, base, owner, spender);
      try {
        const r = (await client.call({ to: token, data, stateOverride: [{ address: token, stateDiff: [{ slot, value: valueHex }] }] })) as { data?: Hex };
        if (r?.data && decodeFunctionResult({ abi: ALLOWANCE_ABI, functionName: 'allowance', data: r.data }) === value) return { slot, layout };
      } catch {
        // not this slot, or the RPC refused the override: keep looking; nothing is assumed
      }
    }
  }
  return null;
}

const ERC20_READ_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * Dry-runs a compiled purchase from the signer with `eth_call` on the caller's client. Read-only. Checks, in
 * order: the client is on the plan's chain, the transaction target is a contract, the signer holds the full input budget (including any kept
 * share), the approvals are in place, then the call itself. Known provider deadlines and an optional local maximum age are checked before reads, before
 * eth_call and after it. A simulation is a point-in-time check, not a guarantee: prices and routes move.
 */
export async function simulateBag(compiled: CompiledPurchase, options: SimulateBagOptions): Promise<SimulationResult> {
  const { client } = options;
  const quote = compiled.quote;
  let expiresAtMs = quote.validUntilMs ?? null;
  let expirySource: 'PROVIDER' | 'LOCAL_MAX_AGE' = 'PROVIDER';
  if (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)) throw new BagSdkError('QUOTE_TIMING_INVALID', 'simulateBag: malformed quote deadline; recompile before signing.');
  if (options.maxQuoteAgeMs !== undefined) {
    if (!Number.isSafeInteger(options.maxQuoteAgeMs) || options.maxQuoteAgeMs < 0) throw new BagSdkError('INVALID_ARGUMENT', 'simulateBag: maxQuoteAgeMs must be a nonnegative safe integer.');
    if (!Number.isSafeInteger(quote.requestedAtMs) || quote.requestedAtMs < 0) throw new BagSdkError('QUOTE_TIMING_INVALID', 'simulateBag: local quote age is unknown; recompile before applying maxQuoteAgeMs.');
    const localDeadline = quote.requestedAtMs + options.maxQuoteAgeMs;
    if (!Number.isSafeInteger(localDeadline)) throw new BagSdkError('QUOTE_TIMING_INVALID', 'simulateBag: local quote deadline exceeds the safe integer range.');
    if (expiresAtMs === null || localDeadline < expiresAtMs) {
      expiresAtMs = localDeadline;
      expirySource = 'LOCAL_MAX_AGE';
    }
  }
  const expired = (): Extract<SimulationResult, { status: 'QUOTE_EXPIRED' }> | null => {
    const checkedAtMs = Date.now();
    return expiresAtMs !== null && checkedAtMs >= expiresAtMs ? { status: 'QUOTE_EXPIRED', source: expirySource, expiresAtMs, checkedAtMs } : null;
  };
  const beforeReads = expired();
  if (beforeReads) return beforeReads;
  const plan = compiled.quote.plan;
  const chainId = await client.getChainId();
  if (chainId !== plan.chainId) throw new BagSdkError('CHAIN_MISMATCH', `simulateBag: client is on chain ${chainId}, the purchase is for ${plan.chainId}.`);
  const signer = plan.signer as Hex;

  // An eth_call to an address without code succeeds and returns nothing, so a missing contract would read as OK.
  // Approval spenders are not checked: Composer's first purchase approves the user's proxy before it is deployed.
  const targetCode = await client.getCode({ address: compiled.transaction.to });
  if (!targetCode || targetCode === '0x') return expired() ?? { status: 'INVALID_TARGET', address: compiled.transaction.to };

  let balance: bigint;
  if (plan.inputKind === 'native') {
    if (!client.getBalance) throw new BagSdkError('CLIENT_CAPABILITY_MISSING', 'simulateBag: a native purchase needs a client with getBalance.');
    // The value only; the network fee comes on top and the wallet shows it.
    balance = BigInt(await client.getBalance({ address: signer }));
  } else {
    balance = BigInt((await client.readContract({ address: plan.inputToken as Hex, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [signer] })) as bigint);
  }
  // The basket also needs the retained input share, even though it is never approved or swapped.
  if (balance < plan.amountRaw) return expired() ?? { status: 'INSUFFICIENT_BALANCE', balanceRaw: balance, requiredRaw: plan.amountRaw };

  const missing: CompiledPurchase['approvals'] = [];
  for (const a of compiled.approvals) {
    const allowance = BigInt((await client.readContract({ address: a.token, abi: ERC20_READ_ABI, functionName: 'allowance', args: [signer, a.spender] })) as bigint);
    if (allowance < a.amountRaw) missing.push(a);
  }
  if (missing.length > 0 && !options.assumeApprovals) return expired() ?? { status: 'NEEDS_APPROVAL', missing };
  if (missing.length > 0) {
    const overrides: { token: Hex; slot: Hex; layout: 'solidity' | 'vyper' }[] = [];
    for (const a of missing) {
      const found = await locateAllowanceSlot(client, a.token, signer, a.spender, a.amountRaw);
      if (!found) return expired() ?? { status: 'APPROVAL_OVERRIDE_UNAVAILABLE', missing };
      overrides.push({ token: a.token, ...found });
    }
    const beforeAssumed = expired();
    if (beforeAssumed) return beforeAssumed;
    const byToken = new Map<Hex, { slot: Hex; value: Hex }[]>();
    missing.forEach((a, i) => byToken.set(a.token, [...(byToken.get(a.token) ?? []), { slot: overrides[i].slot, value: ('0x' + a.amountRaw.toString(16).padStart(64, '0')) as Hex }]));
    try {
      await client.call({
        account: signer, to: compiled.transaction.to, data: compiled.transaction.data, value: compiled.transaction.value,
        stateOverride: [...byToken].map(([address, stateDiff]) => ({ address, stateDiff })),
      });
      return expired() ?? { status: 'OK_WITH_ASSUMED_APPROVALS', assumed: missing, overrides };
    } catch (e) {
      return expired() ?? { status: 'REVERTED', reason: ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split('\n')[0] };
    }
  }

  const beforeCall = expired();
  if (beforeCall) return beforeCall;
  try {
    await client.call({ account: signer, to: compiled.transaction.to, data: compiled.transaction.data, value: compiled.transaction.value });
    return expired() ?? { status: 'OK' };
  } catch (e) {
    return expired() ?? { status: 'REVERTED', reason: ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split('\n')[0] };
  }
}
