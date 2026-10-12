import {
  DEFAULT_SHARE_BOOTSTRAP_POLICY,
  DepositQuote,
  NavResult,
  RedeemQuote,
  ShareBootstrapPolicy,
  SharePrice,
  ShareSupply,
} from '@/types/basket-protocol';
import { calculateNavPerShare, formatNavValue, NAV_VALUE_DECIMALS, ZeroShareSupplyError } from '../nav/nav';
import { isValidDecimalString, toProtocolPrice } from '../pricing/price-precision';

// -----------------------------------------------------------------------------
// Phase 9 — Bag Share Accounting Layer.
//
//   Bag NAV + Share Supply
//     ↓
//   NAV per Share (Phase 6's calculateNavPerShare() — reused, not
//                  reimplemented: spec section 3)
//     ↓
//   Deposit Quote / Redeem Quote
//
// Every function here is PURE MATH — no mutation, no persistence, no
// minting, no burning, no wallet, no chain (spec sections 12/13/17).
// `DepositQuote` ≠ an actual deposit; `RedeemQuote` ≠ an actual redemption.
// Turning a quote into a real state change is a later phase's "Mint/Redeem
// service" (spec section 12) — nothing in this file does that.
//
// ----------------------------- Decimal model ------------------------------
//
// Four DIFFERENT decimal concepts appear in this file (spec section 6) and
// are never conflated:
//   - NAV internal decimals   → `NAV_VALUE_DECIMALS` (nav.ts) — the fixed
//     18-place scale every NAV/price figure is normalized to.
//   - Share decimals          → `ShareSupply.shareDecimals` /
//     `DepositQuote.shareDecimals` — an ERC-4626-style share token's own
//     decimals (may differ per Bag; never assumed to be 18).
//   - Quote currency decimals → NOT modeled as a raw-unit conversion in
//     this phase at all. `DepositQuote.depositAmount` and
//     `RedeemQuote.grossValue` are plain human decimal strings (the same
//     convention `AssetPrice.price` already uses), because this phase
//     never settles a real quote-currency transfer — no USDC moves, so
//     there is no raw-unit USDC amount to represent yet. A future
//     settlement phase, which DOES move real USDC, is where "USDC has 6
//     decimals" first becomes a raw-unit conversion this layer needs —
//     deliberately not built ahead of the feature that needs it.
//   - Asset decimals          → `RecipeAsset.decimals`/`AssetHolding.
//     decimals` (Phase 1/6/7/8) — untouched by this file; NAV already
//     folded these in before a `NavResult` ever reaches here.
// -----------------------------------------------------------------------------

export class InvalidDepositAmountError extends Error {
  constructor(amount: string) {
    super(`"${amount}" is not a valid non-negative decimal deposit amount.`);
    this.name = 'InvalidDepositAmountError';
  }
}

/**
 * A `depositAmount` of exactly `"0"` (spec section 13/19 — "Zero deposit:
 * Rejected"). Distinct from `InvalidDepositAmountError`: a `"0"` amount is
 * a perfectly well-FORMED decimal string, just a meaningless request — a
 * $0 deposit quote would either silently mint 0 shares (normal pricing)
 * or, worse, mint a nonzero share count for zero value if some future
 * bootstrap policy set `initialSharePrice` to a value that floors oddly.
 * Rejecting explicitly avoids ever having to reason about that.
 */
export class ZeroDepositAmountError extends Error {
  constructor() {
    super('Deposit amount must be greater than zero — a $0 deposit quote is rejected, not silently priced at 0 shares.');
    this.name = 'ZeroDepositAmountError';
  }
}

export class InvalidShareQuantityError extends Error {
  constructor(sharesRaw: string) {
    super(`"${sharesRaw}" is not a valid non-negative integer raw share quantity.`);
    this.name = 'InvalidShareQuantityError';
  }
}

/**
 * A `sharesRaw` of exactly `"0"` (spec section 13/19 — "Zero redeem:
 * Rejected"). Distinct from `InvalidShareQuantityError` for the same
 * reason `ZeroDepositAmountError` is distinct from
 * `InvalidDepositAmountError` above: `"0"` is a well-formed raw share
 * quantity, just a meaningless redemption request.
 */
export class ZeroRedeemAmountError extends Error {
  constructor() {
    super('Redeem share quantity must be greater than zero — a 0-share redemption is rejected, not silently quoted at $0.');
    this.name = 'ZeroRedeemAmountError';
  }
}

export class InsufficientSharesError extends Error {
  constructor(
    public readonly requestedRaw: string,
    public readonly availableRaw: string
  ) {
    super(`Cannot redeem ${requestedRaw} raw shares — only ${availableRaw} are outstanding.`);
    this.name = 'InsufficientSharesError';
  }
}

/**
 * Zero outstanding shares but a POSITIVE NAV: holdings exist that nobody owns
 * (e.g. a partially-executed purchase reconciled its verified holdings without
 * minting — see RECONCILIATION_REQUIRED). Bootstrapping here would hand that
 * orphaned value to whoever deposits next, for free. Fail closed until an
 * operator resolves the orphaned holdings.
 */
export class OrphanedNavError extends Error {
  constructor(public readonly grossNav: string) {
    super(`Bag has zero outstanding shares but NAV ${grossNav} > 0 — refusing to bootstrap (the next depositor would receive value nobody paid for).`);
    this.name = 'OrphanedNavError';
  }
}

/** Shares outstanding but NAV is zero: a share price of 0 would mint unbounded shares. Never quoted. */
export class ZeroNavError extends Error {
  constructor() {
    super('Bag NAV is zero while shares are outstanding — a deposit cannot be priced (it would mint unbounded shares).');
    this.name = 'ZeroNavError';
  }
}

export class InvalidBootstrapPolicyError extends Error {
  constructor(initialSharePrice: string) {
    super(`ShareBootstrapPolicy.initialSharePrice ("${initialSharePrice}") must be a positive decimal string.`);
    this.name = 'InvalidBootstrapPolicyError';
  }
}

/** Mirrors nav.ts's own (private) raw-quantity convention: a non-negative base-10 integer string, no sign, no decimal point. */
const NON_NEGATIVE_INTEGER_RE = /^\d+$/;

function parseSharesRaw(sharesRaw: string): bigint {
  if (!NON_NEGATIVE_INTEGER_RE.test(sharesRaw.trim())) {
    throw new InvalidShareQuantityError(sharesRaw);
  }
  return BigInt(sharesRaw);
}

/** Validates AND rejects zero (spec section 13/19) — every caller of this needs both checks, so they live together rather than being duplicated at each call site. */
function parseDepositAmount(amount: string): bigint {
  if (!isValidDecimalString(amount) || amount.trim().startsWith('-')) {
    throw new InvalidDepositAmountError(amount);
  }
  const scaled = toProtocolPrice(amount, NAV_VALUE_DECIMALS);
  if (scaled === BigInt(0)) {
    throw new ZeroDepositAmountError();
  }
  return scaled;
}

function isZeroSupply(shareSupply: ShareSupply): boolean {
  return parseSharesRaw(shareSupply.totalSharesRaw) === BigInt(0);
}

/**
 * Current NAV-per-share for a Bag with a non-zero share supply. A thin,
 * traceable wrapper around `calculateNavPerShare()` (Phase 6, nav.ts) — no
 * new math, per spec section 3. Throws `ZeroShareSupplyError` when
 * `shareSupply.totalSharesRaw` is `"0"`, exactly as `calculateNavPerShare()`
 * already does (spec section 7 — this behavior is preserved, not
 * special-cased away). Use `getDepositQuote()` for the zero-supply
 * (bootstrap) case instead of calling this directly.
 */
export function getSharePrice(nav: NavResult, shareSupply: ShareSupply): SharePrice {
  const value = calculateNavPerShare(nav, shareSupply.totalSharesRaw, shareSupply.shareDecimals);
  return { asOf: nav.asOf, quoteCurrency: nav.quoteCurrency, value };
}

/**
 * Quotes how many shares a given quote-currency `depositAmount` would mint
 * right now — MATH ONLY, no mutation of `nav`, `shareSupply`, or anything
 * else (spec section 13).
 *
 * Two pricing paths, both exact bigint arithmetic, never a JS `number`:
 *   - Non-zero supply: priced at the real `getSharePrice()` (which itself
 *     reuses `calculateNavPerShare()`).
 *   - Zero supply (spec section 7/8 — "bootstrap"): priced at
 *     `bootstrapPolicy.initialSharePrice` instead, since there is no real
 *     NAV-per-share yet to divide by. `DepositQuote.isBootstrap` tells the
 *     caller which path produced the quote.
 *
 * `sharesRaw = floor(depositAmount / sharePrice × 10^shareDecimals)` —
 * truncated, never rounded (spec section 10), same "truncate beyond
 * exactness" policy `toProtocolPrice()`/`toNavValue()` already use
 * elsewhere in this codebase.
 */
export function getDepositQuote(
  nav: NavResult,
  shareSupply: ShareSupply,
  depositAmount: string,
  bootstrapPolicy: ShareBootstrapPolicy = DEFAULT_SHARE_BOOTSTRAP_POLICY
): DepositQuote {
  const depositAmountScaled = parseDepositAmount(depositAmount);

  const navScaled = toProtocolPrice(nav.grossNav, NAV_VALUE_DECIMALS);

  let sharePriceStr: string;
  let isBootstrap: boolean;
  let sharesRawScaled: bigint;

  if (isZeroSupply(shareSupply)) {
    if (navScaled > BigInt(0)) throw new OrphanedNavError(nav.grossNav);
    if (!isValidDecimalString(bootstrapPolicy.initialSharePrice) || bootstrapPolicy.initialSharePrice.trim().startsWith('-')) {
      throw new InvalidBootstrapPolicyError(bootstrapPolicy.initialSharePrice);
    }
    sharePriceStr = bootstrapPolicy.initialSharePrice;
    isBootstrap = true;
    const sharePriceScaled = toProtocolPrice(sharePriceStr, NAV_VALUE_DECIMALS);
    if (sharePriceScaled <= BigInt(0)) {
      throw new InvalidBootstrapPolicyError(sharePriceStr);
    }
    sharesRawScaled = (depositAmountScaled * BigInt(10) ** BigInt(shareSupply.shareDecimals)) / sharePriceScaled;
  } else {
    if (navScaled <= BigInt(0)) throw new ZeroNavError();
    // Display price only — truncated at NAV_VALUE_DECIMALS.
    sharePriceStr = calculateNavPerShare(nav, shareSupply.totalSharesRaw, shareSupply.shareDecimals);
    isBootstrap = false;
    // Shares from the EXACT ratio, floored once: shares = deposit × supply / NAV.
    // Dividing by the already-truncated display price instead (a price rounded
    // DOWN) minted a few raw units MORE than the deposit bought — value taken
    // from existing holders. Flooring the exact ratio always rounds in the
    // Bag's favor: shares × NAV ≤ deposit × supply.
    sharesRawScaled = (depositAmountScaled * parseSharesRaw(shareSupply.totalSharesRaw)) / navScaled;
  }

  return {
    asOf: nav.asOf,
    quoteCurrency: nav.quoteCurrency,
    depositAmount,
    sharePrice: sharePriceStr,
    sharesRaw: sharesRawScaled.toString(),
    shareDecimals: shareSupply.shareDecimals,
    isBootstrap,
  };
}

/**
 * The share quote a purchase books. Accounting V2 (D1, docs/ACCOUNTING_V2_DESIGN.md §4.1): shares are a mechanical
 * counter, never a value, so a purchase is not refused because that counter no longer matches the Bag's holdings:
 * zero shares with holdings left over (holdings that outlived their shares after a full exit), or shares outstanding
 * with holdings at zero (every tracked token left the wallets). In both cases the counter restarts at the bootstrap
 * price for this deposit. Nobody's value moves: each position is valued from its own holdings.
 */
export function getPurchaseDepositQuote(
  nav: NavResult,
  shareSupply: ShareSupply,
  depositAmount: string,
  bootstrapPolicy: ShareBootstrapPolicy = DEFAULT_SHARE_BOOTSTRAP_POLICY
): DepositQuote {
  try {
    return getDepositQuote(nav, shareSupply, depositAmount, bootstrapPolicy);
  } catch (err) {
    if (!(err instanceof OrphanedNavError) && !(err instanceof ZeroNavError)) throw err;
    return getDepositQuote({ ...nav, grossNav: '0' }, { ...shareSupply, totalSharesRaw: '0' }, depositAmount, bootstrapPolicy);
  }
}

/**
 * Quotes the quote-currency value of redeeming `sharesRaw` shares right
 * now — MATH ONLY, no mutation, no burn (spec section 13).
 *
 * Redeeming exactly `0` shares is rejected (`ZeroRedeemAmountError`, spec
 * section 13/19), same policy as a $0 deposit — a 0-share redemption is
 * not a meaningful request to quote. Redeeming a positive amount from a
 * zero-supply Bag is a genuine error (`ZeroShareSupplyError`, via
 * `getSharePrice()` — there is no bootstrap path for redemption, only for
 * deposit) or, if the amount simply exceeds what's outstanding,
 * `InsufficientSharesError`.
 *
 * `grossValue = sharesRaw / 10^shareDecimals × sharePrice`, exact bigint
 * arithmetic, truncated at `NAV_VALUE_DECIMALS` (spec section 10).
 *
 * Accounting V2 / A4: NOT a position value (docs/ACCOUNTING_V2_DESIGN.md §4.1).
 * Used only as the legacy fee basis of performance-fee redemptions; positions
 * are valued from holdings (accounting/position-value.ts).
 */
export function getRedeemQuote(nav: NavResult, shareSupply: ShareSupply, sharesRaw: string): RedeemQuote {
  const requested = parseSharesRaw(sharesRaw);

  if (requested === BigInt(0)) {
    throw new ZeroRedeemAmountError();
  }

  const available = parseSharesRaw(shareSupply.totalSharesRaw);
  if (requested > available) {
    throw new InsufficientSharesError(sharesRaw, shareSupply.totalSharesRaw);
  }

  const sharePrice = getSharePrice(nav, shareSupply); // throws ZeroShareSupplyError if available === 0 — unreachable here since requested > 0 and requested <= available would already have thrown above
  const sharePriceScaled = toProtocolPrice(sharePrice.value, NAV_VALUE_DECIMALS);

  const grossValueScaled = (requested * sharePriceScaled) / BigInt(10) ** BigInt(shareSupply.shareDecimals);

  return {
    asOf: nav.asOf,
    quoteCurrency: nav.quoteCurrency,
    sharesRaw,
    shareDecimals: shareSupply.shareDecimals,
    sharePrice: sharePrice.value,
    grossValue: formatNavValue(grossValueScaled),
  };
}

export { ZeroShareSupplyError };
