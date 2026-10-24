import type { Bag } from '@/types';
import type { BagDefinition } from '@/types/strategy';
import { DCA_TOKENS } from './profile';
export type DcaTrialBag = Pick<Bag, 'id' | 'name' | 'version' | 'chains' | 'composition'> & { performanceFeeBps?: number | null; definitionHash?: string };
export const DCA_REFERENCE_ID = 'local-reference';
export const DCA_REFERENCE_DEFINITION: BagDefinition = {
  kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'MUTABLE',
  assets: [
    { chain: 'robinhood', address: DCA_TOKENS.WETH, decimals: 18, weightBps: 4000 },
    { chain: 'robinhood', address: DCA_TOKENS.cbBTC, decimals: 8, weightBps: 3000 },
    { chain: 'robinhood', address: DCA_TOKENS.USDG, decimals: 6, weightBps: 3000 },
  ],
  rules: { weightBounds: { minBps: 100, maxBps: 7000 }, maxAssets: 10, minInvestment: null,
    swapSlippageBps: 100, rebalance: { frequency: 'MANUAL', driftThresholdBps: 500 }, performanceFeeBps: 0, noRouteAssetPolicy: 'BLOCK' },
};
export const DCA_REFERENCE_BAG: DcaTrialBag = { id: DCA_REFERENCE_ID, name: 'Local reference · WETH 40% / cbBTC 30% / USDG 30%', performanceFeeBps: 0, chains: ['robinhood'],
  composition: DCA_REFERENCE_DEFINITION.assets.map(a => ({ address: a.address, weightBps: a.weightBps, weight: a.weightBps / 100, symbol: Object.entries(DCA_TOKENS).find(([, address]) => address === a.address)![0] })) };
