import { afterEach, describe, expect, it, vi } from 'vitest';
import { performanceFeeEnabledOn, redeemSettlementAddressFor, settlementChainId, settlementTokenFor } from '../settlement';

afterEach(() => vi.unstubAllEnvs());

describe('per-chain fee settlement config', () => {
  it('Robinhood keeps USDG and its own variable; Base uses Circle USDC', () => {
    expect(settlementTokenFor('robinhood')).toMatchObject({ symbol: 'USDG', decimals: 6, freezeCheck: { fn: 'isFrozen' } });
    expect(settlementTokenFor('base')).toMatchObject({ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, freezeCheck: { fn: 'isBlacklisted' } });
    expect(settlementTokenFor('arbitrum')).toBeNull();
    expect(settlementChainId('base')).toBe(8453);
    expect(settlementChainId('robinhood')).toBe(4663);
  });

  it('a creator fee on Base only once its RedeemSettlement address is set (a malformed or zero address does not count)', () => {
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', '');
    expect(performanceFeeEnabledOn('base')).toBe(false);
    expect(redeemSettlementAddressFor('base')).toBeNull();
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', '0xdeployed-redeem-settlement-on-base');
    expect(performanceFeeEnabledOn('base')).toBe(false);
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', `0x${'0'.repeat(40)}`);
    expect(performanceFeeEnabledOn('base')).toBe(false);
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', '0x00000000000000000000000000000000000005e2');
    expect(performanceFeeEnabledOn('base')).toBe(true);
    expect(redeemSettlementAddressFor('base')).toBe('0x00000000000000000000000000000000000005e2');
    // The Base contract is never used for Robinhood Chain, and the reverse.
    expect(redeemSettlementAddressFor('robinhood')).not.toBe('0x00000000000000000000000000000000000005e2');
  });

  it('Robinhood Chain always allows a fee (settlement, fee router or the database-booked fee); other chains never', () => {
    expect(performanceFeeEnabledOn('robinhood')).toBe(true);
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', '0x00000000000000000000000000000000000005e2');
    expect(performanceFeeEnabledOn('arbitrum')).toBe(false);
    expect(performanceFeeEnabledOn('ethereum')).toBe(false);
  });
});
