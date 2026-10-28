import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  largestRemainderBps,
  PARTITION_MAX_PARTS,
  PartitionError,
  partitionAmounts,
  planPartition,
  planPartitionLegs,
  simulatePartition,
} from '../src/partition';

const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL('../../../docs/schemas/partition.v1.vectors.json', import.meta.url)), 'utf8')) as {
  vectors: { name: string; targets: { token: string; amountRaw: string }[]; expected: Record<string, unknown> }[];
};

let seed = 20261019;
const rand = (m: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % m);
const token = (n: number) => '0x' + n.toString(16).padStart(40, '0');

describe('partition v1 vectors (docs/schemas/partition.v1.vectors.json)', () => {
  for (const v of VECTORS.vectors) {
    it(v.name, () => {
      const targets = v.targets.map((t) => ({ token: t.token, amountRaw: BigInt(t.amountRaw) }));
      if ('error' in v.expected) {
        expect(() => planPartitionLegs(targets)).toThrow(PartitionError);
        try {
          planPartitionLegs(targets);
        } catch (e) {
          expect((e as PartitionError).code).toBe(v.expected.error);
        }
        return;
      }
      const p = planPartitionLegs(targets);
      expect({ legs: p.legs.map((l) => ({ token: l.token, legBps: l.legBps })), partition: p.partition, totalRaw: p.totalRaw.toString() }).toEqual({
        legs: v.expected.legs,
        partition: v.expected.partition,
        totalRaw: v.expected.totalRaw,
      });
      expect(simulatePartition(p.totalRaw, p.legs.map((l) => l.legBps)).map(String)).toEqual(v.expected.executedRaw);
    });
  }
});

describe('largestRemainderBps', () => {
  it('always sums to exactly 10000 and never moves a weight by more than 1 bp from its exact share', () => {
    for (let t = 0; t < 2000; t++) {
      const values = Array.from({ length: 1 + rand(20) }, () => BigInt(1 + rand(1_000_000)) * BigInt(1 + rand(1_000_000)));
      const total = values.reduce((a, b) => a + b, BigInt(0));
      const bps = largestRemainderBps(values);
      expect(bps.reduce((a, b) => a + b, 0)).toBe(10000);
      bps.forEach((b, i) => {
        const floor = Number((values[i] * BigInt(10000)) / total);
        expect(b === floor || b === floor + 1).toBe(true);
      });
    }
  });

  it('breaks equal remainders by key, so the input order never changes the result', () => {
    const values = [BigInt(1), BigInt(1), BigInt(1)];
    expect(largestRemainderBps(values, ['c', 'a', 'b'])).toEqual([3333, 3334, 3333]);
    expect(largestRemainderBps(values)).toEqual([3334, 3333, 3333]);
  });

  it('refuses no values, a negative value and an all-zero input', () => {
    expect(() => largestRemainderBps([])).toThrow(PartitionError);
    expect(() => largestRemainderBps([BigInt(-1), BigInt(2)])).toThrow(PartitionError);
    expect(() => largestRemainderBps([BigInt(0), BigInt(0)])).toThrow(PartitionError);
  });
});

describe('planPartitionLegs', () => {
  it('is independent of the order the targets come in', () => {
    for (let t = 0; t < 300; t++) {
      const targets = Array.from({ length: 2 + rand(30) }, (_, i) => ({ token: token(0x1000 + i * 3), amountRaw: BigInt(1_000_000 + rand(10_000_000)) }));
      const shuffled = [...targets].sort(() => rand(3) - 1);
      expect(planPartitionLegs(shuffled)).toEqual(planPartitionLegs(targets));
    }
  });

  it('spends exactly the total; every leg lands within 1 bp of the total of its target (2 bps above 16 legs), plus flooring units', () => {
    for (let t = 0; t < 2000; t++) {
      const targets = Array.from({ length: 2 + rand(40) }, (_, i) => ({ token: token(0x2000 + i), amountRaw: BigInt(1 + rand(3000)) * BigInt(1_000 + rand(1_000_000)) }));
      let p;
      try {
        p = planPartitionLegs(targets);
      } catch (e) {
        expect((e as PartitionError).code).toBe('LEG_BELOW_ONE_BP');
        continue;
      }
      const executed = simulatePartition(p.totalRaw, p.legs.map((l) => l.legBps));
      expect(executed.reduce((a, b) => a + b, BigInt(0))).toBe(p.totalRaw);
      p.legs.forEach((l, i) => {
        const dev = executed[i] > l.amountRaw ? executed[i] - l.amountRaw : l.amountRaw - executed[i];
        // Largest remainder keeps a weight under 1 bp from its exact share; a second level adds under 1 bp of its group.
        const bound = (p.totalRaw * BigInt(p.legs.length > PARTITION_MAX_PARTS ? 2 : 1)) / BigInt(10000) + BigInt(p.legs.length + 2);
        expect(dev < bound).toBe(true);
      });
    }
  });

  it('refuses what a partition cannot express', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as PartitionError).code;
      }
      return null;
    };
    expect(code(() => planPartitionLegs([]))).toBe('NO_LEGS');
    expect(code(() => planPartitionLegs([{ token: token(1), amountRaw: BigInt(0) }]))).toBe('NON_POSITIVE_AMOUNT');
    expect(code(() => planPartitionLegs([{ token: token(1), amountRaw: BigInt(5) }, { token: token(1).toUpperCase().replace('0X', '0x'), amountRaw: BigInt(5) }]))).toBe('DUPLICATE_TOKEN');
    expect(code(() => planPartitionLegs(Array.from({ length: 257 }, (_, i) => ({ token: token(i + 1), amountRaw: BigInt(1_000_000) }))))).toBe('TOO_MANY_LEGS');
  });
});

describe('planPartition / partitionAmounts', () => {
  it('one node for 2–16 legs, two levels above, every node 2–16 shares summing to 10000', () => {
    expect(planPartition([10000])).toEqual({ outerBps: [10000], groups: [{ legs: [0], innerBps: null }] });
    for (const n of [2, 16, 17, 33, 100, 256]) {
      const w = largestRemainderBps(Array.from({ length: n }, (_, i) => BigInt(1000 + i)));
      const p = planPartition(w);
      expect(p.outerBps.reduce((a, b) => a + b, 0)).toBe(10000);
      expect(p.outerBps.length).toBeLessThanOrEqual(PARTITION_MAX_PARTS);
      for (const g of p.groups) {
        if (g.innerBps) {
          expect(g.innerBps.reduce((a, b) => a + b, 0)).toBe(10000);
          expect(g.innerBps.length).toBeGreaterThanOrEqual(2);
          expect(g.innerBps.length).toBeLessThanOrEqual(PARTITION_MAX_PARTS);
        }
      }
      expect(p.groups.flatMap((g) => g.legs)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('a node floors every share and gives the last one the remainder', () => {
    expect(partitionAmounts(BigInt(10), [3334, 3333, 3333])).toEqual([BigInt(3), BigInt(3), BigInt(4)]);
    expect(() => planPartition([5000, 4999])).toThrow(PartitionError);
    expect(() => planPartition([10000, 0])).toThrow(PartitionError);
  });
});
