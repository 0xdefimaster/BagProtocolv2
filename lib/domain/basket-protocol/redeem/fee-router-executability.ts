import { referenceValueRaw, selectRedeemLegQuote, tokenAmountForValue, type TierQuote } from './redeem-quote-quality';

// -----------------------------------------------------------------------------
// Would signFeeAttestation sign a fee-paying sale of this token, at this size —
// and if not, why? (docs/FEE_ECONOMICS_DESIGN.md, B0 live-validation
// prerequisite.) Pure: the quoter is injected, so this runs against a mock in
// tests and against the real Uniswap v3 QuoterV2 (read-only eth_call) in
// scripts/check-fee-router-liquidity.ts.
//
// It applies the attestation's own leg rule (redeem-quote-quality.ts): quote
// every fee tier, take the best, compare with the value at BAG's verified price,
// refuse beyond the allowed deviation. The representative size is that many USD
// of the token at the verified price.
//
//   PASS    the attestation would sign it (best quote within the allowed deviation)
//   UNSAFE  a quote exists but is too far below the verified value — refused
//           (before the price-quality rule, the first run on 2026-10-05 showed
//           such sales would have been signed at up to a ~99% loss)
//   FAIL    no quote at all (NO_QUOTE), or no verified price (PRICE_UNAVAILABLE)
//   INDETERMINATE  the RPC failed: no reliable result either way — not "impossible"
// -----------------------------------------------------------------------------

export type QuoteFn = (args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; feeTier: number }) => Promise<{ amountOut: bigint } | null>;

export interface ExecutabilityInput {
  token: { symbol: string; address: `0x${string}`; decimals: number };
  usdg: { address: `0x${string}`; decimals: number };
  /** Representative sale size in USD. */
  sizeUsd: number;
  /** BAG's verified price (USD), or null when the price provider has none. */
  priceUsd: string | null;
  /** Why there is no price, when there is none. */
  priceError?: string;
  slippageBps: number;
  feeTiers: readonly number[];
  maxDeviationBps: number;
  quote: QuoteFn;
}

export type ExecutabilityReason = 'OK' | 'SETTLEMENT_TOKEN' | 'PRICE_DEVIATION' | 'NO_QUOTE' | 'PRICE_UNAVAILABLE' | 'RPC_ERROR';
export type ExecutabilityStatus = 'PASS' | 'UNSAFE' | 'FAIL' | 'INDETERMINATE';

export interface ExecutabilityResult {
  symbol: string;
  address: string;
  sizeUsd: number;
  status: ExecutabilityStatus;
  /** Whether the attestation would sign this leg. */
  executable: boolean;
  reason: ExecutabilityReason;
  /** The best tier (the one the attestation uses) and its quote. */
  feeTier: number | null;
  tokenAmountRaw: string | null;
  quoteRaw: string | null;
  /** The leg's value at the verified price, in USDG raw units. */
  referenceRaw: string | null;
  /** How far the best quote is below the reference, in bps. */
  deviationBps: number | null;
  /** quote × (1 − slippage): the leg's minimum output when signed. */
  grossMinimumRaw: string | null;
  error?: string;
}

export async function checkFeeRouterExecutability(input: ExecutabilityInput): Promise<ExecutabilityResult> {
  const { token, usdg, sizeUsd, priceUsd, slippageBps, feeTiers, maxDeviationBps, quote } = input;
  const base = { symbol: token.symbol, address: token.address, sizeUsd, feeTier: null, tokenAmountRaw: null, quoteRaw: null, referenceRaw: null, deviationBps: null, grossMinimumRaw: null };
  // A holding already in USDG is a "no swap" leg in RedeemFeeRouter: always signed, nothing to quote.
  if (token.address.toLowerCase() === usdg.address.toLowerCase()) return { ...base, status: 'PASS', executable: true, reason: 'SETTLEMENT_TOKEN' };
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) throw new Error('sizeUsd must be positive');
  if (priceUsd === null) return { ...base, status: 'FAIL', executable: false, reason: 'PRICE_UNAVAILABLE', ...(input.priceError ? { error: input.priceError } : {}) };

  const amount = tokenAmountForValue(sizeUsd, token.decimals, priceUsd);
  const referenceRaw = referenceValueRaw(amount, token.decimals, priceUsd, usdg.decimals);
  const sized = { tokenAmountRaw: amount.toString(), referenceRaw: referenceRaw.toString() };
  try {
    const quotes: TierQuote[] = [];
    for (const feeTier of feeTiers) {
      const r = await quote({ tokenIn: token.address, tokenOut: usdg.address, amountIn: amount, feeTier });
      if (r) quotes.push({ feeTier, amountOut: r.amountOut });
    }
    const s = selectRedeemLegQuote(quotes, referenceRaw, maxDeviationBps);
    if (!s.ok && s.reason === 'NO_QUOTE') return { ...base, ...sized, status: 'FAIL', executable: false, reason: 'NO_QUOTE' };
    const picked = { feeTier: s.ok || s.reason === 'PRICE_DEVIATION' ? s.feeTier : null, quoteRaw: s.ok || s.reason === 'PRICE_DEVIATION' ? s.quoteRaw.toString() : null, deviationBps: s.ok || s.reason === 'PRICE_DEVIATION' ? s.deviationBps : null };
    if (!s.ok) return { ...base, ...sized, ...picked, status: 'UNSAFE', executable: false, reason: 'PRICE_DEVIATION' };
    return {
      ...base,
      ...sized,
      ...picked,
      status: 'PASS',
      executable: true,
      reason: 'OK',
      grossMinimumRaw: ((s.quoteRaw * BigInt(10000 - slippageBps)) / BigInt(10000)).toString(),
    };
  } catch (e) {
    return { ...base, ...sized, status: 'INDETERMINATE', executable: false, reason: 'RPC_ERROR', error: (e as Error).message };
  }
}

/** The table shows only the first line of an error, capped; the JSON output keeps the full text. */
const shortError = (e: string) => {
  const first = e.split('\n')[0].trim();
  return first.length > 100 ? `${first.slice(0, 97)}...` : first;
};

const usd = (raw: string | null, decimals: number) => (raw === null ? '—' : (Number(raw) / 10 ** decimals).toFixed(2));
const tierLabel = (t: number | null) => (t === null ? '—' : `${(t / 10000).toString()}%`);

/** TOKEN  STATUS  TIER  SIZE  QUOTE  VERIFIED  GROSS-MIN(99%)  SIGNED  REASON  [deviation]. */
export function formatExecutabilityRow(r: ExecutabilityResult, usdgDecimals: number): string {
  return [
    r.symbol.padEnd(8),
    r.status.padEnd(13),
    tierLabel(r.feeTier).padEnd(6),
    `$${r.sizeUsd} sell`.padEnd(11),
    `$${usd(r.quoteRaw, usdgDecimals)}`.padEnd(11),
    `$${usd(r.referenceRaw, usdgDecimals)}`.padEnd(11),
    `$${usd(r.grossMinimumRaw, usdgDecimals)}`.padEnd(11),
    (r.executable ? 'YES' : 'NO').padEnd(4),
    r.reason + (r.deviationBps !== null ? `  ${(r.deviationBps / 100).toFixed(2)}% below verified` : '') + (r.error ? `  (${shortError(r.error)})` : ''),
  ].join(' ');
}

/** Hides credentials in an RPC URL (API keys often sit in the path or query): keeps only scheme and host. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' && !u.search ? `${u.protocol}//${u.host}` : `${u.protocol}//${u.host}/…`;
  } catch {
    return '<rpc url>';
  }
}
