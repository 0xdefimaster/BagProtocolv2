import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BagCreationPendingError, BagCreationVerificationError, BagDeploymentAdapter } from '@/lib/blockchain/adapter';
import { computeOnChainBagId, computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { RecipeAsset } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// UNIT tests for lib/server/deploy-bag.ts — orchestration and trust-boundary
// logic only. Both repositories and the chain adapter are MOCKED here, so this
// says nothing about database semantics (see integration/*.integration.test.ts,
// real PostgreSQL) or about real-chain verification (see evm/__tests__ and the
// local-EVM integration suite). It replaces the previous deployBagToChain()
// tests, which described the removed backend-signed flow.
// -----------------------------------------------------------------------------

const getBagById = vi.fn();
const getCurrentBagVersion = vi.fn();
const getDeployment = vi.fn();
const confirmUserSignedDeployment = vi.fn();

vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagById(...a), getCurrentBagVersion: (...a: unknown[]) => getCurrentBagVersion(...a) }));
vi.mock('@/lib/server/bag-deployment-repo', () => ({
  getDeployment: (...a: unknown[]) => getDeployment(...a),
  confirmUserSignedDeployment: (...a: unknown[]) => confirmUserSignedDeployment(...a),
}));

import { confirmBagDeployment, getBagDeploymentState, prepareBagDeployment } from '../deploy-bag';

const BAG_ID = '11111111-1111-1111-1111-111111111111';
const OWNER = '00000000-0000-0000-0000-0000000000a1';
const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const FACTORY = '0xfac70fac70fac70fac70fac70fac70fac70fac70';
const TX = `0x${'ab'.repeat(32)}`;
const ASSETS: RecipeAsset[] = [{ chain: 'robinhood', address: '0x11111111111111111111111111111111111111aa', symbol: 'BTC', decimals: 18, weightBps: 10000 }];

const bag = (over: Record<string, unknown> = {}) => ({ id: BAG_ID, creatorId: OWNER, chain: 'robinhood', mutability: 'MUTABLE', status: 'DRAFT', contractAddress: null, registryId: null, ...over });
const version = { id: '22222222-2222-2222-2222-222222222222', recipe: { assets: ASSETS } };
const session = { userId: OWNER, walletAddress: WALLET };

const verified = {
  contractAddress: `0x${'ba'.repeat(20)}`,
  txHash: TX,
  blockNumber: 77,
  onChainBagId: `0x${'cc'.repeat(32)}`,
  creatorAddress: WALLET.toLowerCase(),
  offChainRef: computeOnChainBagId(BAG_ID),
};

function makeAdapter(over: Partial<BagDeploymentAdapter> = {}) {
  const adapter = {
    name: 'test-adapter',
    isLive: false,
    factoryAddress: FACTORY,
    prepareBagCreation: vi.fn(async () => ({ to: FACTORY, data: '0xdeadbeef' as `0x${string}`, chainId: 4663, value: '150000000000000' })),
    hasBagOnChain: vi.fn(async () => false),
    verifyBagCreation: vi.fn(async () => verified as never),
    ...over,
  } as unknown as BagDeploymentAdapter & { prepareBagCreation: ReturnType<typeof vi.fn>; hasBagOnChain: ReturnType<typeof vi.fn>; verifyBagCreation: ReturnType<typeof vi.fn> };
  const resolveAdapter = vi.fn(() => adapter);
  return { adapter, deps: { resolveAdapter } };
}

const admin = {} as never;
const confirmed = (over: Record<string, unknown> = {}) => ({
  outcome: 'CONFIRMED',
  deployment: { id: 'd1', txHash: TX, status: 'DEPLOYED' },
  bag: { status: 'ACTIVE', contractAddress: verified.contractAddress, registryId: 'robinhood' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getBagById.mockResolvedValue(bag());
  getCurrentBagVersion.mockResolvedValue(version);
  getDeployment.mockResolvedValue(null);
  confirmUserSignedDeployment.mockResolvedValue(confirmed());
});

describe('prepareBagDeployment', () => {
  it('owner: returns calldata for the Bag-derived chain, the adapter\'s factory, and the session wallet as the only valid sender', async () => {
    const { adapter, deps } = makeAdapter();
    const r = await prepareBagDeployment(admin, session, BAG_ID, deps);
    expect(r).toMatchObject({ ok: true, chain: 'robinhood', factoryAddress: FACTORY, wallet: WALLET.toLowerCase(), transaction: { to: FACTORY, chainId: 4663 } });
    expect(deps.resolveAdapter).toHaveBeenCalledWith('robinhood'); // the Bag's chain — there is no chain parameter to pass
    expect(adapter.prepareBagCreation).toHaveBeenCalledWith({
      offChainRef: computeOnChainBagId(BAG_ID),
      compositionHash: computeOnChainCompositionHash(ASSETS),
      metadataURI: `bag:${BAG_ID}`,
      isMutable: true, // recorded on-chain: an IMMUTABLE Bag can never record a new version
    });
  });

  it('is STATELESS: it never writes (no finalize RPC) and only reads deployment state', async () => {
    const { deps } = makeAdapter();
    await prepareBagDeployment(admin, session, BAG_ID, deps);
    await prepareBagDeployment(admin, session, BAG_ID, deps);
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it('non-owner → FORBIDDEN, and the chain is never consulted', async () => {
    const { adapter, deps } = makeAdapter();
    const r = await prepareBagDeployment(admin, { userId: 'someone-else', walletAddress: WALLET }, BAG_ID, deps);
    expect(r).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(deps.resolveAdapter).not.toHaveBeenCalled();
    expect(adapter.prepareBagCreation).not.toHaveBeenCalled();
  });

  it.each(['', undefined, 'nope', '0x123'])('a session wallet of %j → NO_WALLET_ON_SESSION before anything is read', async (walletAddress) => {
    const { deps } = makeAdapter();
    expect(await prepareBagDeployment(admin, { userId: OWNER, walletAddress: walletAddress as string }, BAG_ID, deps)).toEqual({ ok: false, error: 'NO_WALLET_ON_SESSION' });
    expect(getBagById).not.toHaveBeenCalled();
  });

  it('BAG_NOT_FOUND / BAG_ARCHIVED / NO_VERSION / ALREADY_DEPLOYED', async () => {
    const { deps } = makeAdapter();
    getBagById.mockResolvedValueOnce(null);
    expect(await prepareBagDeployment(admin, session, BAG_ID, deps)).toEqual({ ok: false, error: 'BAG_NOT_FOUND' });
    getBagById.mockResolvedValueOnce(bag({ status: 'ARCHIVED' }));
    expect(await prepareBagDeployment(admin, session, BAG_ID, deps)).toEqual({ ok: false, error: 'BAG_ARCHIVED' });
    getCurrentBagVersion.mockResolvedValueOnce(null);
    expect(await prepareBagDeployment(admin, session, BAG_ID, deps)).toEqual({ ok: false, error: 'NO_VERSION' });
    getDeployment.mockResolvedValueOnce({ status: 'DEPLOYED', txHash: TX });
    expect(await prepareBagDeployment(admin, session, BAG_ID, deps)).toMatchObject({ ok: false, error: 'ALREADY_DEPLOYED' });
  });

  it('a Bag already created on-chain by this wallet → ALREADY_CREATED_ON_CHAIN (no doomed transaction is offered)', async () => {
    const { adapter, deps } = makeAdapter({ hasBagOnChain: vi.fn(async () => true) });
    expect(await prepareBagDeployment(admin, session, BAG_ID, deps)).toEqual({ ok: false, error: 'ALREADY_CREATED_ON_CHAIN' });
    expect(adapter.prepareBagCreation).not.toHaveBeenCalled();
  });

  it('fails CLOSED if the chain cannot be resolved or read — never a mock', async () => {
    expect(await prepareBagDeployment(admin, session, BAG_ID, { resolveAdapter: () => { throw new Error('No EVM deployment config'); } })).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
    const { deps } = makeAdapter({ hasBagOnChain: vi.fn(async () => { throw new Error('rpc down'); }) });
    expect(await prepareBagDeployment(admin, session, BAG_ID, deps)).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE', message: 'rpc down' });
  });
});

describe('confirmBagDeployment', () => {
  it('verifies against SERVER-derived expectations (session wallet, Bag chain, fresh composition hash, DB offChainRef) and finalizes atomically', async () => {
    const { adapter, deps } = makeAdapter();
    const r = await confirmBagDeployment(admin, session, BAG_ID, TX.toUpperCase().replace('0X', '0x'), deps);
    expect(r).toMatchObject({ ok: true, alreadyConfirmed: false, bag: { status: 'ACTIVE' } });
    expect(adapter.verifyBagCreation).toHaveBeenCalledWith({
      txHash: TX, // canonicalised to lower-case BEFORE it reaches the chain
      expectedFactoryAddress: FACTORY,
      expectedOffChainRef: computeOnChainBagId(BAG_ID),
      expectedCompositionHash: computeOnChainCompositionHash(ASSETS),
      expectedCreator: WALLET.toLowerCase(),
      expectedIsMutable: true, // bags.mutability — verified against Bag.isMutable() on-chain
    });
    // ONE finalizing call, carrying the chain's answers (from the receipt), the verified version id, and the session user
    expect(confirmUserSignedDeployment).toHaveBeenCalledTimes(1);
    expect(confirmUserSignedDeployment).toHaveBeenCalledWith(admin, {
      bagId: BAG_ID,
      creatorId: OWNER,
      bagVersionId: version.id,
      chain: 'robinhood',
      factoryAddress: FACTORY,
      contractAddress: verified.contractAddress,
      txHash: TX,
      blockNumber: 77,
      onChainBagId: verified.onChainBagId,
      onChainCreator: verified.creatorAddress,
    });
  });

  it('the composition hash is re-derived from the CURRENT version on every confirm (never cached from prepare)', async () => {
    const { adapter, deps } = makeAdapter();
    const edited: RecipeAsset[] = [{ ...ASSETS[0], weightBps: 10000, symbol: 'ETH' }];
    getCurrentBagVersion.mockResolvedValueOnce({ id: version.id, recipe: { assets: edited } });
    await confirmBagDeployment(admin, session, BAG_ID, TX, deps);
    expect(adapter.verifyBagCreation).toHaveBeenCalledWith(expect.objectContaining({ expectedCompositionHash: computeOnChainCompositionHash(edited) }));
    expect(computeOnChainCompositionHash(edited)).not.toBe(computeOnChainCompositionHash(ASSETS));
  });

  it.each(['', 'nope', '0x1234', `0x${'g'.repeat(64)}`, null, undefined, 42])('an invalid txHash (%j) is rejected before any repository or chain access', async (bad) => {
    const { adapter, deps } = makeAdapter();
    expect(await confirmBagDeployment(admin, session, BAG_ID, bad as string, deps)).toEqual({ ok: false, error: 'INVALID_TX_HASH' });
    expect(getBagById).not.toHaveBeenCalled();
    expect(adapter.verifyBagCreation).not.toHaveBeenCalled();
  });

  it('non-owner → FORBIDDEN with no chain call and no write; missing session wallet → NO_WALLET_ON_SESSION', async () => {
    const { adapter, deps } = makeAdapter();
    expect(await confirmBagDeployment(admin, { userId: 'x', walletAddress: WALLET }, BAG_ID, TX, deps)).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await confirmBagDeployment(admin, { userId: OWNER, walletAddress: '' }, BAG_ID, TX, deps)).toEqual({ ok: false, error: 'NO_WALLET_ON_SESSION' });
    expect(adapter.verifyBagCreation).not.toHaveBeenCalled();
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it('DUPLICATE: the same tx already recorded → success from our own record; no chain call, no write', async () => {
    const { adapter, deps } = makeAdapter();
    getDeployment.mockResolvedValue({ status: 'DEPLOYED', txHash: TX, id: 'd1' });
    getBagById.mockResolvedValue(bag({ status: 'ACTIVE', contractAddress: verified.contractAddress, registryId: 'robinhood' }));
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX.toUpperCase().replace('0X', '0x'), deps)).toMatchObject({ ok: true, alreadyConfirmed: true });
    expect(adapter.verifyBagCreation).not.toHaveBeenCalled();
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it('DUPLICATE racing the writer: a Bag snapshot read BEFORE the deployment committed is never reported — the post-commit Bag is', async () => {
    const { deps } = makeAdapter();
    // First read: DRAFT (the concurrent writer has not committed yet). Then the deployment row is already DEPLOYED.
    getBagById
      .mockResolvedValueOnce(bag())
      .mockResolvedValueOnce(bag({ status: 'ACTIVE', contractAddress: verified.contractAddress, registryId: 'robinhood' }));
    getDeployment.mockResolvedValue({ status: 'DEPLOYED', txHash: TX, id: 'd1' });
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX, deps)).toMatchObject({
      ok: true,
      alreadyConfirmed: true,
      bag: { status: 'ACTIVE', contractAddress: verified.contractAddress, registryId: 'robinhood' },
    });
  });

  it('CONFLICT: a different tx for an already-deployed Bag → CONFLICTING_DEPLOYMENT carrying the ORIGINAL; no chain call, no write', async () => {
    const { adapter, deps } = makeAdapter();
    const original = { status: 'DEPLOYED', txHash: `0x${'11'.repeat(32)}`, id: 'd1' };
    getDeployment.mockResolvedValue(original);
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX, deps)).toEqual({ ok: false, error: 'CONFLICTING_DEPLOYMENT', deployment: original });
    expect(adapter.verifyBagCreation).not.toHaveBeenCalled();
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it('PENDING is distinct from failure and writes nothing', async () => {
    const { deps } = makeAdapter({ verifyBagCreation: vi.fn(async () => { throw new BagCreationPendingError('not mined yet'); }) });
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX, deps)).toEqual({ ok: false, error: 'PENDING', message: 'not mined yet' });
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it.each(['wrong tx', 'wrong sender', 'wrong factory', 'reverted', 'missing BagCreated', 'spoofed BagCreated', 'wrong creator', 'wrong offChainRef', 'wrong compositionHash', 'wrong bagId', 'wrong factory.bagOf', 'wrong Bag.creator'])(
    'verification failure (%s) → VERIFICATION_FAILED and NOTHING is written',
    async (reason) => {
      const { deps } = makeAdapter({ verifyBagCreation: vi.fn(async () => { throw new BagCreationVerificationError(reason); }) });
      expect(await confirmBagDeployment(admin, session, BAG_ID, TX, deps)).toEqual({ ok: false, error: 'VERIFICATION_FAILED', message: reason });
      expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
    }
  );

  it('an RPC outage is CHAIN_ERROR (retryable, not a verdict on the transaction) and writes nothing', async () => {
    const { deps } = makeAdapter({ verifyBagCreation: vi.fn(async () => { throw new Error('ECONNRESET'); }) });
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX, deps)).toEqual({ ok: false, error: 'CHAIN_ERROR', message: 'ECONNRESET' });
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the chain is not configured', async () => {
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX, { resolveAdapter: () => { throw new Error('not configured'); } })).toMatchObject({ ok: false, error: 'CHAIN_UNAVAILABLE' });
    expect(confirmUserSignedDeployment).not.toHaveBeenCalled();
  });

  it.each([
    [{ outcome: 'ALREADY_CONFIRMED' }, { ok: true, alreadyConfirmed: true }],
    [{ outcome: 'CONFLICT', deployment: { id: 'orig' } }, { ok: false, error: 'CONFLICTING_DEPLOYMENT', deployment: { id: 'orig' } }],
    [{ outcome: 'STALE_VERSION' }, { ok: false, error: 'STALE_VERSION' }],
    [{ outcome: 'IDENTITY_TAKEN' }, { ok: false, error: 'IDENTITY_TAKEN' }],
    [{ outcome: 'FORBIDDEN' }, { ok: false, error: 'FORBIDDEN' }],
    [{ outcome: 'BAG_NOT_FOUND' }, { ok: false, error: 'BAG_NOT_FOUND' }],
  ])('maps the finalizing RPC outcome %j', async (rpcResult, expected) => {
    const { deps } = makeAdapter();
    confirmUserSignedDeployment.mockResolvedValue(confirmed(rpcResult));
    expect(await confirmBagDeployment(admin, session, BAG_ID, TX, deps)).toMatchObject(expected);
  });
});

describe('getBagDeploymentState', () => {
  it('owner-only read', async () => {
    getDeployment.mockResolvedValue({ status: 'DEPLOYED' });
    expect(await getBagDeploymentState(admin, session, BAG_ID)).toMatchObject({ ok: true, bagStatus: 'DRAFT', chain: 'robinhood', deployment: { status: 'DEPLOYED' } });
    expect(await getBagDeploymentState(admin, { userId: 'x', walletAddress: WALLET }, BAG_ID)).toEqual({ ok: false, error: 'FORBIDDEN' });
    getBagById.mockResolvedValueOnce(null);
    expect(await getBagDeploymentState(admin, session, BAG_ID)).toEqual({ ok: false, error: 'BAG_NOT_FOUND' });
  });
});
