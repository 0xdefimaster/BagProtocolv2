import { normalizeAddress } from './chains';
import type { BagDefinition } from './types';

// -----------------------------------------------------------------------------
// The normative v1 deposit split (README "Weights: exactly 10000"). Pure.
//   1. part_i = floor(amount × weightBps_i / 10000)
//   2. the units lost to flooring go one each to the largest remainders,
//   3. ties by `chain:address` ascending.
// Exact: the parts always sum to `amount`.
// -----------------------------------------------------------------------------

const TOTAL_BPS = BigInt(10_000);

/** Splits `amountRaw` (smallest unit of the input token) across a valid definition's assets. Keys are `chain:address` (lowercase). */
export function splitByWeight(amountRaw: bigint, definition: Pick<BagDefinition, 'assets'>): Map<string, bigint> {
  const total = definition.assets.reduce((s, a) => s + a.weightBps, 0);
  if (total !== 10_000) throw new Error(`splitByWeight: weights sum to ${total}, not 10000.`);
  if (amountRaw < BigInt(0)) throw new Error('splitByWeight: negative amount.');

  const lines = definition.assets.map((a) => {
    const numerator = amountRaw * BigInt(a.weightBps);
    return { key: `${a.chain}:${normalizeAddress(a.address)}`, part: numerator / TOTAL_BPS, remainder: numerator % TOTAL_BPS };
  });
  let leftover = amountRaw - lines.reduce((s, l) => s + l.part, BigInt(0));
  const order = [...lines].sort((a, b) => (a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.remainder > b.remainder ? -1 : 1));
  for (const line of order) {
    if (leftover <= BigInt(0)) break;
    line.part += BigInt(1);
    leftover -= BigInt(1);
  }
  return new Map(lines.map((l) => [l.key, l.part]));
}
