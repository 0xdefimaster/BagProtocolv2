import { normalizeAddress } from './chains';

// -----------------------------------------------------------------------------
// How a bps-ratio executor (LI.FI Composer's `core.partition`) divides ONE
// input across several legs. Pure. The single source for BAG's purchase and
// rebalance flows and for the SDK's own compile.
//
//   1. Leg weights from exact raw amounts (`largestRemainderBps`, bigint):
//      w_i = floor(10000 × amount_i / total); the bps lost to flooring go one
//      each to the largest remainders; ties by key ascending. Sum: exactly 10000.
//   2. The partition (`planPartition`): one `core.partition` node for 2–16
//      legs. Above 16, an outer node over ≤16 groups (sizes as even as
//      possible) and one node per group with its members' weights rescaled to
//      10000 by the same largest-remainder rule.
//   3. What a node delivers (`partitionAmounts`): each share
//      floor(amount × bps / 10000), the last share the remainder.
//
// Legs are in canonical order (`planPartitionLegs`: token address ascending),
// so every caller that starts from the same targets builds the same nodes.
// -----------------------------------------------------------------------------

/** `core.partition` takes 2 to 16 shares. */
export const PARTITION_MAX_PARTS = 16;

const TOTAL_BPS = BigInt(10_000);

export class PartitionError extends Error {
  constructor(
    readonly code: 'NO_LEGS' | 'NON_POSITIVE_AMOUNT' | 'DUPLICATE_TOKEN' | 'LEG_BELOW_ONE_BP' | 'TOO_MANY_LEGS' | 'INVALID_WEIGHTS',
    message: string
  ) {
    super(message);
    this.name = 'PartitionError';
  }
}

/**
 * Whole-bp weights for `values` (each ≥ 0, sum > 0) by largest remainder, in bigint. Sum: exactly 10000.
 * `tieKeys` (same length) breaks equal remainders, ascending; by index when omitted. A value may get 0.
 */
export function largestRemainderBps(values: readonly bigint[], tieKeys?: readonly string[]): number[] {
  if (values.length === 0) throw new PartitionError('NO_LEGS', 'largestRemainderBps: no values.');
  if (values.some((v) => v < BigInt(0))) throw new PartitionError('NON_POSITIVE_AMOUNT', 'largestRemainderBps: negative value.');
  if (tieKeys && tieKeys.length !== values.length) throw new Error('largestRemainderBps: tieKeys must match values.');
  const total = values.reduce((s, v) => s + v, BigInt(0));
  if (total <= BigInt(0)) throw new PartitionError('NON_POSITIVE_AMOUNT', 'largestRemainderBps: values sum to 0.');

  const lines = values.map((v, i) => ({ i, key: tieKeys ? tieKeys[i] : '', floor: (v * TOTAL_BPS) / total, rem: (v * TOTAL_BPS) % total }));
  let left = TOTAL_BPS - lines.reduce((s, l) => s + l.floor, BigInt(0));
  const order = [...lines].sort((a, b) => (a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.i - b.i));
  for (const line of order) {
    if (left <= BigInt(0)) break;
    line.floor += BigInt(1);
    left -= BigInt(1);
  }
  return lines.map((l) => Number(l.floor));
}

/** The node layout for `weights` (whole bps, each > 0, summing to 10000). One leg: no node. */
export interface PartitionPlan {
  outerBps: number[];
  groups: { legs: number[]; innerBps: number[] | null }[];
}

export function planPartition(weights: readonly number[]): PartitionPlan {
  if (weights.length === 0) throw new PartitionError('NO_LEGS', 'planPartition: no legs.');
  if (weights.some((w) => !Number.isInteger(w) || w <= 0)) throw new PartitionError('INVALID_WEIGHTS', 'planPartition: every weight must be a positive whole number of bps.');
  const total = weights.reduce((s, w) => s + w, 0);
  if (total !== 10_000) throw new PartitionError('INVALID_WEIGHTS', `planPartition: weights sum to ${total}, not 10000.`);
  if (weights.length <= PARTITION_MAX_PARTS) return { outerBps: [...weights], groups: weights.map((_, i) => ({ legs: [i], innerBps: null })) };

  const groupCount = Math.ceil(weights.length / PARTITION_MAX_PARTS);
  if (groupCount > PARTITION_MAX_PARTS) throw new PartitionError('TOO_MANY_LEGS', `planPartition: at most ${PARTITION_MAX_PARTS * PARTITION_MAX_PARTS} legs, got ${weights.length}.`);
  const base = Math.floor(weights.length / groupCount);
  const extra = weights.length - base * groupCount;
  const groups: PartitionPlan['groups'] = [];
  const outerBps: number[] = [];
  let next = 0;
  for (let g = 0; g < groupCount; g++) {
    const legs = Array.from({ length: base + (g < extra ? 1 : 0) }, () => next++);
    const innerBps = largestRemainderBps(legs.map((i) => BigInt(weights[i])));
    // A member with a tiny weight next to large ones can round to 0 inside its group: not expressible.
    if (innerBps.some((b) => b <= 0)) throw new PartitionError('LEG_BELOW_ONE_BP', 'planPartition: a leg is below 1 bp of its group.');
    groups.push({ legs, innerBps });
    outerBps.push(legs.reduce((s, i) => s + weights[i], 0));
  }
  return { outerBps, groups };
}

/** What one `core.partition` node delivers: each share floor(amount × bps / 10000), the last share the remainder. */
export function partitionAmounts(amount: bigint, bps: readonly number[]): bigint[] {
  const parts = bps.map((b) => (amount * BigInt(b)) / TOTAL_BPS);
  parts[parts.length - 1] = amount - parts.slice(0, -1).reduce((s, x) => s + x, BigInt(0));
  return parts;
}

/** The raw amount each leg receives on chain under `planPartition(weights)`. Sums to `amount`. */
export function simulatePartition(amount: bigint, weights: readonly number[]): bigint[] {
  if (weights.length === 1) return [amount];
  const plan = planPartition(weights);
  const outer = partitionAmounts(amount, plan.outerBps);
  const out: bigint[] = new Array(weights.length);
  plan.groups.forEach((g, gi) => {
    const inner = g.innerBps ? partitionAmounts(outer[gi], g.innerBps) : [outer[gi]];
    g.legs.forEach((leg, k) => (out[leg] = inner[k]));
  });
  return out;
}

export interface LegTarget {
  /** Token the leg buys. */
  token: string;
  /** Exact raw input this leg should spend. */
  amountRaw: bigint;
}

export interface PartitionedLegs {
  /** Canonical order: token address ascending (lowercase). `legBps` sums to 10000. */
  legs: { token: string; amountRaw: bigint; legBps: number }[];
  /** Σ amountRaw: the amount the partition divides. */
  totalRaw: bigint;
  partition: PartitionPlan;
}

/**
 * Turns exact per-leg targets into the legs and partition a bps-ratio executor builds. Throws PartitionError when
 * a leg cannot be expressed (an amount ≤ 0, a duplicate token, a leg below 1 bp, more than 256 legs); a caller
 * that can execute per asset instead may fall back to that.
 */
export function planPartitionLegs(targets: readonly LegTarget[]): PartitionedLegs {
  if (targets.length === 0) throw new PartitionError('NO_LEGS', 'planPartitionLegs: no legs.');
  const legs = targets
    .map((t) => ({ token: normalizeAddress(t.token), amountRaw: t.amountRaw }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].amountRaw <= BigInt(0)) throw new PartitionError('NON_POSITIVE_AMOUNT', `planPartitionLegs: ${legs[i].token} has nothing to spend.`);
    if (i > 0 && legs[i].token === legs[i - 1].token) throw new PartitionError('DUPLICATE_TOKEN', `planPartitionLegs: ${legs[i].token} appears twice.`);
  }
  const bps = largestRemainderBps(legs.map((l) => l.amountRaw), legs.map((l) => l.token));
  const small = legs.find((_, i) => bps[i] <= 0);
  if (small) throw new PartitionError('LEG_BELOW_ONE_BP', `planPartitionLegs: ${small.token} would get less than 1 bp of the split.`);
  return {
    legs: legs.map((l, i) => ({ ...l, legBps: bps[i] })),
    totalRaw: legs.reduce((s, l) => s + l.amountRaw, BigInt(0)),
    partition: planPartition(bps),
  };
}
