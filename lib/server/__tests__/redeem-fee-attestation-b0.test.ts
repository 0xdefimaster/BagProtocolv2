import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FEE_ATTESTATION_TYPES, REDEEM_FEE_ROUTER_EIP712_DOMAIN_NAME, REDEEM_FEE_ROUTER_EIP712_DOMAIN_VERSION, computeLegsHash } from '@/lib/blockchain/redeem-fee-router-eip712';

// B0 (docs/FEE_ECONOMICS_DESIGN.md): signFeeAttestation computes the fee on grossMinimumProceeds (Σ per-leg
// minimum outputs from real quotes), the A3 basis of exactly the quantities sold and the loss carried forward —
// in raw USDG, rounded down — and signs minUserProceeds = grossMinimumProceeds − fee. Worked case §4: floor 118.80,
// basis 100, 10% → fee 1.88, minUserProceeds 116.92.

// A throwaway key generated for this test only; it controls nothing.
const TEST_ATTESTOR_KEY = `0x${'11'.repeat(32)}` as const;
const ROUTER = '0x00000000000000000000000000000000000000f1';
const AMKR = '0x00000000000000000000000000000000000000a1';
const SOXX = '0x00000000000000000000000000000000000000a2';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const intent = {
  id: '6f1c2b3a-0000-4000-8000-000000000001',
  bagId: 'bag_1',
  status: 'READY',
  expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
  sharesRaw: '100',
  redeemValueQuote: '125', // the legacy NAV value: must NOT drive the fee any more
  steps: [
    { action: 'SWAP', inputAsset: { chain: 'robinhood', address: AMKR }, inputAmountRaw: '1000' },
    { action: 'SWAP', inputAsset: { chain: 'robinhood', address: SOXX }, inputAmountRaw: '1000' },
  ],
};
let bag = { id: 'bag_1', creatorId: 'creator', performanceFeeBpsLocked: 1000 as number | null };
let ledgerEvents: unknown[] = [];
let purchaseInFlight: { id: string } | null = null;
const ledgerCalls = vi.fn();

vi.mock('@/lib/config/robinhood-chain', async (orig) => ({
  ...(await orig<object>()),
  DEPLOYED_CONTRACTS: { redeemFeeRouter: ROUTER, creatorRewardsVault: '0x00000000000000000000000000000000000000f2' },
}));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ getRedeemIntentForUser: async () => ({ ok: true, intent }), updateRedeemIntentStatus: vi.fn() }));
vi.mock('@/lib/server/sale-coverage', () => ({ checkSaleCoverage: async () => 'COVERED' }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => bag, getCurrentBagVersion: async () => ({ recipe: { performanceFeeBps: 1000 } }) }));
vi.mock('@/lib/server/ledger-repo', () => ({
  listAllLedgerEventsForPosition: async (...a: unknown[]) => {
    ledgerCalls(...a);
    return ledgerEvents;
  },
}));
vi.mock('@/lib/server/fee-redemption-lock', () => ({ purchaseInFlightFor: async () => purchaseInFlight }));
vi.mock('@/lib/blockchain/robinhood-public-client', () => ({ getRobinhoodPublicClient: () => ({}) }));
// Each leg quotes 60 USDG; with 1% slippage its minimum is 59.40 → grossMinimumProceeds 118.80.
vi.mock('@/lib/blockchain/robinhood-uniswap-quoter', () => ({ createRobinhoodUniswapQuoter: () => async () => ({ amountOut: BigInt(60_000_000) }) }));
vi.mock('@/lib/blockchain/robinhood-swap-builder', () => ({
  COMMON_FEE_TIERS: [3000],
  buildRobinhoodSwapLeg: (i: { inputToken: string }) => ({ swapTarget: '0x00000000000000000000000000000000000000e1', swapCallData: `0x${i.inputToken.slice(2, 10)}` }),
}));

const { signFeeAttestation, PositionBusyError, FeeBasisUnavailableError, SaleQuoteExpiredError } = await import('../redeem-fee-attestation');

const admin = {
  from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: { wallet_address: id === 'creator' ? '0x2222222222222222222222222222222222222222' : '0x1111111111111111111111111111111111111111' }, error: null }) }) }) }),
} as never;

const buy = (seq: string, cost: string) => ({
  seq,
  kind: 'PURCHASE_FILL',
  quote: {},
  legs: [
    { chain: 'robinhood', address: AMKR, deltaRaw: '1000', costQuote: cost },
    { chain: 'robinhood', address: SOXX, deltaRaw: '1000', costQuote: cost },
  ],
});
const sellAll = (seq: string, proceedsEach: string) => ({
  seq,
  kind: 'REDEEM_FILL',
  quote: {},
  legs: [
    { chain: 'robinhood', address: AMKR, deltaRaw: '-1000', proceedsQuote: proceedsEach },
    { chain: 'robinhood', address: SOXX, deltaRaw: '-1000', proceedsQuote: proceedsEach },
  ],
});

beforeEach(() => {
  vi.stubEnv('REDEEM_FEE_ATTESTOR_PRIVATE_KEY', TEST_ATTESTOR_KEY);
  bag = { id: 'bag_1', creatorId: 'creator', performanceFeeBpsLocked: 1000 };
  ledgerEvents = [buy('1', '50')]; // basis $100 for everything being sold
  purchaseInFlight = null;
  ledgerCalls.mockClear();
});

describe('signFeeAttestation — B0 floor-based fee', () => {
  it('§4 case: floor 118.80, basis 100, 10% → fee 1.88, minUserProceeds 116.92 (the NAV value 125 plays no part)', async () => {
    const a = await signFeeAttestation(admin, 'investor', intent.id);
    expect(a.feeAmount).toBe('1880000');
    expect(a.minUserProceeds).toBe('116920000');
    expect(a.feeBreakdown).toEqual({ method: 'B0_FLOOR', rateBps: 1000, grossMinimumProceeds: '118800000', consumedBasis: '100000000', lossCarry: '0', feeBase: '18800000' });
    // The router invariant the user relies on: swapOutput ≥ minUserProceeds + fee = grossMinimumProceeds.
    expect(BigInt(a.minUserProceeds) + BigInt(a.feeAmount)).toBe(BigInt(a.feeBreakdown.grossMinimumProceeds));
    expect(ledgerCalls).toHaveBeenCalledWith(admin, 'investor', 'bag_1');
  });

  it('signs exactly what it returns, with the configured attestor key', async () => {
    const a = await signFeeAttestation(admin, 'investor', intent.id);
    const signer = await recoverTypedDataAddress({
      domain: { name: REDEEM_FEE_ROUTER_EIP712_DOMAIN_NAME, version: REDEEM_FEE_ROUTER_EIP712_DOMAIN_VERSION, chainId: 4663, verifyingContract: ROUTER },
      types: FEE_ATTESTATION_TYPES,
      primaryType: 'FeeAttestation',
      message: {
        redemptionId: a.redemptionId,
        user: a.user,
        creator: a.creator,
        feeAmount: BigInt(a.feeAmount),
        minUserProceeds: BigInt(a.minUserProceeds),
        deadline: BigInt(a.deadline),
        legsHash: computeLegsHash(a.legs.map((l) => ({ ...l, inputAmount: BigInt(l.inputAmount) }))),
      },
      signature: a.signature,
    });
    expect(signer).toBe(privateKeyToAccount(TEST_ATTESTOR_KEY).address);
  });

  it('a realized loss earlier is carried forward (F4): sold for 90, bought again at 100 → this sale pays on 18.80 − 10', async () => {
    ledgerEvents = [buy('1', '50'), sellAll('2', '45'), buy('3', '50')];
    const a = await signFeeAttestation(admin, 'investor', intent.id);
    expect(a.feeBreakdown).toMatchObject({ consumedBasis: '100000000', lossCarry: '10000000', feeBase: '8800000' });
    expect(a.feeAmount).toBe('880000');
  });

  it('floor below the basis: no fee, the user floor is the whole minimum', async () => {
    ledgerEvents = [buy('1', '60')]; // basis 120 > floor 118.80
    const a = await signFeeAttestation(admin, 'investor', intent.id);
    expect(a.feeAmount).toBe('0');
    expect(a.minUserProceeds).toBe('118800000');
  });

  it("the creator's own sale pays nothing and needs no basis", async () => {
    bag = { ...bag, creatorId: 'investor' };
    const a = await signFeeAttestation(admin, 'investor', intent.id);
    expect(a.feeAmount).toBe('0');
    expect(a.feeBreakdown.rateBps).toBe(0);
    expect(ledgerCalls).not.toHaveBeenCalled();
  });

  it("the attestation never outlives the sale intent (the purchase lock ends with it); an expired intent gets nothing", async () => {
    const a = await signFeeAttestation(admin, 'investor', intent.id);
    expect(a.deadline * 1000).toBeLessThanOrEqual(new Date(intent.expiresAt).getTime());
    const saved = intent.expiresAt;
    intent.expiresAt = new Date(Date.now() - 1000).toISOString();
    try {
      await expect(signFeeAttestation(admin, 'investor', intent.id)).rejects.toBeInstanceOf(SaleQuoteExpiredError);
    } finally {
      intent.expiresAt = saved;
    }
  });

  it('refuses (signs nothing) while a purchase of the same position is in flight (§5.6)', async () => {
    purchaseInFlight = { id: 'p1' };
    await expect(signFeeAttestation(admin, 'investor', intent.id)).rejects.toBeInstanceOf(PositionBusyError);
  });

  it('refuses when the books cannot give the basis — never guessed', async () => {
    ledgerEvents = [{ seq: '1', kind: 'OPENING_BALANCE', quote: {}, legs: [{ chain: 'robinhood', address: AMKR, deltaRaw: '1000', costQuote: null }, { chain: 'robinhood', address: SOXX, deltaRaw: '1000', costQuote: '50' }] }];
    await expect(signFeeAttestation(admin, 'investor', intent.id)).rejects.toMatchObject({ name: 'FeeBasisUnavailableError', reason: 'BASIS_UNKNOWN' });
    ledgerEvents = [];
    await expect(signFeeAttestation(admin, 'investor', intent.id)).rejects.toBeInstanceOf(FeeBasisUnavailableError);
  });
});
