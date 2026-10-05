import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedeemIntent } from '@/types/redeem-intent';

// A sale the wallet never signed (tab closed, wallet dismissed without a REJECTED report) must not lock the position
// forever. It is released (→ EXPIRED) only once signing it can no longer do anything: before the wallet and past its
// expiry, or a settlement sale past its attestation deadline (the contract refuses it after). Everything else still
// blocks a new sale.

let active: Partial<RedeemIntent> | null = null;
let liveAttestation: { id: string } | null = null;
const transitions: { from: string; to: string }[] = [];

vi.mock('@/lib/server/redeem-intent-repo', async () => {
  const { assertValidPurchaseIntentTransition } = await vi.importActual<typeof import('@/lib/domain/basket-protocol/purchase-intent/state-machine')>(
    '@/lib/domain/basket-protocol/purchase-intent/state-machine'
  );
  return {
    findActiveRedeemIntentForBag: async () => active,
    updateRedeemIntentStatus: async (_a: unknown, u: { from: Parameters<typeof assertValidPurchaseIntentTransition>[0]; to: Parameters<typeof assertValidPurchaseIntentTransition>[1] }) => {
      assertValidPurchaseIntentTransition(u.from, u.to);
      transitions.push({ from: u.from, to: u.to });
      return { ...active, status: u.to };
    },
    createRedeemIntent: vi.fn(),
    getRedeemIntentForUser: vi.fn(),
    markRedeemAccountingApplied: vi.fn(),
    markRedeemReconciliationApplied: vi.fn(),
    recordRedeemSettlementResult: vi.fn(),
    updateRedeemIntentSteps: vi.fn(),
  };
});
vi.mock('@/lib/server/fee-redemption-lock', () => ({ liveSettlementAttestationFor: async () => liveAttestation }));
// Past the checks under test, the sale stops at the Bag lookup.
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => null, getCurrentBagVersion: async () => null }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));

const { createRedeemIntentForUser } = await import('../redeem-execution');

const nowSec = () => Math.floor(Date.now() / 1000);
const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();
const create = () =>
  createRedeemIntentForUser({ admin: {} as never, session: { userId: 'u1', walletAddress: '0x1' } as never, bagId: 'bag_1', fractionBps: 10_000, outputAssetId: 'usdg' });

beforeEach(() => {
  active = null;
  liveAttestation = null;
  transitions.length = 0;
});

describe('createRedeemIntentForUser — an abandoned sale does not lock the position forever', () => {
  it('settlement sale awaiting a signature past its attestation deadline: released, a new sale may start', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', expiresAt: future, settlementPlan: { deadline: nowSec() - 1 } as never };
    const outcome = await create();
    expect(transitions).toEqual([{ from: 'AWAITING_SIGNATURE', to: 'EXPIRED' }]);
    expect(outcome).toEqual({ ok: false, error: { kind: 'BAG_NOT_FOUND' } });
  });

  it('settlement sale awaiting a signature still before its deadline: blocks (the signed transaction could still settle)', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', expiresAt: past, settlementPlan: { deadline: nowSec() + 60 } as never };
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
    expect(transitions).toEqual([]);
  });

  it.each(['DRAFT', 'QUOTED', 'READY'] as const)('%s past its expiry (never handed to the wallet): released', async (status) => {
    active = { id: 'old', status, expiresAt: past, settlementPlan: null };
    expect(await create()).toEqual({ ok: false, error: { kind: 'BAG_NOT_FOUND' } });
    expect(transitions).toEqual([{ from: status, to: 'EXPIRED' }]);
  });

  it('READY not yet expired: blocks', async () => {
    active = { id: 'old', status: 'READY', expiresAt: future, settlementPlan: null };
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
  });

  it('a free Composer sale awaiting a signature has no deadline of ours: blocks even past expiry', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', expiresAt: past, settlementPlan: null };
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
    expect(transitions).toEqual([]);
  });

  it.each(['SUBMITTED', 'CONFIRMING'] as const)('%s is never released here: the transaction is out', async (status) => {
    active = { id: 'old', status, expiresAt: past, settlementPlan: { deadline: nowSec() - 1 } as never };
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
  });

  it('released, but another attestation of the position is still live: still blocked by the §9 lock', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', expiresAt: future, settlementPlan: { deadline: nowSec() - 1 } as never };
    liveAttestation = { id: 'other' };
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'other' } });
  });
});
