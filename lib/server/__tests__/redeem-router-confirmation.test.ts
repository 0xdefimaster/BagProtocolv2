import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { computeOnChainBagId } from '@/lib/domain/basket-protocol/onchain';

// -----------------------------------------------------------------------------
// verifyAndIndexRouterRedemption: what binds a client-submitted txHash to a
// redeem intent. The outer transaction may target a smart account or entry
// point (EIP-5792 batch), so the binding is the Router's own Redeemed event:
// emitted by the configured router, for this intent's redemption id, for this
// intent's wallet. The RPC, repos and Supabase are mocked.
// -----------------------------------------------------------------------------

const ROUTER = '0x' + 'a'.repeat(40);
const WALLET = '0x' + 'b'.repeat(40);
const CREATOR = '0x' + 'c'.repeat(40);
const OTHER = '0x' + 'd'.repeat(40);
const INTENT_ID = '11111111-2222-4333-8444-555555555555';
const TX = ('0x' + 'e'.repeat(64)) as Hex;

const mocks = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getIntent: vi.fn(),
  updateStatus: vi.fn(),
  getBag: vi.fn(),
}));

vi.mock('@/lib/blockchain/rpc/clients', () => ({
  getChainPublicClient: () => ({ getTransaction: mocks.getTransaction, waitForTransactionReceipt: mocks.waitForTransactionReceipt }),
}));
vi.mock('@/lib/config/robinhood-chain', () => ({
  DEPLOYED_CONTRACTS: { redeemFeeRouter: '0x' + 'a'.repeat(40) },
  rewardTokenRawToQuoteDecimal: (raw: bigint) => String(raw),
}));
vi.mock('@/lib/server/redeem-intent-repo', () => ({ getRedeemIntentForUser: mocks.getIntent, updateRedeemIntentStatus: mocks.updateStatus }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: mocks.getBag }));

import { verifyAndIndexRouterRedemption } from '../redeem-router-confirmation';

const REDEEMED = [
  {
    type: 'event',
    name: 'Redeemed',
    inputs: [
      { name: 'redemptionId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'legCount', type: 'uint256', indexed: false },
      { name: 'swapOutput', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'userProceeds', type: 'uint256', indexed: false },
    ],
  },
] as const;

function redeemedLog(o: { emitter?: string; redemptionId?: Hex; user?: string } = {}) {
  return {
    address: o.emitter ?? ROUTER,
    topics: encodeEventTopics({ abi: REDEEMED, eventName: 'Redeemed', args: { redemptionId: o.redemptionId ?? computeOnChainBagId(INTENT_ID), user: (o.user ?? WALLET) as Hex, creator: CREATOR as Hex } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(1), BigInt(1000), BigInt(10), BigInt(990)]),
  };
}

const admin = { rpc: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  admin.rpc.mockResolvedValue({ error: null });
  mocks.getIntent.mockResolvedValue({
    ok: true,
    intent: { id: INTENT_ID, bagId: 'bag-1', walletAddress: WALLET.toUpperCase().replace('0X', '0x'), status: 'AWAITING_SIGNATURE', steps: [], sharesRaw: '1', shareDecimals: 18, redeemValueQuote: '1', outputDecimals: 6 },
  });
  mocks.getBag.mockResolvedValue({ id: 'bag-1', creatorId: 'creator-1' });
  // An EIP-5792 smart-account batch: the outer transaction targets the wallet itself, not the router.
  mocks.getTransaction.mockResolvedValue({ hash: TX, to: WALLET });
});

const run = () => verifyAndIndexRouterRedemption(admin as never, 'user-1', INTENT_ID, TX);

describe('verifyAndIndexRouterRedemption', () => {
  it('indexes a batch whose outer target is not the router, on the router’s own event for this intent and wallet', async () => {
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [redeemedLog()] });
    await run();
    expect(admin.rpc).toHaveBeenCalledWith('apply_redeem_execution_router_settled', expect.objectContaining({ p_intent_id: INTENT_ID, p_onchain_tx_hash: TX, p_creator_wallet: expect.stringMatching(/^0x[cC]{40}$/) }));
    expect(mocks.updateStatus).toHaveBeenCalledWith(admin, { id: INTENT_ID, from: 'AWAITING_SIGNATURE', to: 'COMPLETED' });
  });

  it('refuses a Redeemed event emitted by any other contract', async () => {
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [redeemedLog({ emitter: OTHER })] });
    await expect(run()).rejects.toThrow(/no Redeemed event from the RedeemFeeRouter/);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('refuses another redemption’s event, and this redemption id redeemed for another wallet', async () => {
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [redeemedLog({ redemptionId: computeOnChainBagId('99999999-2222-4333-8444-555555555555') })] });
    await expect(run()).rejects.toThrow(/different redemption/);
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [redeemedLog({ user: OTHER })] });
    await expect(run()).rejects.toThrow(/not this intent's wallet/);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('refuses a reverted transaction and an unknown hash', async () => {
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted', logs: [redeemedLog()] });
    await expect(run()).rejects.toThrow(/reverted/);
    mocks.getTransaction.mockRejectedValue(new Error('not found'));
    await expect(run()).rejects.toThrow(/not found on Robinhood Chain/);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
