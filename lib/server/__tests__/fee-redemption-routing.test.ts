import { afterEach, describe, expect, it, vi } from 'vitest';

// Routing invariant (lib/server/fee-redemption-path.ts): a sale with a fee goes through RedeemSettlement ONLY once it
// is configured — the older RedeemFeeRouter can no longer be signed for, whatever else is configured — and the legacy
// LI.FI / Composer paths always refuse a fee (redeem-fee-path.test.ts). A free sale keeps the existing path.

const { feeRedemptionPath } = await import('../fee-redemption-path');
const { signFeeAttestation, RouterNotConfiguredError } = await import('../redeem-fee-attestation');

const A = (n: string) => `0x${n.repeat(40)}`;

afterEach(() => vi.unstubAllEnvs());

function env(o: { settlement?: boolean; router?: boolean; vault?: boolean }) {
  vi.stubEnv('REDEEM_SETTLEMENT_ADDRESS', o.settlement ? A('5') : '');
  vi.stubEnv('REDEEM_FEE_ROUTER_ADDRESS', o.router ? A('6') : '');
  vi.stubEnv('CREATOR_REWARDS_VAULT_ADDRESS', o.vault ? A('7') : '');
  vi.stubEnv('REDEEM_FEE_ATTESTOR_PRIVATE_KEY', `0x${'11'.repeat(32)}`);
}

describe('feeRedemptionPath', () => {
  it.each([
    [{ settlement: true, router: true, vault: true }, 'SETTLEMENT'],
    [{ settlement: true }, 'SETTLEMENT'],
    [{ router: true, vault: true }, 'FEE_ROUTER'],
    [{ router: true }, 'NONE'],
    [{}, 'NONE'],
  ] as const)('%o → %s', (o, path) => {
    env(o);
    expect(feeRedemptionPath()).toBe(path);
  });
});

describe('RedeemFeeRouter cannot be signed for once RedeemSettlement is configured', () => {
  it('router, vault and attestor key all set, plus RedeemSettlement: refused before anything is read', async () => {
    env({ settlement: true, router: true, vault: true });
    const admin = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } });
    await expect(signFeeAttestation(admin as never, 'u1', 'intent_1')).rejects.toBeInstanceOf(RouterNotConfiguredError);
  });

  it('nothing deployed: refused as before', async () => {
    env({});
    await expect(signFeeAttestation({} as never, 'u1', 'intent_1')).rejects.toBeInstanceOf(RouterNotConfiguredError);
  });
});
