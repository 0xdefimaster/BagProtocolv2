import { describe, expect, it } from 'vitest';
import {
  NATIVE_ASSET_ADDRESS,
  assetIdentitiesEqual,
  assetIdentityKey,
  isNativeAssetIdentity,
  normalizeAssetAddress,
  normalizeAssetIdentity,
  recipeAssetIdentity,
} from '../asset-identity';

describe('asset identity — same chain + same address → same asset', () => {
  it('two identical identities are equal', () => {
    const a = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111a' };
    const b = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111a' };
    expect(assetIdentitiesEqual(a, b)).toBe(true);
    expect(assetIdentityKey(a)).toBe(assetIdentityKey(b));
  });
});

describe('asset identity — different chain → different asset', () => {
  it('Base 0xABC and Ethereum 0xABC are different assets', () => {
    const base = { chain: 'base' as const, address: '0x000000000000000000000000000000000000abc' };
    const eth = { chain: 'ethereum' as const, address: '0x000000000000000000000000000000000000abc' };
    expect(assetIdentitiesEqual(base, eth)).toBe(false);
    expect(assetIdentityKey(base)).not.toBe(assetIdentityKey(eth));
  });
});

describe('asset identity — different address on the same chain → different asset', () => {
  it('two different addresses on ethereum are different assets', () => {
    const a = { chain: 'ethereum' as const, address: '0x1111111111111111111111111111111111111a' };
    const b = { chain: 'ethereum' as const, address: '0x2222222222222222222222222222222222222b' };
    expect(assetIdentitiesEqual(a, b)).toBe(false);
  });
});

describe('asset identity — address normalization', () => {
  it('EVM addresses are case-insensitive: 0xAbC... and 0xabc... are the same identity', () => {
    const mixedCase = { chain: 'ethereum' as const, address: '0xAbCDEF1234567890AbCDEF1234567890aBcDeF12' };
    const lowerCase = { chain: 'ethereum' as const, address: '0xabcdef1234567890abcdef1234567890abcdef12' };
    expect(assetIdentitiesEqual(mixedCase, lowerCase)).toBe(true);
  });

  it('normalizeAssetAddress lowercases EVM addresses only', () => {
    expect(normalizeAssetAddress('ethereum', '0xAbC')).toBe('0xabc');
    expect(normalizeAssetAddress('base', '0xAbC')).toBe('0xabc');
    expect(normalizeAssetAddress('arbitrum', '0xAbC')).toBe('0xabc');
  });

  it('Solana addresses are case-sensitive and pass through unchanged', () => {
    const solanaAddress = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    expect(normalizeAssetAddress('solana', solanaAddress)).toBe(solanaAddress);
    // Different casing on Solana IS a different (or at least not
    // guaranteed-equal) identity — normalization must not silently
    // lowercase a case-sensitive address space.
    expect(normalizeAssetAddress('solana', solanaAddress.toLowerCase())).toBe(solanaAddress.toLowerCase());
  });

  it('normalizeAssetIdentity trims whitespace', () => {
    const identity = normalizeAssetIdentity({ chain: 'ethereum', address: '  0xAbC  ' });
    expect(identity.address).toBe('0xabc');
  });
});

describe('native asset identity', () => {
  it('recognizes the EVM native sentinel address', () => {
    expect(isNativeAssetIdentity({ chain: 'ethereum', address: NATIVE_ASSET_ADDRESS })).toBe(true);
    expect(isNativeAssetIdentity({ chain: 'ethereum', address: NATIVE_ASSET_ADDRESS.toUpperCase() })).toBe(true);
  });

  it('a real token address is not native', () => {
    expect(isNativeAssetIdentity({ chain: 'ethereum', address: '0x1111111111111111111111111111111111111a' })).toBe(
      false
    );
  });

  it('solana has no native sentinel registered yet — never falsely reports native', () => {
    expect(isNativeAssetIdentity({ chain: 'solana', address: NATIVE_ASSET_ADDRESS })).toBe(false);
  });
});

describe('recipeAssetIdentity', () => {
  it('extracts chain + address only, dropping symbol/decimals/weight', () => {
    const identity = recipeAssetIdentity({
      chain: 'base',
      address: '0x1111111111111111111111111111111111111a',
      symbol: 'BTC',
      decimals: 8,
      weightBps: 4000,
    });
    expect(identity).toEqual({ chain: 'base', address: '0x1111111111111111111111111111111111111a' });
  });
});
