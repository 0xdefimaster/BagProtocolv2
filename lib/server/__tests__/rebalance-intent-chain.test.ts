import { describe, expect, it } from 'vitest';
import { rebalanceIntentChain } from '../rebalance-execution';

const leg = (chain: string) => ({ chain, address: '0x1', decimals: 18, symbol: 'X', amountRaw: '1', weightBps: 10000, expectedOutRaw: null, minOutRaw: null });
const tx = (chainId: number) => ({ to: '0x2', data: '0x', value: '0', chainId, approvals: [] });

describe('rebalanceIntentChain', () => {
  it('the legs’ one chain, when the recorded transaction is for that chain', () => {
    expect(rebalanceIntentChain({ sells: [leg('base')], buys: [leg('base')], composerTransaction: tx(8453) })).toBe('base');
    expect(rebalanceIntentChain({ sells: [leg('robinhood')], buys: [leg('robinhood')], composerTransaction: tx(4663) })).toBe('robinhood');
  });

  it('null (never verified anywhere) for mixed legs, an unknown chain, or a transaction for another chain', () => {
    expect(rebalanceIntentChain({ sells: [leg('base')], buys: [leg('robinhood')], composerTransaction: tx(8453) })).toBeNull();
    expect(rebalanceIntentChain({ sells: [leg('base')], buys: [leg('base')], composerTransaction: tx(4663) })).toBeNull();
    expect(rebalanceIntentChain({ sells: [leg('solana')], buys: [leg('solana')], composerTransaction: tx(1) })).toBeNull();
  });
});
