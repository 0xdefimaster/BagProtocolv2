import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedeemIntent } from '@/types/redeem-intent';

// A sale the wallet never signed (tab closed, wallet dismissed without a REJECTED report) must not lock the position
// forever. It is released (→ EXPIRED) only once signing it can no longer do anything: before the wallet and past its
// expiry, or a settlement sale past its attestation deadline (the contract refuses it after). Everything else still
// blocks a new sale.

let active: Partial<RedeemIntent> | null = null;
let liveAttestation: { id: string } | null = null;
const transitions: { from: string; to: string; steps?: unknown[] }[] = [];
const searchMock = vi.fn();
const tokenSaleSearchMock = vi.fn();
const trackComposerMock = vi.fn();
const trackStepMock = vi.fn();
let outflowBooked = false;

vi.mock('@/lib/server/rebalance-execution', () => ({ hasOpenRebalance: async () => null }));
vi.mock('@/lib/server/redeem-intent-repo', async () => {
  const { assertValidPurchaseIntentTransition } = await vi.importActual<typeof import('@/lib/domain/basket-protocol/purchase-intent/state-machine')>(
    '@/lib/domain/basket-protocol/purchase-intent/state-machine'
  );
  return {
    findActiveRedeemIntentForBag: async () => active,
    updateRedeemIntentStatus: async (
      _a: unknown,
      u: { from: Parameters<typeof assertValidPurchaseIntentTransition>[0]; to: Parameters<typeof assertValidPurchaseIntentTransition>[1]; steps?: unknown[] }
    ) => {
      assertValidPurchaseIntentTransition(u.from, u.to);
      transitions.push(u.steps ? { from: u.from, to: u.to, steps: u.steps } : { from: u.from, to: u.to });
      active = { ...active, status: u.to, ...(u.steps ? { steps: u.steps as RedeemIntent['steps'] } : {}) };
      return active;
    },
    createRedeemIntent: vi.fn(),
    getRedeemIntentForUser: async () => ({ ok: true, intent: active }),
    markRedeemAccountingApplied: vi.fn(),
    markRedeemReconciliationApplied: vi.fn(),
    recordRedeemSettlementResult: vi.fn(),
    updateRedeemIntentSteps: async (_a: unknown, _id: string, _status: string, steps: RedeemIntent['steps']) => {
      active = { ...active, steps };
      return active;
    },
  };
});
vi.mock('@/lib/blockchain/composer-tx-search', () => ({
  findComposerTransactionFromWallet: (...a: unknown[]) => searchMock(...a),
  findTokenSaleTransactionFromWallet: (...a: unknown[]) => tokenSaleSearchMock(...a),
}));
vi.mock('@/lib/blockchain/lifi-status', () => ({ trackStepStatus: (...a: unknown[]) => trackStepMock(...a) }));
vi.mock('@/lib/server/ledger-repo', () => ({ hasExternalOutflowSince: async () => outflowBooked }));
vi.mock('@/lib/blockchain/composer-status', () => ({ trackComposerTransaction: (...a: unknown[]) => trackComposerMock(...a) }));
vi.mock('@/lib/server/intent-tx-claims', () => ({
  TX_HASH_RE: /^0x[0-9a-fA-F]{64}$/,
  claimNewlyVerifiedTxHashes: async (_a: unknown, _k: unknown, _id: unknown, _before: unknown, after: unknown) => after,
}));
vi.mock('@/lib/server/fee-redemption-lock', () => ({ liveSettlementAttestationFor: async () => liveAttestation }));
// Past the checks under test, the sale stops at the Bag lookup.
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: async () => null, getCurrentBagVersion: async () => null }));
vi.mock('@/lib/server/price-provider', () => ({ getPriceProvider: () => ({}) }));

const { createRedeemIntentForUser, cancelOpenRedeemIntent } = await import('../redeem-execution');

const nowSec = () => Math.floor(Date.now() / 1000);
const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();
const create = () =>
  createRedeemIntentForUser({ admin: {} as never, session: { userId: 'u1', walletAddress: '0x1' } as never, bagId: 'bag_1', fractionBps: 10_000, outputAssetId: 'usdg' });

beforeEach(() => {
  active = null;
  liveAttestation = null;
  transitions.length = 0;
  searchMock.mockReset();
  tokenSaleSearchMock.mockReset();
  trackComposerMock.mockReset();
  trackStepMock.mockReset();
  outflowBooked = false;
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

describe('createRedeemIntentForUser — a free Composer sale awaiting a signature (#27)', () => {
  const TX = `0x${'ab'.repeat(32)}`;
  const longPast = new Date(Date.now() - 60 * 60_000).toISOString(); // expiry an hour ago: past the grace period
  const composerTransaction = { to: '0xComposerVM', data: '0xdeadbeef', value: '0', chainId: 4663, approvals: [] };
  const swap = (i: number) => ({
    stepIndex: i,
    action: 'SWAP' as const,
    status: 'AWAITING_SIGNATURE',
    txHash: null,
    sourceChain: 'robinhood' as const,
    destinationChain: 'robinhood' as const,
    inputAsset: { chain: 'robinhood' as const, address: i === 0 ? '0xTokenA' : '0xTokenB' },
    inputAmountRaw: '100',
    outputAsset: { chain: 'robinhood' as const, address: '0xUSDG' },
    outputAmountRaw: '50',
  });
  const freeSale = (expiresAt: string): Partial<RedeemIntent> =>
    ({
      id: 'old',
      status: 'AWAITING_SIGNATURE',
      expiresAt,
      createdAt: new Date(Date.parse(expiresAt) - 180_000).toISOString(),
      settlementPlan: null,
      composerTransaction,
      walletAddress: '0xWallet',
      outputAsset: { chain: 'robinhood', address: '0xUSDG' },
      steps: [swap(0), swap(1)],
    }) as unknown as Partial<RedeemIntent>;

  it('within the grace period after expiry: blocks, and the chain is not even asked', async () => {
    active = freeSale(past);
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('past the grace period and the built transaction was never sent: released, a new sale may start', async () => {
    active = freeSale(longPast);
    searchMock.mockResolvedValue({ kind: 'NOT_FOUND' });
    expect(await create()).toEqual({ ok: false, error: { kind: 'BAG_NOT_FOUND' } });
    expect(transitions).toEqual([{ from: 'AWAITING_SIGNATURE', to: 'EXPIRED' }]);
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'robinhood', wallet: '0xWallet', soldTokens: ['0xTokenA', '0xTokenB'], expected: composerTransaction })
    );
  });

  it('the chain cannot answer (RPC down, or a wallet transaction still pending): blocks, nothing released', async () => {
    active = freeSale(longPast);
    searchMock.mockResolvedValue({ kind: 'UNKNOWN', reason: 'a transaction from the wallet is still pending' });
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
    expect(transitions).toEqual([]);
  });

  it('the sale was mined but never reported: recovered as SUBMITTED with its hash, verified, and still blocks while confirming', async () => {
    active = freeSale(longPast);
    searchMock.mockResolvedValue({ kind: 'FOUND', txHash: TX });
    trackComposerMock.mockResolvedValue({ kind: 'PENDING' });
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
    expect(transitions[0]).toMatchObject({ from: 'AWAITING_SIGNATURE', to: 'SUBMITTED' });
    expect((transitions[0].steps as { txHash: string; status: string }[]).every((st) => st.txHash === TX && st.status === 'SUBMITTED')).toBe(true);
    // verify checked exactly the found transaction against the built one
    expect(trackComposerMock).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX, recipient: '0xWallet', expectedTransaction: composerTransaction }));
    expect(transitions.map((t) => t.to)).not.toContain('EXPIRED');
  });

  it('a recovered transaction that failed on-chain ends FAILED, which frees the position', async () => {
    active = freeSale(longPast);
    searchMock.mockResolvedValue({ kind: 'FOUND', txHash: TX });
    trackComposerMock.mockResolvedValue({ kind: 'FAILED', failureCode: 'TRANSACTION_REVERTED' });
    expect(await create()).toEqual({ ok: false, error: { kind: 'BAG_NOT_FOUND' } });
    expect(transitions.map((t) => t.to)).toEqual(['SUBMITTED', 'FAILED']);
  });

  it('a settlement sale is never searched this way (its attestation deadline decides)', async () => {
    active = { ...freeSale(longPast), settlementPlan: { deadline: nowSec() + 60 } as never };
    expect(await create()).toEqual({ ok: false, error: { kind: 'REDEEM_IN_PROGRESS', intentId: 'old' } });
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('cancelOpenRedeemIntent — the owner closes a sale that blocks a new one, once the chain says it is safe', () => {
  const cancel = () => cancelOpenRedeemIntent({} as never, { userId: 'u1', walletAddress: '0x1' } as never, 'old');
  const swap = (txHash: string | null = null) => ({ stepIndex: 0, action: 'SWAP', status: 'AWAITING_SIGNATURE', txHash, sourceChain: 'robinhood', inputAsset: { address: '0xaa' } });
  const composerTransaction = { to: '0x7', data: '0xdead', value: '0', chainId: 4663, approvals: [] };

  it('a sale never handed to the wallet is cancelled', async () => {
    active = { id: 'old', status: 'READY', steps: [swap()] as never, expiresAt: future };
    expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'CANCELLED' } });
    expect(transitions).toEqual([{ from: 'READY', to: 'CANCELLED' }]);
  });

  it('a free Composer sale found on-chain after reconciliation already booked its outflow is closed, not booked again', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap()] as never, composerTransaction, expiresAt: future, createdAt: past, walletAddress: '0x1' };
    searchMock.mockResolvedValueOnce({ kind: 'FOUND', txHash: '0x' + 'd'.repeat(64) });
    outflowBooked = true;
    expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'CANCELLED' } });
    expect(trackComposerMock).not.toHaveBeenCalled();
  });

  it('a free Composer sale the chain shows was never sent is cancelled; one the chain cannot answer for is refused with the reason', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap()] as never, composerTransaction, expiresAt: future, createdAt: past, walletAddress: '0x1' };
    searchMock.mockResolvedValueOnce({ kind: 'NOT_FOUND' });
    expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'CANCELLED' } });

    transitions.length = 0;
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap()] as never, composerTransaction, expiresAt: future, createdAt: past, walletAddress: '0x1' };
    searchMock.mockResolvedValueOnce({ kind: 'UNKNOWN', reason: 'a transaction from the wallet is still pending' });
    const refused = await cancel();
    expect(refused).toMatchObject({ ok: true, value: { result: 'REFUSED', status: 'AWAITING_SIGNATURE', reason: expect.stringMatching(/still pending/) } });
    expect(transitions).toEqual([]);
  });

  it('a fee-paying sale: refused while its signed settlement is valid, expired after, cancelled if never signed', async () => {
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap()] as never, settlementPlan: { deadline: nowSec() + 60 } as never };
    expect(await cancel()).toMatchObject({ ok: true, value: { result: 'REFUSED' } });
    expect(transitions).toEqual([]);
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap()] as never, settlementPlan: { deadline: nowSec() - 1 } as never };
    expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'EXPIRED' } });
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap()] as never, settlementPlan: {} as never };
    expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'CANCELLED' } });
  });

  describe('a per-asset sale awaiting signature (its SUBMITTED reports may have been lost)', () => {
    const perAsset = (i: number, token: string, amount: string) => ({
      stepIndex: i, action: 'SWAP', status: 'AWAITING_SIGNATURE', txHash: null, sourceChain: 'robinhood', destinationChain: 'robinhood',
      inputAsset: { address: token }, inputAmountRaw: amount, outputAsset: { address: '0xusdg' },
    });
    const openSale = () => ({
      id: 'old', status: 'AWAITING_SIGNATURE' as const, walletAddress: '0x1', createdAt: past, expiresAt: future,
      steps: [perAsset(0, '0xaa', '100'), perAsset(1, '0xbb', '200')] as never,
    });
    const HASH = '0x' + 'c'.repeat(64);

    it('no swap of it is on-chain: cancelled, each token searched by its exact amount', async () => {
      active = openSale();
      tokenSaleSearchMock.mockResolvedValue({ kind: 'NOT_FOUND' });
      expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'CANCELLED' } });
      expect(tokenSaleSearchMock.mock.calls.map((c) => [c[0].token, c[0].amountRaw])).toEqual([['0xaa', '100'], ['0xbb', '200']]);
    });

    it('a swap that did go through is recovered with its hash and sent to verification, never cancelled', async () => {
      active = openSale();
      tokenSaleSearchMock.mockResolvedValueOnce({ kind: 'FOUND', txHash: HASH }).mockResolvedValueOnce({ kind: 'NOT_FOUND' });
      trackStepMock.mockResolvedValue({ kind: 'PENDING', substatus: 'PENDING' });
      const out = await cancel();
      expect(transitions[0]).toMatchObject({ from: 'AWAITING_SIGNATURE', to: 'SUBMITTED' });
      expect(transitions[0].steps).toEqual([
        expect.objectContaining({ stepIndex: 0, status: 'SUBMITTED', txHash: HASH }),
        expect.objectContaining({ stepIndex: 1, status: 'FAILED', failureCode: 'USER_REJECTED' }),
      ]);
      expect(trackStepMock).toHaveBeenCalledWith(expect.objectContaining({ txHash: HASH, expectedInputAmountRaw: '100' }));
      expect(transitions.some((t) => t.to === 'CANCELLED')).toBe(false);
      expect(out).toMatchObject({ ok: true, value: { result: 'REFUSED' } }); // still confirming: closes on its own once verified
    });

    it('a found swap whose tokens wallet reconciliation already took off the position is closed, never booked twice', async () => {
      active = openSale();
      tokenSaleSearchMock.mockResolvedValueOnce({ kind: 'FOUND', txHash: HASH }).mockResolvedValueOnce({ kind: 'NOT_FOUND' });
      outflowBooked = true;
      expect(await cancel()).toEqual({ ok: true, value: { result: 'CLOSED', status: 'CANCELLED' } });
      expect(transitions).toEqual([{ from: 'AWAITING_SIGNATURE', to: 'CANCELLED' }]);
      expect(trackStepMock).not.toHaveBeenCalled();
    });

    it('the chain cannot answer: refused with the reason, nothing changed', async () => {
      active = openSale();
      tokenSaleSearchMock.mockResolvedValue({ kind: 'UNKNOWN', reason: 'a transaction from the wallet is still pending' });
      expect(await cancel()).toMatchObject({ ok: true, value: { result: 'REFUSED', reason: expect.stringMatching(/still pending/) } });
      expect(transitions).toEqual([]);
    });
  });

  it('never cancels a sale whose transaction was reported sent, and leaves a final one alone', async () => {
    active = { id: 'old', status: 'FAILED', steps: [swap()] as never };
    expect(await cancel()).toEqual({ ok: true, value: { result: 'ALREADY_FINAL', status: 'FAILED' } });
    active = { id: 'old', status: 'AWAITING_SIGNATURE', steps: [swap('0x' + 'a'.repeat(64))] as never, composerTransaction, expiresAt: future, createdAt: past, walletAddress: '0x1' };
    const out = await cancel().catch(() => null);
    expect(transitions.some((t) => t.to === 'CANCELLED')).toBe(false);
    expect(out === null || (out.ok && out.value.result !== 'CLOSED')).toBe(true);
  });
});
