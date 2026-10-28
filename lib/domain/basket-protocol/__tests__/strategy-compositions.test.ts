import { describe, expect, it } from 'vitest';
import { compareComposition, computeOnchainCompositionHash, definitionToAllocations, sortAllocations } from '../strategy-compositions';

// The bag.json → StrategyCompositions conversion (contracts/StrategyCompositions.sol): contract order, one encoding,
// and every definition the contract would refuse is refused here first, with the reason.

const chainIdOf = (c: string) => ({ robinhood: 4663, ethereum: 1, base: 8453 })[c] ?? null;
const asset = (chain: string, address: string, weightBps: number) => ({ chain, address, decimals: 18, weightBps }) as never;
const A = '0x22222222222222222222222222222222222222BB';
const B = '0x1111111111111111111111111111111111111111';

describe('definitionToAllocations', () => {
  it('sorts by chainId, then by token as a number, and lowercases tokens', () => {
    const r = definitionToAllocations({ assets: [asset('robinhood', A, 5000), asset('robinhood', B, 3000), asset('ethereum', A, 2000)] }, chainIdOf);
    expect(r).toEqual({
      ok: true,
      allocations: [
        { chainId: BigInt(1), token: A.toLowerCase(), weightBps: 2000 },
        { chainId: BigInt(4663), token: B, weightBps: 3000 },
        { chainId: BigInt(4663), token: A.toLowerCase(), weightBps: 5000 },
      ],
    });
  });

  it.each([
    ['no assets', [], /0 assets/],
    ['a non-EVM chain', [asset('solana', A, 10000)], /no EVM chain id/],
    ['a non-address', [asset('robinhood', 'So1anaMint', 10000)], /not an EVM token address/],
    ['the zero address', [asset('robinhood', `0x${'0'.repeat(40)}`, 10000)], /not an EVM token address/],
    ['a zero weight', [asset('robinhood', A, 0), asset('robinhood', B, 10000)], /not a positive integer/],
    ['a fractional weight', [asset('robinhood', A, 5000.5), asset('robinhood', B, 4999.5)], /not a positive integer/],
    ['weights not summing to 10000', [asset('robinhood', A, 6000), asset('robinhood', B, 3999)], /sum to 9999/],
    ['a duplicate (any letter case)', [asset('robinhood', A, 5000), asset('robinhood', A.toLowerCase(), 5000)], /listed twice/],
  ])('refuses %s', (_name, assets, reason) => {
    const r = definitionToAllocations({ assets: assets as never }, chainIdOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('refuses more than 64 assets', () => {
    const assets = Array.from({ length: 65 }, (_, i) => asset('robinhood', `0x${(i + 1).toString(16).padStart(40, '0')}`, i === 0 ? 10000 - 64 : 1));
    expect(definitionToAllocations({ assets }, chainIdOf)).toMatchObject({ ok: false, reason: expect.stringMatching(/65 assets/) });
  });
});

describe('computeOnchainCompositionHash / compareComposition', () => {
  const allocs = sortAllocations([
    { chainId: BigInt(4663), token: A.toLowerCase() as `0x${string}`, weightBps: 6000 },
    { chainId: BigInt(4663), token: B as `0x${string}`, weightBps: 4000 },
  ]);

  it('is deterministic and changes with any field', () => {
    const h = computeOnchainCompositionHash(allocs);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeOnchainCompositionHash([...allocs])).toBe(h);
    expect(computeOnchainCompositionHash([allocs[0], { ...allocs[1], weightBps: 6001 }])).not.toBe(h);
    expect(computeOnchainCompositionHash([{ ...allocs[0], chainId: BigInt(1) }, allocs[1]])).not.toBe(h);
  });

  it('matches only the exact same list; letter case of the chain read does not matter', () => {
    expect(compareComposition(allocs, allocs.map((a) => ({ ...a, token: a.token.toUpperCase().replace('0X', '0x') }))).matches).toBe(true);
    expect(compareComposition(allocs, [allocs[0]]).matches).toBe(false);
    expect(compareComposition(allocs, [allocs[1], allocs[0]]).matches).toBe(false);
    expect(compareComposition(allocs, [allocs[0], { ...allocs[1], weightBps: 3999 }]).detail).toMatch(/allocation 1/);
  });
});
