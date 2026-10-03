export function formatAge(isoDate: string): string {
  const joined = new Date(isoDate).getTime();
  const days = Math.max(0, Math.round((Date.now() - joined) / (24 * 60 * 60 * 1000)));
  if (days < 30) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? '' : 's'}`;
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${n}`;
}

/** A dollar amount for display (no `$`): compact from 1,000 up, otherwise 2 decimals — so a TVL of 2.99630519 reads "3.00", not every float digit. */
export function formatUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return Math.abs(n) >= 1_000 ? formatCompact(n) : n.toFixed(2);
}

// -----------------------------------------------------------------------------
// Phase 13 cleanup — decimal-string-safe display formatters for the
// protocol's financial path (raw-unit bigint amounts, and the plain
// decimal-string values `lib/domain/basket-protocol/shares/shares.ts`
// already produces, e.g. `DepositQuote.sharePrice`). Every function below
// works entirely on strings/bigints, never on a JS `number` — the project
// convention "no JS number on the financial path" (see e.g.
// lib/domain/basket-protocol/shares/shares.ts's own module doc) applies
// to DISPLAY too, not only to the math that produces the values: a
// `Number(rawBigString) / Number(10 ** decimals)` conversion silently
// loses precision for large share quantities or high-decimal raw amounts
// well before it ever reaches a `.toFixed()`/`.toLocaleString()` call —
// the loss happens at the `Number(...)` step itself.
//
// All three truncate (never round), matching the same truncate-only
// policy the domain layer already uses for `sharesToMint`/`grossValue`
// (shares.ts, spec section 6/10) — so a displayed value never implies
// more precision, or a different quoted amount, than what was actually
// computed.
// -----------------------------------------------------------------------------

function addThousandsSeparators(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Splits an exact decimal STRING (e.g. `"10.000000000000000000"` or plain
 * `"1000"`) into `{ integerPart, fractionDigits }` via string operations
 * only — no `parseFloat`/`Number` anywhere on the path. `fractionDigits`
 * is the full fractional-digit string exactly as given, unpadded and
 * untruncated; callers that need a fixed display width truncate/pad it
 * themselves (see `formatDecimalString` below).
 */
function splitDecimalString(value: string): { negative: boolean; integerPart: string; fractionDigits: string } {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [integerPart, fractionDigits = ''] = unsigned.split('.');
  return { negative, integerPart: integerPart || '0', fractionDigits };
}

export interface DecimalDisplayOptions {
  /** Max fractional digits to show, truncated (never rounded). Defaults to 4. */
  maxFractionDigits?: number;
  /** Pad the fraction out to exactly `maxFractionDigits` with trailing zeros instead of trimming them (e.g. for currency, "$10.00" not "$10"). Defaults to false. */
  padFraction?: boolean;
  /** Prefix, e.g. `"$"` — applied after the sign, before the digits. */
  prefix?: string;
}

/**
 * Formats an already-human decimal STRING (e.g. `SharePrice.value`,
 * `DepositQuote.sharePrice`, `RedeemQuote.grossValue` — all plain decimal
 * strings, never raw units) for display: thousands separators on the
 * integer part, the fraction truncated (never rounded) to
 * `maxFractionDigits`. Entirely string-based — see this section's module
 * doc for why that matters here.
 */
export function formatDecimalString(value: string, options: DecimalDisplayOptions = {}): string {
  const maxFractionDigits = options.maxFractionDigits ?? 4;
  const { negative, integerPart, fractionDigits } = splitDecimalString(value);

  let fraction = fractionDigits.slice(0, maxFractionDigits);
  if (options.padFraction) {
    fraction = fraction.padEnd(maxFractionDigits, '0');
  } else {
    fraction = fraction.replace(/0+$/, '');
  }

  const sign = negative ? '-' : '';
  const prefix = options.prefix ?? '';
  const grouped = addThousandsSeparators(integerPart);
  return `${sign}${prefix}${grouped}${fraction ? '.' + fraction : ''}`;
}

/** `formatDecimalString()` for a USD amount specifically — always 2 fraction digits, padded, `"$"`-prefixed. Truncated, never rounded (see this section's module doc): a $9.999 quote displays as "$9.99", not a rounded-up "$10.00" that would overstate what was actually quoted. */
export function formatDecimalStringUsd(value: string): string {
  return formatDecimalString(value, { maxFractionDigits: 2, padFraction: true, prefix: '$' });
}

/**
 * Formats a RAW-unit integer string (e.g. `DepositAllocation.valueRaw`,
 * `DepositQuote.sharesRaw`) at `decimals` precision for display —
 * bigint-based integer/fraction split, then the same truncate-and-group
 * formatting as `formatDecimalString()`. This is the raw-unit counterpart
 * to that function; use this one whenever the value in hand is a raw
 * integer string that still needs `decimals` applied, and
 * `formatDecimalString()` when it's already a human decimal string.
 */
export function formatRawAmount(raw: string, decimals: number, options: DecimalDisplayOptions = {}): string {
  const value = BigInt(raw);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const divisor = BigInt(10) ** BigInt(decimals);
  const integerPart = (abs / divisor).toString();
  const fractionPart = (abs % divisor).toString().padStart(decimals, '0');

  const maxFractionDigits = options.maxFractionDigits ?? 4;
  let fraction = fractionPart.slice(0, maxFractionDigits);
  if (options.padFraction) {
    fraction = fraction.padEnd(maxFractionDigits, '0');
  } else {
    fraction = fraction.replace(/0+$/, '');
  }

  const sign = negative ? '-' : '';
  const prefix = options.prefix ?? '';
  const grouped = addThousandsSeparators(integerPart);
  return `${sign}${prefix}${grouped}${fraction ? '.' + fraction : ''}`;
}

/** `formatRawAmount()` for a USD amount specifically — same 2-decimal, padded, `"$"`-prefixed convention as `formatDecimalStringUsd()`, for a raw-unit value that still needs `decimals` applied first. */
export function formatRawAmountUsd(raw: string, decimals: number): string {
  return formatRawAmount(raw, decimals, { maxFractionDigits: 2, padFraction: true, prefix: '$' });
}

/**
 * The input-side counterpart to `formatRawAmount()`: turns a human decimal
 * string a user typed (e.g. `"12.5"`) into a raw integer string at
 * `decimals` precision (e.g. `"12500000000000000000"` at 18 decimals) —
 * exact string/digit manipulation, never `Number(...) * 10 ** decimals`
 * (that reintroduces exactly the float-precision loss this codebase's
 * financial-path convention exists to avoid — see
 * PurchasePreviewModal.tsx's module doc). Any fractional digits beyond
 * `decimals` are TRUNCATED, never rounded — typing more precision than the
 * unit supports should never silently round UP into more raw units than
 * the person actually asked for. Returns `null` for empty/invalid input
 * (not `"0"` — a caller needs to tell "nothing typed yet" apart from "typed
 * a genuine zero").
 */
export function parseDecimalToRaw(value: string, decimals: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || !/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') return null;

  const [wholePart, fractionPart = ''] = trimmed.split('.');
  const wholeDigits = wholePart === '' ? '0' : wholePart;
  const fractionDigits = fractionPart.slice(0, decimals).padEnd(decimals, '0');
  const combined = `${wholeDigits}${fractionDigits}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

/**
 * A Bag's 7D / 30D / YTD returns for display: recorded NAV history when the
 * API sent it (null = history doesn't reach back that far), otherwise the
 * reported figures of demo Bags. A live Bag with neither has no figures
 * (null) rather than a made-up +0.0%.
 */
export function bagReturns(bag: {
  performance7d: number;
  performance30d: number;
  performanceYtd: number;
  performanceRecorded?: { '7D': number | null; '30D': number | null; YTD: number | null };
}): { d7: number | null; d30: number | null; ytd: number | null } {
  if (bag.performanceRecorded) {
    return { d7: bag.performanceRecorded['7D'], d30: bag.performanceRecorded['30D'], ytd: bag.performanceRecorded.YTD };
  }
  if (bag.performance7d === 0 && bag.performance30d === 0 && bag.performanceYtd === 0) return { d7: null, d30: null, ytd: null };
  return { d7: bag.performance7d, d30: bag.performance30d, ytd: bag.performanceYtd };
}

/** "+1.2%" / "-0.4%" / "—" for a missing figure. */
export function formatReturn(pct: number | null): string {
  return pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}
