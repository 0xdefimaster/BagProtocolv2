import { beforeEach, describe, expect, it, vi } from 'vitest';

// B0 §5.6: a fee-paying sale and a purchase of the same position are never open at the same time. Fee-free sales
// (rate 0, or the creator's own) never block a purchase.

let openRedeem: { id: string; status: string; expiresAt: string } | null = null;
let openPurchase: { id: string; status: string; expiresAt: string } | null = null;
vi.mock('@/lib/server/redeem-intent-repo', () => ({ findActiveRedeemIntentForBag: async () => openRedeem }));
vi.mock('@/lib/server/purchase-intent-repo', () => ({ findActivePurchaseIntentForBag: async () => openPurchase }));

const { openFeeRedemptionFor, purchaseInFlightFor, redemptionPaysFee } = await import('../fee-redemption-lock');

const NOW = Date.parse('2026-10-05T12:00:00Z');
const later = '2026-10-05T12:05:00Z';
const earlier = '2026-10-05T11:55:00Z';
const admin = {} as never;
const feeBag = { id: 'bag_1', creatorId: 'creator', performanceFeeBpsLocked: 150 };

beforeEach(() => {
  openRedeem = null;
  openPurchase = null;
});

describe('fee-redemption lock', () => {
  it('a sale pays a fee only for a non-creator on a Bag with a rate', () => {
    expect(redemptionPaysFee(feeBag, null, 'investor')).toBe(true);
    expect(redemptionPaysFee(feeBag, null, 'creator')).toBe(false);
    expect(redemptionPaysFee({ ...feeBag, performanceFeeBpsLocked: null }, { recipe: { performanceFeeBps: 0 } } as never, 'investor')).toBe(false);
    expect(redemptionPaysFee({ ...feeBag, performanceFeeBpsLocked: null }, { recipe: { performanceFeeBps: 200 } } as never, 'investor')).toBe(true);
  });

  it('an open fee-paying sale blocks a purchase; an expired quote does not, a submitted transaction always does', async () => {
    openRedeem = { id: 'r1', status: 'READY', expiresAt: later };
    expect(await openFeeRedemptionFor(admin, 'investor', feeBag, null, NOW)).toEqual({ id: 'r1' });
    openRedeem = { id: 'r1', status: 'QUOTED', expiresAt: earlier };
    expect(await openFeeRedemptionFor(admin, 'investor', feeBag, null, NOW)).toBeNull();
    openRedeem = { id: 'r1', status: 'CONFIRMING', expiresAt: earlier };
    expect(await openFeeRedemptionFor(admin, 'investor', feeBag, null, NOW)).toEqual({ id: 'r1' });
  });

  it('a fee-free sale never blocks a purchase', async () => {
    openRedeem = { id: 'r1', status: 'READY', expiresAt: later };
    expect(await openFeeRedemptionFor(admin, 'creator', feeBag, null, NOW)).toBeNull();
    expect(await openFeeRedemptionFor(admin, 'investor', { ...feeBag, performanceFeeBpsLocked: 0 }, null, NOW)).toBeNull();
  });

  it('a purchase in flight blocks a fee attestation, with the same expiry rule', async () => {
    expect(await purchaseInFlightFor(admin, 'investor', 'bag_1', NOW)).toBeNull();
    openPurchase = { id: 'p1', status: 'AWAITING_SIGNATURE', expiresAt: later };
    expect(await purchaseInFlightFor(admin, 'investor', 'bag_1', NOW)).toEqual({ id: 'p1' });
    openPurchase = { id: 'p1', status: 'QUOTED', expiresAt: earlier };
    expect(await purchaseInFlightFor(admin, 'investor', 'bag_1', NOW)).toBeNull();
    openPurchase = { id: 'p1', status: 'SUBMITTED', expiresAt: earlier };
    expect(await purchaseInFlightFor(admin, 'investor', 'bag_1', NOW)).toEqual({ id: 'p1' });
  });
});
