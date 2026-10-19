import { chainIdOf, isNativeToken, normalizeAddress } from './chains';
import { computeDefinitionHash } from './definition';
import { resolveV1Rules } from './rules';
import { PartitionError, planPartitionLegs, type PartitionPlan } from './partition';
import { splitByWeight } from './split';
import type { BagDocument, BagIssue, Hex } from './types';
import { validateBag, type TokenInfo } from './validate';

// -----------------------------------------------------------------------------
// Purchase planning: the provider-independent half of quote / simulate /
// compile. Pure. Turns a valid bag.json + a deposit into the exact plan any
// executor must follow:
//
//   - the target allocation (splitByWeight, exact),
//   - the asset that IS the input token, if any: kept, never swapped,
//   - the swap legs and the on-chain partition that divides the swapped
//     amount between them (partition.ts: the split a bps-ratio executor such
//     as LI.FI Composer performs; within the v1 execution bound),
//   - the slippage and price-impact limits, which a caller can only tighten.
//
// Accounting boundary (normative): a purchase built with the SDK is an
// execution of the STRATEGY, delivered straight to the signer's wallet. It is
// not a BAG position. BAG's ledger, cost basis, P&L, redemption and creator
// fee apply only to executions BAG itself originates and records. The plan
// says so in `accounting`.
// -----------------------------------------------------------------------------

/** Execution limits of the SDK. A caller may pass stricter values, never looser ones. */
export const V1_EXECUTION_POLICY = Object.freeze({
  /** Per-swap slippage ceiling, whatever a definition declares (BAG applies the same cap). */
  maxSlippageBps: 300,
  /** Whole-purchase price impact ceiling (LI.FI Composer's default limit, which BAG keeps). */
  maxPriceImpactBps: 500,
});

/** A purchase made through the SDK is not a BAG position. See the module comment. */
export const SDK_EXECUTION_ACCOUNTING = 'NOT_BAG_ACCOUNTED' as const;

export interface PurchaseRequest {
  /**
   * What the buyer pays with, on the strategy's chain: an ERC-20 address, or NATIVE_TOKEN (the zero address) for
   * the chain's native coin (ETH), which is sent as the transaction's value with no approval.
   */
  inputToken: string;
  /** Deposit, in the input token's smallest unit. */
  amountRaw: bigint;
  /** The wallet that will sign; the assets are delivered to it. */
  signer: string;
  /** Tighter per-swap slippage than the definition's (never looser). */
  slippageBps?: number;
  /** Tighter price-impact limit than the SDK's (never looser). */
  maxPriceImpactBps?: number;
  /** If given, every asset swapped into must be in this list (the caller's own allowlist). */
  allowedTokens?: string[];
  /** Token decimals for validateBag (see readTokenDecimals). */
  tokens?: TokenInfo[];
}

export interface PlannedLeg {
  /** Asset bought, lowercase. */
  token: string;
  /** Exact target share of the deposit this leg should spend (splitByWeight). */
  targetInputRaw: bigint;
  /** This leg's share of the swapped amount, in whole bps (largest remainder; the legs sum to 10000). */
  legBps: number;
}

export interface PurchasePlan {
  definitionHash: Hex;
  chainId: number;
  inputToken: string;
  /** 'native': paid as the transaction value, no approval. 'erc20': pulled after an approval, no value. */
  inputKind: 'native' | 'erc20';
  signer: string;
  amountRaw: bigint;
  /** Target amount of the input token that stays in the wallet because the strategy holds the input token itself. */
  kept: { token: string; amountRaw: bigint } | null;
  /** Amount actually swapped (`amountRaw − kept`). */
  swapAmountRaw: bigint;
  /** Canonical order: token address ascending. */
  legs: PlannedLeg[];
  /** The `core.partition` node(s) that divide `swapAmountRaw` across `legs` (partition.ts `planPartition`). */
  partition: PartitionPlan;
  slippageBps: number;
  maxPriceImpactBps: number;
  accounting: typeof SDK_EXECUTION_ACCOUNTING;
}

export class PurchasePlanError extends Error {
  constructor(readonly issues: BagIssue[]) {
    super(`Cannot plan this purchase: ${issues.map((i) => `${i.code} (${i.path})`).join(', ')}`);
    this.name = 'PurchasePlanError';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Plans a purchase of a valid bag.json. Throws PurchasePlanError with every reason it cannot. */
export function planPurchase(bag: BagDocument, req: PurchaseRequest): PurchasePlan {
  const issues: BagIssue[] = [];
  const err = (code: string, path: string, message: string) => issues.push({ code, severity: 'error', path, message });

  const validation = validateBag(bag, { tokens: req.tokens });
  issues.push(...validation.errors);

  if (!ADDRESS_RE.test(req.inputToken)) err('INVALID_INPUT_TOKEN', 'request.inputToken', 'inputToken must be an ERC-20 address or NATIVE_TOKEN.');
  if (!ADDRESS_RE.test(req.signer)) err('INVALID_SIGNER', 'request.signer', 'signer must be an address.');
  if (typeof req.amountRaw !== 'bigint' || req.amountRaw <= BigInt(0)) err('INVALID_AMOUNT', 'request.amountRaw', 'amountRaw must be a positive bigint.');

  const rules = resolveV1Rules(bag.definition);
  const policyCap = V1_EXECUTION_POLICY.maxSlippageBps;
  let slippageBps = Math.min(rules.swapSlippageBps.value, policyCap);
  if (req.slippageBps !== undefined) {
    if (!Number.isInteger(req.slippageBps) || req.slippageBps < 1) err('INVALID_SLIPPAGE', 'request.slippageBps', 'slippageBps must be a positive integer.');
    else if (req.slippageBps > slippageBps) err('LOOSER_THAN_POLICY', 'request.slippageBps', `slippageBps ${req.slippageBps} is looser than the allowed ${slippageBps}.`);
    else slippageBps = req.slippageBps;
  }
  let maxPriceImpactBps: number = V1_EXECUTION_POLICY.maxPriceImpactBps;
  if (req.maxPriceImpactBps !== undefined) {
    if (!Number.isInteger(req.maxPriceImpactBps) || req.maxPriceImpactBps < 1) err('INVALID_PRICE_IMPACT', 'request.maxPriceImpactBps', 'maxPriceImpactBps must be a positive integer.');
    else if (req.maxPriceImpactBps > maxPriceImpactBps) err('LOOSER_THAN_POLICY', 'request.maxPriceImpactBps', `maxPriceImpactBps ${req.maxPriceImpactBps} is looser than the allowed ${maxPriceImpactBps}.`);
    else maxPriceImpactBps = req.maxPriceImpactBps;
  }

  if (issues.length > 0) throw new PurchasePlanError(issues);

  const input = normalizeAddress(req.inputToken);
  const target = splitByWeight(req.amountRaw, bag.definition);
  const chain = bag.definition.chain;
  const keyOf = (address: string) => `${chain}:${normalizeAddress(address)}`;

  const keptRaw = target.get(keyOf(input)) ?? null;
  // Native ETH is only ever swapped: a kept share would leave the strategy holding the native coin, which the
  // strategy's own assets (ERC-20s) never are. Pay with an ERC-20 the strategy holds instead.
  if (isNativeToken(input) && keptRaw !== null) err('NATIVE_INPUT_KEPT', 'request.inputToken', 'The strategy holds the native coin itself; a native payment cannot be kept.');
  const swapAssets = bag.definition.assets
    .map((a) => ({ token: normalizeAddress(a.address), targetInputRaw: target.get(keyOf(a.address))! }))
    .filter((a) => a.token !== input)
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));

  if (req.allowedTokens) {
    const allowed = new Set(req.allowedTokens.map(normalizeAddress));
    swapAssets.forEach((a) => !allowed.has(a.token) && err('TOKEN_NOT_ALLOWED', 'definition.assets', `${a.token} is not in the caller's allowedTokens.`));
  }
  swapAssets.forEach((a) => a.targetInputRaw <= BigInt(0) && err('AMOUNT_TOO_SMALL', 'request.amountRaw', `The deposit gives ${a.token} nothing to swap.`));
  if (swapAssets.length === 0) err('NOTHING_TO_SWAP', 'definition.assets', 'The strategy holds only the input token.');

  if (issues.length > 0) throw new PurchasePlanError(issues);

  // Whole-bp leg weights from the exact target amounts, by largest remainder (partition.ts), as BAG builds them.
  let partitioned: ReturnType<typeof planPartitionLegs> | null = null;
  try {
    partitioned = planPartitionLegs(swapAssets.map((a) => ({ token: a.token, amountRaw: a.targetInputRaw })));
  } catch (e) {
    if (!(e instanceof PartitionError)) throw e;
    err(e.code === 'LEG_BELOW_ONE_BP' ? 'AMOUNT_TOO_SMALL' : 'UNPLANNABLE_SPLIT', 'request.amountRaw', `${e.message} Deposit more.`);
  }
  if (issues.length > 0) throw new PurchasePlanError(issues);

  return {
    definitionHash: computeDefinitionHash(bag.definition),
    chainId: chainIdOf(chain),
    inputToken: input,
    inputKind: isNativeToken(input) ? 'native' : 'erc20',
    signer: normalizeAddress(req.signer),
    amountRaw: req.amountRaw,
    kept: keptRaw === null ? null : { token: input, amountRaw: keptRaw },
    swapAmountRaw: partitioned!.totalRaw,
    legs: partitioned!.legs.map((l) => ({ token: l.token, targetInputRaw: l.amountRaw, legBps: l.legBps })),
    partition: partitioned!.partition,
    slippageBps,
    maxPriceImpactBps,
    accounting: SDK_EXECUTION_ACCOUNTING,
  };
}
