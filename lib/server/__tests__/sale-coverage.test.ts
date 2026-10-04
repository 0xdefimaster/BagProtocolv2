import { describe, expect, it, vi } from 'vitest';

const positionMock = vi.fn();
const sellableMock = vi.fn();
vi.mock('@/lib/server/bag-investor-position-repo', () => ({ getInvestorPosition: (...a: unknown[]) => positionMock(...a) }));
vi.mock('@/lib/server/position-valuation', () => ({ observeUserHoldings: async () => ({ rows: [] }), sellableHoldingsForBag: (...a: unknown[]) => sellableMock(...a) }));
vi.mock('@/lib/blockchain/rpc/clients', () => ({ getChainPublicClient: () => ({}) }));

const { checkSaleCoverage } = await import('../sale-coverage');

const A = '0x00000000000000000000000000000000000000a1';
const intent = { bagId: 'b', sharesRaw: '10', steps: [{ inputAsset: { chain: 'robinhood', address: A }, inputAmountRaw: '60' }] } as never;
const user = { userId: 'u', walletAddress: '0xw' };
const holding = (sellableRaw: string) => [{ chain: 'robinhood', address: A, decimals: 18, quantityRaw: '100', sellableRaw }];

describe('checkSaleCoverage (shared by every sell path)', () => {
  it('COVERED / NOT_COVERED / BALANCE_UNAVAILABLE', async () => {
    positionMock.mockResolvedValue({ sharesRaw: '10' });
    sellableMock.mockReturnValue(holding('60'));
    expect(await checkSaleCoverage({} as never, user, intent)).toBe('COVERED');
    sellableMock.mockReturnValue(holding('59'));
    expect(await checkSaleCoverage({} as never, user, intent)).toBe('NOT_COVERED');
    sellableMock.mockReturnValue(null);
    expect(await checkSaleCoverage({} as never, user, intent)).toBe('BALANCE_UNAVAILABLE');
  });
});
