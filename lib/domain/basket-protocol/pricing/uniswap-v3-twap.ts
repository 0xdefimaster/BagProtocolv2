// -----------------------------------------------------------------------------
// Pure Uniswap v3 oracle math (no I/O) — used by the Robinhood Chain TWAP price
// provider. Exact bigint ports of Uniswap v3-core's TickMath.getSqrtRatioAtTick
// and the OracleLibrary mean-tick rounding, so a price derived here is the same
// number the pool's own contracts would compute.
// -----------------------------------------------------------------------------

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const Q32 = BigInt(1) << BigInt(32);
const Q96 = BigInt(1) << BigInt(96);
const Q128 = BigInt(1) << BigInt(128);
const Q192 = BigInt(1) << BigInt(192);
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

// (bit, multiplier) pairs from v3-core/contracts/libraries/TickMath.sol.
const TICK_MULTIPLIERS: [number, bigint][] = [
  [0x2, BigInt('0xfff97272373d413259a46990580e213a')],
  [0x4, BigInt('0xfff2e50f5f656932ef12357cf3c7fdcc')],
  [0x8, BigInt('0xffe5caca7e10e4e61c3624eaa0941cd0')],
  [0x10, BigInt('0xffcb9843d60f6159c9db58835c926644')],
  [0x20, BigInt('0xff973b41fa98c081472e6896dfb254c0')],
  [0x40, BigInt('0xff2ea16466c96a3843ec78b326b52861')],
  [0x80, BigInt('0xfe5dee046a99a2a811c461f1969c3053')],
  [0x100, BigInt('0xfcbe86c7900a88aedcffc83b479aa3a4')],
  [0x200, BigInt('0xf987a7253ac413176f2b074cf7815e54')],
  [0x400, BigInt('0xf3392b0822b70005940c7a398e4b70f3')],
  [0x800, BigInt('0xe7159475a2c29b7443b29c7fa6e889d9')],
  [0x1000, BigInt('0xd097f3bdfd2022b8845ad8f792aa5825')],
  [0x2000, BigInt('0xa9f746462d870fdf8a65dc1f90e061e5')],
  [0x4000, BigInt('0x70d869a156d2a1b890bb3df62baf32f7')],
  [0x8000, BigInt('0x31be135f97d08fd981231505542fcfa6')],
  [0x10000, BigInt('0x9aa508b5b7a84e1c677de54f3e99bc9')],
  [0x20000, BigInt('0x5d6af8dedb81196699c329225ee604')],
  [0x40000, BigInt('0x2216e584f5fa1ea926041bedfe98')],
  [0x80000, BigInt('0x48a170391f7dc42444e8fa2')],
];

/** sqrt(1.0001^tick) × 2^96, rounded up — TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const absTick = Math.abs(tick);
  let ratio = (absTick & 0x1) !== 0 ? BigInt('0xfffcb933bd6fad37aa2d162d1a594001') : Q128;
  for (const [bit, mul] of TICK_MULTIPLIERS) {
    if ((absTick & bit) !== 0) ratio = (ratio * mul) >> BigInt(128);
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> BigInt(32)) + (ratio % Q32 === BigInt(0) ? BigInt(0) : BigInt(1));
}

/** Arithmetic mean tick over a window, rounded toward negative infinity — OracleLibrary.consult. */
export function meanTickFromCumulatives(tickCumulativeStart: bigint, tickCumulativeEnd: bigint, windowSeconds: number): number {
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) throw new Error('windowSeconds must be a positive integer');
  const delta = tickCumulativeEnd - tickCumulativeStart;
  const w = BigInt(windowSeconds);
  let mean = delta / w; // bigint division truncates toward zero
  if (delta < BigInt(0) && delta % w !== BigInt(0)) mean -= BigInt(1);
  return Number(mean);
}

/**
 * Price of ONE WHOLE unit of `base` in whole units of `quote`, as a fixed-point
 * bigint at `outDecimals` (truncated, never rounded up), for a pool at
 * `sqrtPriceX96` (token1/token0 in raw units). `baseIsToken0` says which side
 * of the pool the priced asset is; decimals normalize raw → whole units.
 */
export function priceFromSqrtRatio(
  sqrtPriceX96: bigint,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
  outDecimals: number
): bigint {
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96; // raw token1 per raw token0, × 2^192
  const scale = BigInt(10) ** BigInt(outDecimals);
  const baseUnit = BigInt(10) ** BigInt(baseDecimals);
  const quoteUnit = BigInt(10) ** BigInt(quoteDecimals);
  if (baseIsToken0) {
    // quote per base = ratio
    return (ratioX192 * baseUnit * scale) / (Q192 * quoteUnit);
  }
  // quote per base = 1 / ratio
  if (ratioX192 === BigInt(0)) throw new Error('zero price');
  return (Q192 * baseUnit * scale) / (ratioX192 * quoteUnit);
}

export { Q96 };
