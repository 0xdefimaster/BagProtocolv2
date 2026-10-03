import { describe, expect, it } from 'vitest';
import { RecipeAsset } from '@/types/basket-protocol';
import { computeOnChainBagId, computeOnChainCompositionHash, decodeOnChainBagId, deriveOnChainBagId } from '../onchain';

function asset(overrides: Partial<RecipeAsset>): RecipeAsset {
  return {
    chain: 'ethereum',
    address: '0x1111111111111111111111111111111111111a',
    symbol: 'BTC',
    decimals: 18,
    weightBps: 6000,
    ...overrides,
  };
}

describe('computeOnChainCompositionHash', () => {
  it('returns a 32-byte (66-char, 0x-prefixed) hex string', () => {
    const hash = computeOnChainCompositionHash([asset({})]);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is independent of array order — reordering assets never changes the hash', () => {
    const a = asset({ symbol: 'BTC', address: '0x1111111111111111111111111111111111111a', weightBps: 6000 });
    const b = asset({ symbol: 'ETH', address: '0x2222222222222222222222222222222222222b', weightBps: 4000 });

    const forward = computeOnChainCompositionHash([a, b]);
    const reversed = computeOnChainCompositionHash([b, a]);

    expect(forward).toBe(reversed);
  });

  it('is independent of object key order within each asset (JSONB round-trip simulation)', () => {
    const a: RecipeAsset = {
      chain: 'ethereum',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 18,
      weightBps: 6000,
    };
    // Same asset, but JSON.parse(JSON.stringify()) with keys inserted in a
    // different order — simulates what a JSONB round-trip through Supabase
    // can do to key order (Postgres JSONB does not preserve insertion
    // order across a read).
    const reordered: RecipeAsset = JSON.parse(
      `{"weightBps":6000,"decimals":18,"symbol":"BTC","address":"0x1111111111111111111111111111111111111a","chain":"ethereum"}`
    );

    expect(computeOnChainCompositionHash([a])).toBe(computeOnChainCompositionHash([reordered]));
  });

  it('changes when a weight actually changes', () => {
    const v1 = computeOnChainCompositionHash([asset({ weightBps: 6000 })]);
    const v2 = computeOnChainCompositionHash([asset({ weightBps: 6001 })]);
    expect(v1).not.toBe(v2);
  });

  it('changes when the asset set actually changes', () => {
    const v1 = computeOnChainCompositionHash([asset({ symbol: 'BTC' })]);
    const v2 = computeOnChainCompositionHash([asset({ symbol: 'ETH' })]);
    expect(v1).not.toBe(v2);
  });

  it('is deterministic — same input, called twice, same output', () => {
    const assets = [asset({ symbol: 'BTC' }), asset({ symbol: 'ETH', weightBps: 4000 })];
    expect(computeOnChainCompositionHash(assets)).toBe(computeOnChainCompositionHash(assets));
  });
});

describe('computeOnChainBagId', () => {
  it('returns a 32-byte hex string', () => {
    expect(computeOnChainBagId('11111111-1111-1111-1111-111111111111')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input id', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(computeOnChainBagId(id)).toBe(computeOnChainBagId(id));
  });

  it('is different for different bag ids', () => {
    const a = computeOnChainBagId('11111111-1111-1111-1111-111111111111');
    const b = computeOnChainBagId('22222222-2222-2222-2222-222222222222');
    expect(a).not.toBe(b);
  });

  it('round-trips through decodeOnChainBagId — the whole point of encoding rather than hashing', () => {
    const uuid = 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7';
    expect(decodeOnChainBagId(computeOnChainBagId(uuid))).toBe(uuid);
  });

  it('rejects a non-UUID input rather than silently encoding garbage', () => {
    expect(() => computeOnChainBagId('not-a-uuid')).toThrow();
  });
});

describe('deriveOnChainBagId (creator-bound id — same formula as BagFactory.deriveBagId)', () => {
  const REF = computeOnChainBagId('11111111-1111-1111-1111-111111111111');
  const CREATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

  it('is a 32-byte hash, deterministic for the same (creator, offChainRef)', () => {
    const id = deriveOnChainBagId(CREATOR, REF);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveOnChainBagId(CREATOR, REF)).toBe(id);
  });

  it('a different creator yields a DIFFERENT id for the same offChainRef (anti-squatting)', () => {
    expect(deriveOnChainBagId(OTHER, REF)).not.toBe(deriveOnChainBagId(CREATOR, REF));
  });

  it('a different offChainRef yields a different id for the same creator', () => {
    const ref2 = computeOnChainBagId('22222222-2222-2222-2222-222222222222');
    expect(deriveOnChainBagId(CREATOR, ref2)).not.toBe(deriveOnChainBagId(CREATOR, REF));
  });

  it('is insensitive to address casing (checksummed vs lowercase)', () => {
    expect(deriveOnChainBagId(CREATOR.toLowerCase(), REF)).toBe(deriveOnChainBagId(CREATOR, REF));
  });

  it('rejects a malformed creator or offChainRef instead of hashing garbage', () => {
    expect(() => deriveOnChainBagId('0x1234', REF)).toThrow(/address/);
    expect(() => deriveOnChainBagId(CREATOR, '0x1234')).toThrow(/bytes32/);
  });
});
