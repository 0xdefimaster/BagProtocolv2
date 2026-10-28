import { describe, expect, it } from 'vitest';
import { allocationColor, allocationGradient } from '../allocation-colors';

describe('allocation colours', () => {
  it('builds one donut slice per position, back to back', () => {
    expect(allocationGradient([{ weight: 30 }, { weight: 50 }, { weight: 20 }])).toBe(
      `conic-gradient(${allocationColor(0)} 0% 30%, ${allocationColor(1)} 30% 80%, ${allocationColor(2)} 80% 100%)`
    );
  });
  it('cycles colours past the palette and has a neutral empty state', () => {
    expect(allocationColor(8)).toBe(allocationColor(0));
    expect(allocationGradient([])).toBe('var(--surface-2)');
  });
});
