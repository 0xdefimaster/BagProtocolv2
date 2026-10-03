import { describe, expect, it } from 'vitest';
import { Bag } from '@/types';
import { mockBags } from '@/lib/mock-data';
import { buildRecipeFromBag } from '../recipe';

// -----------------------------------------------------------------------------
// `buildRecipeFromBag()` — Phase 11 additions only (strategy-type default and
// wiring). See lib/domain/basket-protocol/validation/__tests__/recipe-
// validation.test.ts for full recipe validation coverage, and
// lib/mappers/bag-mapper.ts's own round-trip for the API-boundary side.
// -----------------------------------------------------------------------------

function legacyBag(overrides: Partial<Bag> = {}): Bag {
  // `mockBags[0]` predates Phase 11 and has no `strategyType` field at all
  // — exactly the "legacy Bag" case spec section 12 asks for, not a
  // synthetic one.
  return { ...mockBags[0], ...overrides };
}

describe('buildRecipeFromBag — strategy type (Phase 11)', () => {
  it('defaults a legacy Bag (no strategyType field) to STATIC_BASKET', () => {
    const bag = legacyBag();
    expect(bag.strategyType).toBeUndefined(); // sanity: fixture really is legacy-shaped

    const recipe = buildRecipeFromBag({ bag });
    expect(recipe.strategyType).toBe('STATIC_BASKET');
  });

  it('produces STATIC_BASKET for a freshly created Bag too', () => {
    const bag = legacyBag({ id: 'user-new', strategyType: 'STATIC_BASKET' });
    const recipe = buildRecipeFromBag({ bag });
    expect(recipe.strategyType).toBe('STATIC_BASKET');
  });

  it('never produces any strategy type other than STATIC_BASKET', () => {
    for (const bag of mockBags) {
      const recipe = buildRecipeFromBag({ bag });
      expect(recipe.strategyType).toBe('STATIC_BASKET');
    }
  });
});
