// -----------------------------------------------------------------------------
// Can a fee-paying sale of this token execute through RedeemFeeRouter?
// (docs/FEE_ECONOMICS_DESIGN.md, B0 live-validation prerequisite.) Pure: the
// quoter is injected, so this runs against a mock in tests and against the real
// Uniswap v3 QuoterV2 (read-only eth_call) in scripts/check-fee-router-liquidity.ts.
//
// It mirrors signFeeAttestation exactly: fee tiers are tried IN ORDER and the
// FIRST one that quotes is used (not the best one), and the leg's minimum is
// quote × (1 − slippage). "Pool exists" is not enough — the quote is taken for a
// representative sale size.
//
// The representative size is given in USDG: the token amount is what that much
// USDG buys (first tier that quotes), then that amount is quoted back to USDG,
// as a sale would be. The round trip pays two pool fees and price impact twice,
// so `roundTripLossBps` is an upper bound on what one sale costs.
// -----------------------------------------------------------------------------

export type QuoteFn = (args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; feeTier: number }) => Promise<{ amountOut: bigint } | null>;

export interface ExecutabilityInput {
  token: { symbol: string; address: `0x${string}`; decimals: number };
  usdg: { address: `0x${string}`; decimals: number };
  /** Representative sale size in whole USDG (e.g. 100). */
  sizeUsdg: number;
  slippageBps: number;
  /** In the order the attestation tries them. */
  feeTiers: readonly number[];
  quote: QuoteFn;
}

export type ExecutabilityReason = 'OK' | 'SETTLEMENT_TOKEN' | 'NO_LIQUIDITY_TO_SIZE' | 'NO_SELL_LIQUIDITY' | 'ZERO_OUTPUT' | 'RPC_ERROR';

export interface ExecutabilityResult {
  symbol: string;
  address: string;
  sizeUsdg: number;
  executable: boolean;
  reason: ExecutabilityReason;
  /** The tier signFeeAttestation would use for the sale leg. */
  sellFeeTier: number | null;
  tokenAmountRaw: string | null;
  quoteRaw: string | null;
  grossMinimumRaw: string | null;
  roundTripLossBps: number | null;
  error?: string;
}

async function firstQuote(quote: QuoteFn, tiers: readonly number[], args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint }) {
  for (const feeTier of tiers) {
    const r = await quote({ ...args, feeTier });
    if (r) return { feeTier, amountOut: r.amountOut };
  }
  return null;
}

export async function checkFeeRouterExecutability(input: ExecutabilityInput): Promise<ExecutabilityResult> {
  const { token, usdg, sizeUsdg, slippageBps, feeTiers, quote } = input;
  const base = { symbol: token.symbol, address: token.address, sizeUsdg, sellFeeTier: null, tokenAmountRaw: null, quoteRaw: null, grossMinimumRaw: null, roundTripLossBps: null };
  // A holding already in USDG is a "no swap" leg in RedeemFeeRouter: always executable, nothing to quote.
  if (token.address.toLowerCase() === usdg.address.toLowerCase()) return { ...base, executable: true, reason: 'SETTLEMENT_TOKEN' };
  if (!Number.isFinite(sizeUsdg) || sizeUsdg <= 0) throw new Error('sizeUsdg must be positive');

  const sizeRaw = BigInt(Math.round(sizeUsdg * 10 ** usdg.decimals));
  try {
    const sized = await firstQuote(quote, feeTiers, { tokenIn: usdg.address, tokenOut: token.address, amountIn: sizeRaw });
    if (!sized || sized.amountOut <= BigInt(0)) return { ...base, executable: false, reason: 'NO_LIQUIDITY_TO_SIZE' };
    const sell = await firstQuote(quote, feeTiers, { tokenIn: token.address, tokenOut: usdg.address, amountIn: sized.amountOut });
    if (!sell) return { ...base, tokenAmountRaw: sized.amountOut.toString(), executable: false, reason: 'NO_SELL_LIQUIDITY' };
    if (sell.amountOut <= BigInt(0)) return { ...base, tokenAmountRaw: sized.amountOut.toString(), sellFeeTier: sell.feeTier, executable: false, reason: 'ZERO_OUTPUT' };
    const grossMinimum = (sell.amountOut * BigInt(10000 - slippageBps)) / BigInt(10000);
    const loss = sell.amountOut >= sizeRaw ? 0 : Number(((sizeRaw - sell.amountOut) * BigInt(10000)) / sizeRaw);
    return {
      ...base,
      executable: true,
      reason: 'OK',
      sellFeeTier: sell.feeTier,
      tokenAmountRaw: sized.amountOut.toString(),
      quoteRaw: sell.amountOut.toString(),
      grossMinimumRaw: grossMinimum.toString(),
      roundTripLossBps: loss,
    };
  } catch (e) {
    return { ...base, executable: false, reason: 'RPC_ERROR', error: (e as Error).message };
  }
}

/** The table shows only the first line of an error, capped; the JSON output keeps the full text. */
const shortError = (e: string) => {
  const first = e.split('\n')[0].trim();
  return first.length > 100 ? `${first.slice(0, 97)}...` : first;
};

const usd = (raw: string | null, decimals: number) => (raw === null ? '—' : (Number(raw) / 10 ** decimals).toFixed(2));

/** One fixed-width line: TOKEN  PASS/FAIL  TIER  SIZE  QUOTE  GROSS-MIN(99%)  EXECUTABLE  REASON  [round-trip loss]. */
export function formatExecutabilityRow(r: ExecutabilityResult, usdgDecimals: number): string {
  const tier = r.sellFeeTier === null ? '—' : `${(r.sellFeeTier / 10000).toString()}%`;
  return [
    r.symbol.padEnd(8),
    (r.executable ? 'PASS' : 'FAIL').padEnd(5),
    tier.padEnd(6),
    `$${r.sizeUsdg} sell`.padEnd(11),
    `$${usd(r.quoteRaw, usdgDecimals)}`.padEnd(11),
    `$${usd(r.grossMinimumRaw, usdgDecimals)}`.padEnd(11),
    (r.executable ? 'YES' : 'NO').padEnd(4),
    r.reason + (r.roundTripLossBps !== null ? `  round-trip loss ${(r.roundTripLossBps / 100).toFixed(2)}%` : '') + (r.error ? `  (${shortError(r.error)})` : ''),
  ].join(' ');
}
