import type { Bag } from '@/types';
export const DCA_TOKENS = {
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  cbBTC: '0xcec185eb182c47d1ba1efc84e6959e18cd620be4',
} as const;
type TrialProfile = Pick<Bag, 'chains' | 'composition'> & { performanceFeeBps?: number | null };
export function dcaTrialUnsupportedReason(bag: TrialProfile): string | null {
  if (bag.chains.length !== 1 || bag.chains[0] !== 'robinhood') return 'The local trial supports single-chain Robinhood Bags.';
  if (bag.performanceFeeBps !== 0) return 'This trial supports Bags with an explicitly declared 0% performance fee. Profit-fee accounting is not implemented.';
  if (bag.composition.length < 1 || bag.composition.length > 10) return 'The local trial supports up to 10 assets.';
  if (new Set(bag.composition.map(a => a.address?.toLowerCase())).size !== bag.composition.length || bag.composition.some(a =>
    !a.address || !/^0x[0-9a-fA-F]{40}$/.test(a.address) || /^0x0{40}$/i.test(a.address) ||
    !Number.isInteger(a.weightBps ?? a.weight * 100) || (a.weightBps ?? a.weight * 100) <= 0) ||
    bag.composition.reduce((sum,a) => sum + (a.weightBps ?? a.weight * 100),0) !== 10000) return 'This Bag has an invalid allocation.';
  if (bag.composition.every(a => a.address!.toLowerCase() === DCA_TOKENS.USDG)) return 'This Bag has no swap legs; the trial requires at least one asset to buy.';
  return null;
}
export const supportsDcaTrial = (bag: TrialProfile): boolean => dcaTrialUnsupportedReason(bag) === null;
