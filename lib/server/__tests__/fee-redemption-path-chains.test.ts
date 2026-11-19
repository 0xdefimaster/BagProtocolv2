import { afterEach, describe, expect, it, vi } from 'vitest';
import { feeRedemptionPath } from '../fee-redemption-path';

afterEach(() => vi.unstubAllEnvs());

describe('feeRedemptionPath per chain', () => {
  it('Base: its own RedeemSettlement or nothing — never the Robinhood fee router', () => {
    vi.stubEnv('REDEEM_FEE_ROUTER_ADDRESS', '0x00000000000000000000000000000000000000f1');
    vi.stubEnv('CREATOR_REWARDS_VAULT_ADDRESS', '0x00000000000000000000000000000000000000f2');
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS', '');
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', '');
    expect(feeRedemptionPath('robinhood')).toBe('FEE_ROUTER');
    expect(feeRedemptionPath('base')).toBe('NONE');
    vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS_BASE', '0x00000000000000000000000000000000000005e2');
    expect(feeRedemptionPath('base')).toBe('SETTLEMENT');
    expect(feeRedemptionPath('robinhood')).toBe('FEE_ROUTER'); // Robinhood unchanged by the Base contract
    expect(feeRedemptionPath()).toBe('FEE_ROUTER'); // default stays Robinhood Chain
  });
});
