import { expect, it } from 'vitest';
import { supportsDcaTrial } from '../profile';
import { DCA_REFERENCE_BAG } from '../reference';
it('recognizes the reference by chain, addresses and weights', () => expect(supportsDcaTrial(DCA_REFERENCE_BAG)).toBe(true));
it('never substitutes symbols for token identities or swaps another Bag into the trial', () => {
  expect(supportsDcaTrial({ ...DCA_REFERENCE_BAG, composition: DCA_REFERENCE_BAG.composition.map(a => ({ ...a, address: undefined })) })).toBe(false);
  expect(supportsDcaTrial({ ...DCA_REFERENCE_BAG, chains: ['ethereum'] })).toBe(false);
  expect(supportsDcaTrial({ ...DCA_REFERENCE_BAG, composition: [DCA_REFERENCE_BAG.composition[0], ...DCA_REFERENCE_BAG.composition.slice(0, 2)] })).toBe(false);
});
