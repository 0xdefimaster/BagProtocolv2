import { describe, expect, it } from 'vitest';
import { UnsupportedChainError, toLiFiChainId } from '../lifi-config';

// -----------------------------------------------------------------------------
// Phase 16 — chain-id mapping, including 'robinhood' (Robinhood Chain)
// added this phase. See lifi-config.ts's module doc for how the 4663
// value was verified (Robinhood Chain's own EVM chain id + LI.FI's own
// announcement that it routes into Stock Tokens there from launch) —
// this file just locks that mapping down with a test.
// -----------------------------------------------------------------------------

describe('toLiFiChainId', () => {
  it('maps every currently-supported ChainId to its LI.FI numeric id', () => {
    expect(toLiFiChainId('ethereum')).toBe(1);
    expect(toLiFiChainId('arbitrum')).toBe(42161);
    expect(toLiFiChainId('base')).toBe(8453);
    expect(toLiFiChainId('solana')).toBe(1151111081099710);
  });

  it('maps robinhood (Robinhood Chain) to its EVM chain id, 4663', () => {
    expect(toLiFiChainId('robinhood')).toBe(4663);
  });

  it('throws UnsupportedChainError, never silently guesses, for a chain with no mapping', () => {
    expect(() => toLiFiChainId('not-a-real-chain' as unknown as 'ethereum')).toThrow(UnsupportedChainError);
  });
});
