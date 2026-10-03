// -----------------------------------------------------------------------------
// Exact bigint distribution by basis-point weight — the largest-remainder
// method. `lib/domain/basket-protocol/rebalance/rebalance.ts` (Phase 8)
// inlines this same algorithm to split a Bag's NAV into per-asset target
// values; `lib/domain/basket-protocol/deposit/allocation.ts` (Phase 10)
// needs the identical guarantee to split a deposit into per-asset target
// values. Rather than a second hand-rolled copy of the floor-then-
// distribute-remainders loop, both reduce to one call into this file (spec
// section 4 — "Phase 8'deki largest-remainder yaklaşımını yeniden kullan
// veya ortak bir exact-allocation utility çıkar"). `rebalance.ts` itself is
// left untouched here — it already has its own passing test suite and its
// own local proof comment; this extraction is additive, for every NEW
// exact-split call site (starting with deposit allocation) to share.
//
// The guarantee: given `totalRaw` and a set of non-negative integer
// weights that sum to exactly `totalWeightBps`, the returned per-line
// values sum to EXACTLY `totalRaw` — never a wei more, never a wei less —
// no matter how the weights or `totalRaw` are chosen.
// -----------------------------------------------------------------------------

export class InvalidWeightSumError extends Error {
  constructor(
    public readonly actualTotalBps: number,
    public readonly expectedTotalBps: number
  ) {
    super(
      `distributeExactByWeight: weights sum to ${actualTotalBps} bps, not the expected ${expectedTotalBps}. ` +
        `This function refuses to split an amount against unnormalized weights — the caller is expected to ` +
        `validate a recipe's weights (see validateBasketRecipe()) before reaching here, and to fail loudly on ` +
        `invalid input rather than silently distributing against numbers that don't sum to 100%.`
    );
    this.name = 'InvalidWeightSumError';
  }
}

export interface WeightedLine {
  /** Unique key for this line — used only for the deterministic tie-break below and as the returned Map's key. */
  key: string;
  /** Non-negative integer basis-point weight. */
  weightBps: number;
}

/**
 * Splits `totalRaw` across `lines` in proportion to `weightBps`, using the
 * largest-remainder method:
 *
 *   1. Floor-divide each line: `floor_i = (totalRaw * weightBps_i) / totalWeightBps`.
 *   2. Sum the truncated remainders; that sum is always an exact multiple
 *      of `totalWeightBps` (proof below), so dividing it by
 *      `totalWeightBps` gives a whole number of "leftover units" that
 *      floor-division dropped.
 *   3. Hand out those leftover units one at a time to the lines with the
 *      largest remainder, largest first, ties broken by `key` ascending
 *      (deterministic — never insertion-order-dependent).
 *
 * Proof of exactness: Σ(totalRaw · weightBps_i) = totalRaw · Σ(weightBps_i)
 * = totalRaw · totalWeightBps (weights sum to exactly `totalWeightBps`,
 * checked below). Also Σ(numerator_i) = Σ(totalWeightBps · floor_i +
 * remainder_i) = totalWeightBps · Σ(floor_i) + Σ(remainder_i). Equating the
 * two: Σ(remainder_i) = totalWeightBps · (totalRaw − Σ(floor_i)) — an exact
 * multiple of `totalWeightBps`, so step 2's division loses nothing, and
 * step 3 always has exactly enough leftover units to bring every floor
 * value up to a sum of precisely `totalRaw`.
 *
 * Throws `InvalidWeightSumError` if `lines`' weights don't sum to exactly
 * `totalWeightBps`.
 */
export function distributeExactByWeight(
  totalRaw: bigint,
  lines: WeightedLine[],
  totalWeightBps: number
): Map<string, bigint> {
  const actualTotalBps = lines.reduce((sum, line) => sum + line.weightBps, 0);
  if (actualTotalBps !== totalWeightBps) {
    throw new InvalidWeightSumError(actualTotalBps, totalWeightBps);
  }

  const result = new Map<string, bigint>();
  if (lines.length === 0) return result;

  const bps = BigInt(totalWeightBps);

  if (totalRaw <= BigInt(0)) {
    for (const line of lines) result.set(line.key, BigInt(0));
    return result;
  }

  const remainders: Array<{ key: string; remainder: bigint }> = [];
  for (const line of lines) {
    const numerator = totalRaw * BigInt(line.weightBps);
    result.set(line.key, numerator / bps);
    remainders.push({ key: line.key, remainder: numerator % bps });
  }

  const totalRemainder = remainders.reduce((sum, r) => sum + r.remainder, BigInt(0));
  let leftoverUnits = totalRemainder / bps;

  const byRemainderDesc = [...remainders].sort((a, b) => {
    if (a.remainder === b.remainder) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return a.remainder > b.remainder ? -1 : 1;
  });

  for (const { key } of byRemainderDesc) {
    if (leftoverUnits <= BigInt(0)) break;
    result.set(key, (result.get(key) ?? BigInt(0)) + BigInt(1));
    leftoverUnits -= BigInt(1);
  }

  return result;
}
