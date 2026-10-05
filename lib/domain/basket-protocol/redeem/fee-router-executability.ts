// -----------------------------------------------------------------------------
// Can a fee-paying sale of this token execute through RedeemFeeRouter — and is
// it safe? (docs/FEE_ECONOMICS_DESIGN.md, B0 live-validation prerequisite.)
// Pure: the quoter is injected, so this runs against a mock in tests and against
// the real Uniswap v3 QuoterV2 (read-only eth_call) in
// scripts/check-fee-router-liquidity.ts.
//
// It mirrors signFeeAttestation: fee tiers are tried IN ORDER and the FIRST one
// that quotes is the tier the attestation would use (`sellFeeTier`), and the
// leg's minimum is quote × (1 − slippage). "Pool exists" is not enough — the
// quote is taken for a representative sale size.
//
// "Executable" is not "safe". The first live run showed tokens whose only
// quoting tier is a near-empty 1% pool: the sale executes, and the attestation's
// minimum (99% of that pool's own quote) protects nothing — the seller gets a
// fraction of a cent on the dollar. So every executable result is also checked
// against `maxLossBps` and reported UNSAFE above it, and the best tier is quoted
// too (`bestFeeTier`/`bestQuoteRaw`) to show what a better tier choice would give.
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
  /** Above this round-trip loss an executable sale is reported UNSAFE (default 500 = 5%). */
  maxLossBps?: number;
  quote: QuoteFn;
}

export type ExecutabilityReason =
  | 'OK'
  | 'SETTLEMENT_TOKEN'
  | 'EXCESSIVE_LOSS'
  | 'NO_LIQUIDITY_TO_SIZE'
  | 'NO_SELL_LIQUIDITY'
  | 'ZERO_OUTPUT'
  | 'RPC_ERROR';

export type ExecutabilityStatus = 'PASS' | 'UNSAFE' | 'FAIL';

export interface ExecutabilityResult {
  symbol: string;
  address: string;
  sizeUsdg: number;
  /** PASS: executes at an acceptable loss. UNSAFE: executes, but loses more than maxLossBps. FAIL: does not execute. */
  status: ExecutabilityStatus;
  /** Whether the router would execute it (true for PASS and UNSAFE). */
  executable: boolean;
  reason: ExecutabilityReason;
  /** The tier signFeeAttestation would use for the sale leg (first that quotes). */
  sellFeeTier: number | null;
  tokenAmountRaw: string | null;
  quoteRaw: string | null;
  grossMinimumRaw: string | null;
  roundTripLossBps: number | null;
  /** The tier with the highest sale quote, and that quote. */
  bestFeeTier: number | null;
  bestQuoteRaw: string | null;
  error?: string;
}

export const DEFAULT_MAX_LOSS_BPS = 500;

export async function checkFeeRouterExecutability(input: ExecutabilityInput): Promise<ExecutabilityResult> {
  const { token, usdg, sizeUsdg, slippageBps, feeTiers, quote } = input;
  const maxLossBps = input.maxLossBps ?? DEFAULT_MAX_LOSS_BPS;
  const base = {
    symbol: token.symbol,
    address: token.address,
    sizeUsdg,
    sellFeeTier: null,
    tokenAmountRaw: null,
    quoteRaw: null,
    grossMinimumRaw: null,
    roundTripLossBps: null,
    bestFeeTier: null,
    bestQuoteRaw: null,
  };
  // A holding already in USDG is a "no swap" leg in RedeemFeeRouter: always executable, nothing to quote.
  if (token.address.toLowerCase() === usdg.address.toLowerCase()) return { ...base, status: 'PASS', executable: true, reason: 'SETTLEMENT_TOKEN' };
  if (!Number.isFinite(sizeUsdg) || sizeUsdg <= 0) throw new Error('sizeUsdg must be positive');

  const sizeRaw = BigInt(Math.round(sizeUsdg * 10 ** usdg.decimals));
  try {
    let sized: bigint | null = null;
    for (const feeTier of feeTiers) {
      const r = await quote({ tokenIn: usdg.address, tokenOut: token.address, amountIn: sizeRaw, feeTier });
      if (r && r.amountOut > BigInt(0)) {
        sized = r.amountOut;
        break;
      }
    }
    if (sized === null) return { ...base, status: 'FAIL', executable: false, reason: 'NO_LIQUIDITY_TO_SIZE' };

    // Every tier for the sale: the attestation's (first that quotes) and the best.
    const sells: { feeTier: number; amountOut: bigint }[] = [];
    for (const feeTier of feeTiers) {
      const r = await quote({ tokenIn: token.address, tokenOut: usdg.address, amountIn: sized, feeTier });
      if (r) sells.push({ feeTier, amountOut: r.amountOut });
    }
    const tokenAmountRaw = sized.toString();
    if (sells.length === 0) return { ...base, tokenAmountRaw, status: 'FAIL', executable: false, reason: 'NO_SELL_LIQUIDITY' };
    const first = sells[0];
    const best = sells.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
    const bestFields = { bestFeeTier: best.feeTier, bestQuoteRaw: best.amountOut.toString() };
    if (first.amountOut <= BigInt(0)) return { ...base, ...bestFields, tokenAmountRaw, sellFeeTier: first.feeTier, status: 'FAIL', executable: false, reason: 'ZERO_OUTPUT' };

    const grossMinimum = (first.amountOut * BigInt(10000 - slippageBps)) / BigInt(10000);
    const loss = first.amountOut >= sizeRaw ? 0 : Number(((sizeRaw - first.amountOut) * BigInt(10000)) / sizeRaw);
    const safe = loss <= maxLossBps;
    return {
      ...base,
      ...bestFields,
      status: safe ? 'PASS' : 'UNSAFE',
      executable: true,
      reason: safe ? 'OK' : 'EXCESSIVE_LOSS',
      sellFeeTier: first.feeTier,
      tokenAmountRaw,
      quoteRaw: first.amountOut.toString(),
      grossMinimumRaw: grossMinimum.toString(),
      roundTripLossBps: loss,
    };
  } catch (e) {
    return { ...base, status: 'FAIL', executable: false, reason: 'RPC_ERROR', error: (e as Error).message };
  }
}

/** The table shows only the first line of an error, capped; the JSON output keeps the full text. */
const shortError = (e: string) => {
  const first = e.split('\n')[0].trim();
  return first.length > 100 ? `${first.slice(0, 97)}...` : first;
};

const usd = (raw: string | null, decimals: number) => (raw === null ? '—' : (Number(raw) / 10 ** decimals).toFixed(2));
const tierLabel = (t: number | null) => (t === null ? '—' : `${(t / 10000).toString()}%`);

/** One fixed-width line: TOKEN  STATUS  TIER  SIZE  QUOTE  GROSS-MIN(99%)  EXECUTABLE  REASON  [loss] [best tier]. */
export function formatExecutabilityRow(r: ExecutabilityResult, usdgDecimals: number): string {
  const better = r.bestFeeTier !== null && r.bestFeeTier !== r.sellFeeTier ? `  best ${tierLabel(r.bestFeeTier)} $${usd(r.bestQuoteRaw, usdgDecimals)}` : '';
  return [
    r.symbol.padEnd(8),
    r.status.padEnd(6),
    tierLabel(r.sellFeeTier).padEnd(6),
    `$${r.sizeUsdg} sell`.padEnd(11),
    `$${usd(r.quoteRaw, usdgDecimals)}`.padEnd(11),
    `$${usd(r.grossMinimumRaw, usdgDecimals)}`.padEnd(11),
    (r.executable ? 'YES' : 'NO').padEnd(4),
    r.reason +
      (r.roundTripLossBps !== null ? `  round-trip loss ${(r.roundTripLossBps / 100).toFixed(2)}%` : '') +
      better +
      (r.error ? `  (${shortError(r.error)})` : ''),
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
