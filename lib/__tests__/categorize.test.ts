import { describe, expect, it } from 'vitest';
import { categoryForPosition, getCategoryBreakdown } from '../categorize';

describe('categoryForPosition', () => {
  it('uses the registry assetType for stock tokens the demo list does not know', () => {
    expect(categoryForPosition({ symbol: 'PFE', assetType: 'stock' })).toBe('Stocks');
    expect(categoryForPosition({ symbol: 'IBRX', assetType: 'stock' })).toBe('Stocks');
  });

  it('keeps the sector refinement for known symbols', () => {
    expect(categoryForPosition({ symbol: 'KLAC', assetType: 'stock' })).toBe('AI');
    expect(categoryForPosition({ symbol: 'UNI', assetType: 'crypto' })).toBe('DeFi');
    expect(categoryForPosition({ symbol: 'USDC', assetType: 'crypto' })).toBe('Crypto');
  });

  it('falls back to the old symbol lookup when the API gave no assetType', () => {
    expect(categoryForPosition({ symbol: 'PFE' })).toBe('Crypto');
  });
});

describe('getCategoryBreakdown', () => {
  it('a Robinhood stock-token Bag is reported as stocks, not crypto', () => {
    const breakdown = getCategoryBreakdown([
      { symbol: 'IBRX', weight: 58, assetType: 'stock' },
      { symbol: 'KLAC', weight: 15, assetType: 'stock' },
      { symbol: 'PFE', weight: 12, assetType: 'stock' },
      { symbol: 'QNT', weight: 15, assetType: 'stock' },
    ]);
    expect(breakdown).toEqual([
      { category: 'Stocks', weight: 85 },
      { category: 'AI', weight: 15 },
    ]);
  });
});
