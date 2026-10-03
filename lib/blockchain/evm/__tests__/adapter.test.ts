import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { bagFactoryAbi } from '../factory-abi';
import { deriveOnChainBagId } from '@/lib/domain/basket-protocol/onchain';
import { BagCreationPendingError, BagCreationVerificationError } from '../../adapter';
import { createEvmBagDeploymentAdapter } from '../adapter';
import type { EvmChainConfig } from '../config';

// -----------------------------------------------------------------------------
// UNIT TESTS — the verification LOGIC of the read-only EVM adapter, driven by a
// MOCKED viem PublicClient. They prove each check rejects what it should. They
// do NOT prove anything about a real chain: see
// lib/server/__tests__/integration/deploy-bag.local-evm.integration.test.ts for
// the same adapter against a real (local, in-process) EVM, and note that NO test
// in this repository has run against the production chain.
// -----------------------------------------------------------------------------

const FACTORY: Hex = '0xfAc70fAc70fAc70fAc70fAc70fAc70fAc70fAc70';
const SIGNER: Hex = '0x00000000000000000000000000000000000051Ee'; // the person's own wallet
const OTHER_WALLET: Hex = '0x000000000000000000000000000000000000bad0';
const OTHER_CONTRACT: Hex = '0x00000000000000000000000000000000000c0de1';
const BAG: Hex = '0x000000000000000000000000000000000000ba90';
const OFF_CHAIN_REF: Hex = `0x${'00'.repeat(16)}${'11'.repeat(16)}`;
const COMPOSITION: Hex = keccak256(toHex('BTC:6000|ETH:4000'));
const TX_HASH: Hex = `0x${'ee'.repeat(32)}`;

const CONFIG: EvmChainConfig = {
  chain: 'ethereum',
  viemChain: { id: 1 } as EvmChainConfig['viemChain'],
  rpcUrl: 'http://unused.invalid',
  factoryAddress: FACTORY,
  confirmations: 2,
  receiptTimeoutMs: 1234,
};

function bagCreatedLog(o: { address?: Hex; bagId?: Hex; creator?: Hex; offChainRef?: Hex; compositionHash?: Hex } = {}) {
  const creator = o.creator ?? SIGNER;
  const offChainRef = o.offChainRef ?? OFF_CHAIN_REF;
  const bagId = o.bagId ?? deriveOnChainBagId(creator, offChainRef);
  const topics = encodeEventTopics({ abi: bagFactoryAbi, eventName: 'BagCreated', args: { bagId, creator, offChainRef } });
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }], [BAG, o.compositionHash ?? COMPOSITION, BigInt(1)]);
  return { address: o.address ?? FACTORY, topics, data };
}

interface Scenario {
  tx?: { to: Hex | null; from: Hex } | null | Error;
  receipt?: { status: 'success' | 'reverted'; logs: unknown[] } | Error;
  bagOf?: Hex;
  bag?: { creator?: Hex; factory?: Hex; offChainRef?: Hex; bagId?: Hex; isMutable?: boolean };
  /** Chain head. The receipt is in block 123, so the default 124 is exactly the configured depth of 2. */
  head?: bigint;
}

function makeClient(s: Scenario = {}) {
  const ok = { tx: { to: FACTORY, from: SIGNER }, receipt: { status: 'success' as const, logs: [bagCreatedLog()] } };
  const tx = s.tx === undefined ? ok.tx : s.tx;
  const receipt = s.receipt === undefined ? ok.receipt : s.receipt;
  const expectedBagId = deriveOnChainBagId(SIGNER, OFF_CHAIN_REF);

  const getTransaction = vi.fn(async () => {
    if (tx instanceof Error) throw tx;
    return tx;
  });
  const getTransactionReceipt = vi.fn(async () => {
    if (receipt instanceof Error) throw receipt;
    return { ...receipt, transactionHash: TX_HASH, blockNumber: BigInt(123) };
  });
  const getBlockNumber = vi.fn(async () => s.head ?? BigInt(124));
  const readContract = vi.fn(async (args: { address: Hex; functionName: string }) => {
    if (args.functionName === 'bagOf') return s.bagOf ?? BAG;
    if (args.functionName === 'creator') return s.bag?.creator ?? SIGNER;
    if (args.functionName === 'factory') return s.bag?.factory ?? FACTORY;
    if (args.functionName === 'offChainRef') return s.bag?.offChainRef ?? OFF_CHAIN_REF;
    if (args.functionName === 'bagId') return s.bag?.bagId ?? expectedBagId;
    if (args.functionName === 'isMutable') return s.bag?.isMutable ?? true;
    if (args.functionName === 'creationFee') return BigInt(150_000_000_000_000);
    throw new Error(`unexpected read ${args.functionName}`);
  });
  const client = { getTransaction, getTransactionReceipt, getBlockNumber, readContract } as unknown as PublicClient;
  return { client, getTransaction, getTransactionReceipt, getBlockNumber, readContract };
}

const PARAMS = {
  txHash: TX_HASH,
  expectedFactoryAddress: FACTORY,
  expectedOffChainRef: OFF_CHAIN_REF,
  expectedCompositionHash: COMPOSITION,
  expectedCreator: SIGNER,
  expectedIsMutable: true,
};

const named = (name: string) => Object.assign(new Error(name), { name });

async function verify(s: Scenario, overrides: Partial<typeof PARAMS> = {}, config: EvmChainConfig = CONFIG) {
  const { client, ...spies } = makeClient(s);
  const adapter = createEvmBagDeploymentAdapter(config, client);
  return { promise: adapter.verifyBagCreation({ ...PARAMS, ...overrides }), ...spies };
}

describe('EvmBagDeploymentAdapter.prepareBagCreation / hasBagOnChain', () => {
  it('encodes createBag(offChainRef, compositionHash, metadataURI, isMutable) — no creator argument — with the current fee as value', async () => {
    const { client, getTransaction, getTransactionReceipt, getBlockNumber, readContract } = makeClient();
    const adapter = createEvmBagDeploymentAdapter(CONFIG, client);
    const result = await adapter.prepareBagCreation({ offChainRef: OFF_CHAIN_REF, compositionHash: COMPOSITION, metadataURI: 'bag:test', isMutable: true });

    expect(result.to).toBe(FACTORY); // correct factory
    expect(result.chainId).toBe(1); // correct chain
    expect(result.data).toBe(encodeFunctionData({ abi: bagFactoryAbi, functionName: 'createBag', args: [OFF_CHAIN_REF, COMPOSITION, 'bag:test', true] })); // correct calldata
    expect(result.value).toBe('150000000000000'); // the creation fee, in wei
    // Only the fee read — nothing about any transaction.
    expect(readContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName)).toEqual(['creationFee']);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it('exposes no signing or sending capability at all', () => {
    const adapter = createEvmBagDeploymentAdapter(CONFIG, makeClient().client);
    expect(Object.keys(adapter).sort()).toEqual(['factoryAddress', 'hasBagOnChain', 'isLive', 'name', 'prepareBagCreation', 'verifyBagCreation']);
  });

  it('hasBagOnChain reads factory.bagOf(creator-bound id): false for the zero address, true otherwise', async () => {
    const zero = createEvmBagDeploymentAdapter(CONFIG, makeClient({ bagOf: '0x0000000000000000000000000000000000000000' }).client);
    expect(await zero.hasBagOnChain(SIGNER, OFF_CHAIN_REF)).toBe(false);

    const { client, readContract } = makeClient();
    const exists = createEvmBagDeploymentAdapter(CONFIG, client);
    expect(await exists.hasBagOnChain(SIGNER, OFF_CHAIN_REF)).toBe(true);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'bagOf', args: [deriveOnChainBagId(SIGNER, OFF_CHAIN_REF)] }));
  });
});

describe('verifyBagCreation — happy path', () => {
  it('returns values READ from the confirmed event, lower-cased, honouring the configured confirmation depth and bounded timeout', async () => {
    const { promise, getTransactionReceipt, getBlockNumber } = await verify({});
    const result = await promise;
    expect(result).toEqual({
      contractAddress: BAG.toLowerCase(),
      txHash: TX_HASH,
      blockNumber: 123,
      onChainBagId: deriveOnChainBagId(SIGNER, OFF_CHAIN_REF).toLowerCase(),
      creatorAddress: SIGNER.toLowerCase(),
      offChainRef: OFF_CHAIN_REF,
    });
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH });
    // Depth is measured against an UNCACHED head — a cached block number would under-count confirmations.
    expect(getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });

  it('canonicalises the tx hash: an UPPERCASE hash is looked up and returned as the same lowercase value', async () => {
    const upper = `0x${'EE'.repeat(32)}` as Hex;
    const { promise, getTransaction } = await verify({}, { txHash: upper });
    const result = await promise;
    expect(result.txHash).toBe(TX_HASH);
    expect(getTransaction).toHaveBeenCalledWith({ hash: TX_HASH });
  });

  it('accepts checksummed / mixed-case addresses (case-insensitive comparison)', async () => {
    await expect((await verify({ tx: { to: FACTORY.toUpperCase().replace('0X', '0x') as Hex, from: SIGNER } })).promise).resolves.toBeDefined();
  });
});

describe('verifyBagCreation — PENDING is not failure', () => {
  it('unknown transaction hash → BagCreationPendingError', async () => {
    await expect((await verify({ tx: named('TransactionNotFoundError') })).promise).rejects.toBeInstanceOf(BagCreationPendingError);
  });
  it('no receipt within the bounded wait (not mined yet) → BagCreationPendingError', async () => {
    const short = { ...CONFIG, receiptTimeoutMs: 1 };
    const err = await (await verify({ receipt: named('TransactionReceiptNotFoundError') }, {}, short)).promise.catch((e) => e);
    expect(err).toBeInstanceOf(BagCreationPendingError);
    expect((err as Error).message).toMatch(/not yet mined/);
  });
  it('mined but below the configured depth within the bounded wait → BagCreationPendingError (never accepted early)', async () => {
    const short = { ...CONFIG, receiptTimeoutMs: 1 };
    const { promise, readContract } = await verify({ head: BigInt(123) }, {}, short); // depth 1 of 2
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(BagCreationPendingError);
    expect((err as Error).message).toMatch(/1 of 2 required confirmation/);
    expect(readContract).not.toHaveBeenCalled();
  });
  it('an RPC outage while reading the RECEIPT propagates as a plain error, not PENDING', async () => {
    const outage = new Error('503 Service Unavailable');
    const err = await (await verify({ receipt: outage })).promise.catch((e) => e);
    expect(err).toBe(outage);
  });
  it('an RPC OUTAGE is NOT swallowed as "not found": it propagates as a plain error', async () => {
    const outage = new Error('connect ECONNREFUSED');
    const err = await (await verify({ tx: outage })).promise.catch((e) => e);
    expect(err).toBe(outage);
    expect(err).not.toBeInstanceOf(BagCreationPendingError);
    expect(err).not.toBeInstanceOf(BagCreationVerificationError);
  });
});

describe('verifyBagCreation — definitive rejections (BagCreationVerificationError)', () => {
  const rejects = async (s: Scenario, re: RegExp, p: Partial<typeof PARAMS> = {}) => {
    const { promise } = await verify(s, p);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(BagCreationVerificationError);
    expect((err as Error).message).toMatch(re);
  };

  it('malformed tx hash', () => rejects({}, /not a valid transaction hash/, { txHash: '0x1234' }));
  it('wrong factory: transaction sent to a DIFFERENT contract', () => rejects({ tx: { to: OTHER_CONTRACT, from: SIGNER } }, /not the expected BagFactory/));
  it('contract-creation transaction (no `to`)', () => rejects({ tx: { to: null, from: SIGNER } }, /contract creation/));
  it('wrong sender: transaction sent from a DIFFERENT wallet than the session wallet', () => rejects({ tx: { to: FACTORY, from: OTHER_WALLET } }, /not the authenticated wallet/));
  it('wrong sender is refused even BEFORE waiting for a receipt', async () => {
    const { promise, getTransactionReceipt } = await verify({ tx: { to: FACTORY, from: OTHER_WALLET } });
    await promise.catch(() => undefined);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });
  it('reverted transaction', () => rejects({ receipt: { status: 'reverted', logs: [] } }, /reverted/));
  it('missing BagCreated event', () => rejects({ receipt: { status: 'success', logs: [] } }, /no BagCreated event/));
  it('SPOOFED BagCreated from another contract is ignored (and, alone, is "missing")', () =>
    rejects({ receipt: { status: 'success', logs: [bagCreatedLog({ address: OTHER_CONTRACT })] } }, /no BagCreated event/));
  it('a spoofed lookalike BEFORE the real event does not shadow or replace it', async () => {
    const spoof = bagCreatedLog({ address: OTHER_CONTRACT, creator: OTHER_WALLET });
    await expect((await verify({ receipt: { status: 'success', logs: [spoof, bagCreatedLog()] } })).promise).resolves.toMatchObject({ creatorAddress: SIGNER.toLowerCase() });
  });
  it('two BagCreated events from the factory are ambiguous', () =>
    rejects({ receipt: { status: 'success', logs: [bagCreatedLog(), bagCreatedLog()] } }, /ambiguous/));
  it('wrong creator in the event', () => rejects({ receipt: { status: 'success', logs: [bagCreatedLog({ creator: OTHER_WALLET })] } }, /BagCreated\.creator/));
  it('wrong offChainRef in the event', () =>
    rejects({ receipt: { status: 'success', logs: [bagCreatedLog({ offChainRef: `0x${'22'.repeat(32)}` })] } }, /offChainRef/));
  it('wrong compositionHash in the event (recipe changed since prepare)', () =>
    rejects({ receipt: { status: 'success', logs: [bagCreatedLog({ compositionHash: keccak256(toHex('other')) })] } }, /compositionHash/));
  it('wrong bagId: not keccak256(abi.encode(creator, offChainRef))', () =>
    rejects({ receipt: { status: 'success', logs: [bagCreatedLog({ bagId: keccak256(toHex('not-it')) })] } }, /BagCreated\.bagId/));
  it('wrong factory.bagOf(bagId)', () => rejects({ bagOf: OTHER_CONTRACT }, /factory\.bagOf/));
  it('wrong Bag.creator()', () => rejects({ bag: { creator: OTHER_WALLET } }, /Bag\.creator\(\)/));
  it('Bag.factory() is not the configured factory', () => rejects({ bag: { factory: OTHER_CONTRACT } }, /Bag\.factory\(\)/));
  it('Bag.offChainRef() / Bag.bagId() disagree', async () => {
    await rejects({ bag: { offChainRef: `0x${'33'.repeat(32)}` } }, /Bag\.offChainRef\(\)/);
    await rejects({ bag: { bagId: `0x${'44'.repeat(32)}` } }, /Bag\.offChainRef\(\)/);
  });
  it('on-chain mutability must match bags.mutability (an IMMUTABLE Bag deployed as mutable, or vice versa, is rejected)', async () => {
    await rejects({ bag: { isMutable: false } }, /Bag\.isMutable\(\)/);
    await rejects({ bag: { isMutable: true } }, /Bag\.isMutable\(\)/, { expectedIsMutable: false });
  });
  it('the expectation comes from the SERVER: asking to verify for another creator rejects a valid tx', () =>
    rejects({}, /not the authenticated wallet/, { expectedCreator: OTHER_WALLET }));
});
