import { beforeEach, describe, expect, it, vi } from 'vitest';

// A4 hardening (P0): the fee-router path runs the same pre-sign coverage check as the legacy path. A fee is
// never attested — and so the wallet can never sign — for a sale the wallet and the books no longer cover.

const coverageMock = vi.fn();
const updateStatusMock = vi.fn();
const previewMock = vi.fn(() => {
  throw new Error('PAST_COVERAGE_CHECK');
});

const intent = {
  id: 'r1',
  bagId: 'bag_1',
  status: 'READY',
  sharesRaw: '100',
  redeemValueQuote: '100',
  steps: [{ action: 'SWAP', inputAsset: { chain: 'robinhood', address: '0xa' }, inputAmountRaw: '100' }],
};

vi.mock('@/lib/config/robinhood-chain', async (orig) => ({
  ...(await orig<object>()),
  DEPLOYED_CONTRACTS: { redeemFeeRouter: '0x00000000000000000000000000000000000000f1', creatorRewardsVault: '0x00000000000000000000000000000000000000f2' },
}));
vi.mock('@/lib/server/redeem-intent-repo', () => ({
  getRedeemIntentForUser: async () => ({ ok: true, intent }),
  updateRedeemIntentStatus: (...a: unknown[]) => updateStatusMock(...a),
}));
vi.mock('@/lib/server/sale-coverage', () => ({ checkSaleCoverage: (...a: unknown[]) => coverageMock(...a) }));
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ getInvestorPosition: async () => ({ sharesRaw: '100', costBasisQuote: '100' }) }));
vi.mock('@/lib/server/bag-repo', () => ({
  getBagById: async () => ({ id: 'bag_1', creatorId: 'creator', performanceFeeBpsLocked: 1000 }),
  getCurrentBagVersion: async () => ({ recipe: { performanceFeeBps: 1000 } }),
}));
vi.mock('@/lib/domain/basket-protocol/redeem/performance-fee-preview', () => ({ previewPerformanceFee: () => previewMock() }));

const { signFeeAttestation, SaleNoLongerCoveredError, BalanceUnavailableError } = await import('../redeem-fee-attestation');

const admin = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { wallet_address: '0x1111111111111111111111111111111111111111' }, error: null }) }) }) }),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('REDEEM_FEE_ATTESTOR_PRIVATE_KEY', 'set-but-never-reached-in-these-tests');
});

describe('signFeeAttestation — pre-sign coverage (fee path)', () => {
  it('tokens moved out after the quote: fails the intent, signs nothing', async () => {
    coverageMock.mockResolvedValue('NOT_COVERED');
    await expect(signFeeAttestation(admin, 'investor', 'r1')).rejects.toBeInstanceOf(SaleNoLongerCoveredError);
    expect(updateStatusMock).toHaveBeenCalledWith(admin, expect.objectContaining({ id: 'r1', to: 'FAILED', failureCode: 'ROUTE_EXPIRED' }));
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('balances unreadable: signs nothing, the intent is left as it is', async () => {
    coverageMock.mockResolvedValue('BALANCE_UNAVAILABLE');
    await expect(signFeeAttestation(admin, 'investor', 'r1')).rejects.toBeInstanceOf(BalanceUnavailableError);
    expect(updateStatusMock).not.toHaveBeenCalled();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("checks the redeemer's own wallet against this intent, then continues to the fee", async () => {
    coverageMock.mockResolvedValue('COVERED');
    await expect(signFeeAttestation(admin, 'investor', 'r1')).rejects.toThrow('PAST_COVERAGE_CHECK');
    expect(coverageMock).toHaveBeenCalledWith(admin, { userId: 'investor', walletAddress: '0x1111111111111111111111111111111111111111' }, intent);
  });
});
