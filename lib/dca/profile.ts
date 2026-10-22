import type { Bag } from '@/types';
export const DCA_TOKENS = {
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  cbBTC: '0xcec185eb182c47d1ba1efc84e6959e18cd620be4',
} as const;
export function supportsDcaTrial(bag: Pick<Bag, 'chains' | 'composition'>): boolean {
  const expected: Record<string, number> = { [DCA_TOKENS.WETH]: 4000, [DCA_TOKENS.cbBTC]: 3000, [DCA_TOKENS.USDG]: 3000 };
  return bag.chains.length === 1 && bag.chains[0] === 'robinhood' && bag.composition.length === 3 &&
    new Set(bag.composition.map(a => a.address?.toLowerCase())).size === 3 &&
    bag.composition.every(a => !!a.address && expected[a.address.toLowerCase()] === (a.weightBps ?? a.weight * 100));
}
