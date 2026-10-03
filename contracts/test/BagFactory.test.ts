import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { encodeAbiParameters, keccak256, toHex, zeroAddress, zeroHash } from 'viem';

// -----------------------------------------------------------------------------
// CONTRACT TESTS (Hardhat in-process EVM). USER-SIGNED model: `createBag` is
// permissionless and binds the Bag to `msg.sender`; bagId is
// keccak256(abi.encode(creator, offChainRef)). These verify the BagFactory /
// Bag contracts themselves — they do NOT exercise the server's verification
// (see lib/blockchain/evm/__tests__/), and they are NOT real-chain tests.
// -----------------------------------------------------------------------------

const FEE_CAP = 10_000_000_000_000_000n; // 0.01 ETH

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [creator, other, third] = await viem.getWalletClients();
  // Fee-free factory for the identity/versioning tests; fee behavior has its own suite below.
  const factory = await viem.deployContract('BagFactory', [creator.account.address, third.account.address, 0n, FEE_CAP]);
  const as = (wallet: typeof creator) => viem.getContractAt('BagFactory', factory.address, { client: { wallet } });
  return { viem, factory, publicClient, creator, other, third, as };
}

function offChainRefFromUuid(uuid: string): `0x${string}` {
  return `0x${uuid.replace(/-/g, '').padStart(64, '0')}`;
}

function expectedBagId(creator: string, offChainRef: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator as `0x${string}`, offChainRef]));
}

const hashOf = (seed: string): `0x${string}` => keccak256(toHex(seed));

describe('BagFactory (user-signed)', () => {
  it('has no deployer role — the owner only manages the creation fee and treasury', async () => {
    const { factory } = await setup();
    const fns = factory.abi.filter((e) => e.type === 'function').map((e) => (e as { name: string }).name);
    for (const forbidden of ['deployer', 'setDeployer', 'createBagFor']) assert.ok(!fns.includes(forbidden), `unexpected ${forbidden}()`);
  });

  it('deriveBagId matches the off-chain derivation keccak256(abi.encode(creator, offChainRef))', async () => {
    const { factory, creator } = await setup();
    const ref = offChainRefFromUuid('11111111-1111-1111-1111-111111111111');
    assert.equal(await factory.read.deriveBagId([creator.account.address, ref]), expectedBagId(creator.account.address, ref));
  });

  it('createBag: the CALLER becomes the creator; Bag is registered under the creator-bound bagId', async () => {
    const { viem, factory, as, creator } = await setup();
    const ref = offChainRefFromUuid('11111111-1111-1111-1111-111111111111');
    const hash = hashOf('BTC:6000|ETH:4000');

    await (await as(creator)).write.createBag([ref, hash, 'bag:test-1', true]);

    const bagId = expectedBagId(creator.account.address, ref);
    const bagAddress = (await factory.read.bagOf([bagId])) as `0x${string}`;
    assert.notEqual(bagAddress, zeroAddress);

    const bag = await viem.getContractAt('Bag', bagAddress);
    assert.equal(((await bag.read.creator()) as string).toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(await bag.read.bagId(), bagId);
    assert.equal(await bag.read.offChainRef(), ref);
    assert.equal(await bag.read.compositionHash(), hash);
    assert.equal(await bag.read.version(), 1n);
    assert.equal(((await bag.read.factory()) as string).toLowerCase(), factory.address.toLowerCase());
  });

  it('emits BagCreated(bagId, creator, offChainRef, bag, compositionHash, version)', async () => {
    const { factory, as, creator, publicClient } = await setup();
    const ref = offChainRefFromUuid('55555555-5555-5555-5555-555555555555');
    const hash = hashOf('BTC:10000');

    const txHash = await (await as(creator)).write.createBag([ref, hash, 'bag:event', true]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: 'BagCreated',
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });

    assert.equal(events.length, 1);
    const args = events[0].args;
    assert.equal(args.bagId, expectedBagId(creator.account.address, ref));
    assert.equal((args.creator as string).toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(args.offChainRef, ref);
    assert.equal(args.compositionHash, hash);
    assert.equal(args.version, 1n);
    assert.equal(((await factory.read.bagOf([args.bagId as `0x${string}`])) as string).toLowerCase(), (args.bag as string).toLowerCase());
  });

  it('the same wallet cannot deploy the same offChainRef twice — reverts AlreadyDeployed', async () => {
    const { as, creator } = await setup();
    const ref = offChainRefFromUuid('44444444-4444-4444-4444-444444444444');
    const f = await as(creator);
    await f.write.createBag([ref, hashOf('BTC:10000'), 'bag:dup', true]);
    await assert.rejects(f.write.createBag([ref, hashOf('BTC:10000'), 'bag:dup-2', true]), /AlreadyDeployed/);
  });

  it('ANTI-SQUATTING: another wallet deploying the SAME offChainRef gets a DIFFERENT bagId and cannot block the real creator', async () => {
    const { factory, as, creator, other } = await setup();
    const ref = offChainRefFromUuid('66666666-6666-6666-6666-666666666666');

    // An attacker who knows the victim's off-chain UUID deploys first…
    await (await as(other)).write.createBag([ref, hashOf('junk'), 'bag:squat', true]);
    // …the real creator's deployment still succeeds, under their own bagId.
    await (await as(creator)).write.createBag([ref, hashOf('BTC:10000'), 'bag:real', true]);

    const attackerId = expectedBagId(other.account.address, ref);
    const creatorId = expectedBagId(creator.account.address, ref);
    assert.notEqual(attackerId, creatorId);
    assert.notEqual(await factory.read.bagOf([attackerId]), zeroAddress);
    assert.notEqual(await factory.read.bagOf([creatorId]), zeroAddress);
    assert.notEqual(await factory.read.bagOf([attackerId]), await factory.read.bagOf([creatorId]));
  });

  it('a Bag cannot be created on behalf of another address — there is no creator parameter', async () => {
    const { factory } = await setup();
    const create = factory.abi.find((e) => e.type === 'function' && e.name === 'createBag') as { inputs: { name: string }[] };
    assert.deepEqual(create.inputs.map((i) => i.name), ['offChainRef', 'compositionHash', 'metadataURI', 'isMutable']);
    const record = factory.abi.find((e) => e.type === 'function' && e.name === 'recordBagVersion') as { inputs: { name: string }[] };
    assert.deepEqual(record.inputs.map((i) => i.name), ['offChainRef', 'expectedCurrentVersion', 'compositionHash', 'metadataURI']); // no creator / bag address parameter either
  });

  it('rejects a zero offChainRef', async () => {
    const { as, creator } = await setup();
    await assert.rejects((await as(creator)).write.createBag([zeroHash, hashOf('x'), 'bag:zero', true]), /ZeroOffChainRef/);
    await assert.rejects((await as(creator)).write.createBag([hashOf('ref-zero-composition'), zeroHash, 'bag:zero', true]), /ZeroCompositionHash/);
  });

  it('tracks bagsByCreator / bagCountOf per wallet', async () => {
    const { factory, as, creator, other } = await setup();
    await (await as(creator)).write.createBag([offChainRefFromUuid('22222222-2222-2222-2222-222222222222'), hashOf('a'), 'bag:a', true]);
    await (await as(creator)).write.createBag([offChainRefFromUuid('33333333-3333-3333-3333-333333333333'), hashOf('a'), 'bag:b', true]);
    assert.equal(await factory.read.bagCountOf([creator.account.address]), 2n);
    assert.equal(await factory.read.bagCountOf([other.account.address]), 0n);
  });

  it('same composition hash is stored verbatim across two different bags', async () => {
    const { viem, factory, as, creator } = await setup();
    const hash = hashOf('BTC:6000|ETH:4000');
    const refA = offChainRefFromUuid('22222222-2222-2222-2222-222222222222');
    const refB = offChainRefFromUuid('33333333-3333-3333-3333-333333333333');
    await (await as(creator)).write.createBag([refA, hash, 'bag:a', true]);
    await (await as(creator)).write.createBag([refB, hash, 'bag:b', true]);
    const bagA = await viem.getContractAt('Bag', (await factory.read.bagOf([expectedBagId(creator.account.address, refA)])) as `0x${string}`);
    const bagB = await viem.getContractAt('Bag', (await factory.read.bagOf([expectedBagId(creator.account.address, refB)])) as `0x${string}`);
    assert.equal(await bagA.read.compositionHash(), await bagB.read.compositionHash());
  });
});

// -----------------------------------------------------------------------------
// Mutable versioning — BagFactory.recordBagVersion → Bag.recordVersion.
// -----------------------------------------------------------------------------
describe('BagFactory.recordBagVersion (creator-bound, CAS-guarded, immutable-aware)', () => {
  const REF = offChainRefFromUuid('44444444-4444-4444-4444-444444444444');

  async function deployed(isMutable = true) {
    const s = await setup();
    await (await s.as(s.creator)).write.createBag([REF, hashOf('v1'), 'bag:x:v1', isMutable]);
    const bagId = expectedBagId(s.creator.account.address, REF);
    const bagAddress = (await s.factory.read.bagOf([bagId])) as `0x${string}`;
    const bag = await s.viem.getContractAt('Bag', bagAddress);
    return { ...s, bagId, bagAddress, bag };
  }

  it('creator update: version 1 → 2, compositionHash and metadataURI updated, isMutable recorded', async () => {
    const { as, creator, bag } = await deployed();
    assert.equal(await bag.read.isMutable(), true);
    await (await as(creator)).write.recordBagVersion([REF, 1n, hashOf('v2'), 'bag:x:v2']);
    assert.equal(await bag.read.version(), 2n);
    assert.equal(await bag.read.compositionHash(), hashOf('v2'));
    assert.equal(await bag.read.metadataURI(), 'bag:x:v2');
  });

  it('emits exactly one BagVersionRecorded (factory) and one CompositionUpdated (bag), with matching fields', async () => {
    const { viem, as, creator, factory, bag, bagId, bagAddress, publicClient } = await deployed();
    const hash = await (await as(creator)).write.recordBagVersion([REF, 1n, hashOf('v2'), 'bag:x:v2']);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const { decodeEventLog } = await import('viem');
    const fromFactory = receipt.logs.filter((l) => l.address.toLowerCase() === factory.address.toLowerCase()).map((l) => decodeEventLog({ abi: factory.abi, data: l.data, topics: l.topics }));
    const fromBag = receipt.logs.filter((l) => l.address.toLowerCase() === bagAddress.toLowerCase()).map((l) => decodeEventLog({ abi: bag.abi, data: l.data, topics: l.topics }));
    assert.equal(fromFactory.length, 1);
    assert.equal(fromBag.length, 1);
    assert.equal(fromFactory[0].eventName, 'BagVersionRecorded');
    const a = fromFactory[0].args as { bagId: string; creator: string; bag: string; version: bigint; compositionHash: string; metadataURI: string };
    assert.equal(a.bagId, bagId);
    assert.equal(a.creator.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(a.bag.toLowerCase(), bagAddress.toLowerCase());
    assert.equal(a.version, 2n);
    assert.equal(a.compositionHash, hashOf('v2'));
    assert.equal(a.metadataURI, 'bag:x:v2');
    assert.equal(fromBag[0].eventName, 'CompositionUpdated');
    void viem;
  });

  it('NON-CREATOR cannot update: the same offChainRef derives a different (unregistered) bagId → UnknownBag', async () => {
    const { as, other, bag } = await deployed();
    await assert.rejects((await as(other)).write.recordBagVersion([REF, 1n, hashOf('evil'), 'bag:evil']), /UnknownBag/);
    assert.equal(await bag.read.version(), 1n);
  });

  it('nobody can call Bag.recordVersion directly (not even the creator) — only the factory', async () => {
    const { viem, creator, bagAddress } = await deployed();
    const direct = await viem.getContractAt('Bag', bagAddress, { client: { wallet: creator } });
    await assert.rejects(direct.write.recordVersion([hashOf('direct'), 'bag:direct']), /NotFactory/);
  });

  it('IMMUTABLE bag: recordBagVersion reverts ImmutableBag and nothing changes', async () => {
    const { as, creator, bag } = await deployed(false);
    assert.equal(await bag.read.isMutable(), false);
    await assert.rejects((await as(creator)).write.recordBagVersion([REF, 1n, hashOf('v2'), 'bag:x:v2']), /ImmutableBag/);
    assert.equal(await bag.read.version(), 1n);
    assert.equal(await bag.read.compositionHash(), hashOf('v1'));
  });

  it('STALE expected version is rejected (compare-and-swap): two updates built on v1 cannot both land', async () => {
    const { as, creator, bag } = await deployed();
    const f = await as(creator);
    await f.write.recordBagVersion([REF, 1n, hashOf('a'), 'bag:x:a']);
    await assert.rejects(f.write.recordBagVersion([REF, 1n, hashOf('b'), 'bag:x:b']), /StaleVersion/);
    assert.equal(await bag.read.compositionHash(), hashOf('a'));
    await f.write.recordBagVersion([REF, 2n, hashOf('b'), 'bag:x:b']);
    assert.equal(await bag.read.version(), 3n);
  });

  it('unknown offChainRef and zero composition hash are rejected', async () => {
    const { as, creator } = await deployed();
    await assert.rejects((await as(creator)).write.recordBagVersion([offChainRefFromUuid('55555555-5555-5555-5555-555555555555'), 1n, hashOf('x'), 'u']), /UnknownBag/);
    await assert.rejects((await as(creator)).write.recordBagVersion([REF, 1n, zeroHash, 'u']), /ZeroCompositionHash/);
  });
});

// -----------------------------------------------------------------------------
// Protocol creation fee — native ETH, exact amount, forwarded to the treasury.
// -----------------------------------------------------------------------------
describe('BagFactory creation fee (native ETH)', () => {
  const FEE = 150_000_000_000_000n; // 0.00015 ETH

  async function feeSetup(fee = FEE) {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    const [owner, creator, treasury, stranger] = await viem.getWalletClients();
    const factory = await viem.deployContract('BagFactory', [owner.account.address, treasury.account.address, fee, FEE_CAP]);
    const as = (wallet: typeof owner) => viem.getContractAt('BagFactory', factory.address, { client: { wallet } });
    return { viem, publicClient, owner, creator, treasury, stranger, factory, as };
  }

  const REF = offChainRefFromUuid('55555555-5555-5555-5555-555555555555');

  it('one transaction: the exact fee is forwarded to the treasury, nothing stays in the factory, CreationFeePaid is emitted', async () => {
    const { creator, treasury, factory, as, publicClient } = await feeSetup();
    const before = await publicClient.getBalance({ address: treasury.account.address });
    const hash = await (await as(creator)).write.createBag([REF, hashOf('a'), 'bag:fee', true], { value: FEE });

    assert.equal((await publicClient.getBalance({ address: treasury.account.address })) - before, FEE);
    assert.equal(await publicClient.getBalance({ address: factory.address }), 0n);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const { decodeEventLog } = await import('viem');
    const events = receipt.logs
      .filter((l) => l.address.toLowerCase() === factory.address.toLowerCase())
      .map((l) => decodeEventLog({ abi: factory.abi, data: l.data, topics: l.topics }));
    const paid = events.find((e) => e.eventName === 'CreationFeePaid');
    assert.ok(paid, 'CreationFeePaid emitted');
    const args = paid!.args as { bagId: string; payer: string; amount: bigint; treasury: string };
    assert.equal(args.bagId, expectedBagId(creator.account.address, REF));
    assert.equal(args.payer.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(args.amount, FEE);
    assert.equal(args.treasury.toLowerCase(), treasury.account.address.toLowerCase());
    assert.equal(events.filter((e) => e.eventName === 'BagCreated').length, 1);
  });

  it('rejects a missing, short or excess fee (exact match only) — no Bag is created', async () => {
    const { creator, factory, as } = await feeSetup();
    const f = await as(creator);
    await assert.rejects(f.write.createBag([REF, hashOf('a'), 'bag:fee', true]), /WrongCreationFee/);
    await assert.rejects(f.write.createBag([REF, hashOf('a'), 'bag:fee', true], { value: FEE - 1n }), /WrongCreationFee/);
    await assert.rejects(f.write.createBag([REF, hashOf('a'), 'bag:fee', true], { value: FEE + 1n }), /WrongCreationFee/);
    assert.equal(await factory.read.bagOf([expectedBagId(creator.account.address, REF)]), zeroAddress);
  });

  it('a fee changed in flight reverts the transaction instead of charging a different amount', async () => {
    const { owner, creator, as } = await feeSetup();
    await (await as(owner)).write.setCreationFee([FEE * 2n]);
    await assert.rejects((await as(creator)).write.createBag([REF, hashOf('a'), 'bag:fee', true], { value: FEE }), /WrongCreationFee/);
  });

  it('a zero fee needs no value, and sending value then is refused', async () => {
    const { creator, factory, as } = await feeSetup(0n);
    await assert.rejects((await as(creator)).write.createBag([REF, hashOf('a'), 'bag:free', true], { value: 1n }), /WrongCreationFee/);
    await (await as(creator)).write.createBag([REF, hashOf('a'), 'bag:free', true]);
    assert.notEqual(await factory.read.bagOf([expectedBagId(creator.account.address, REF)]), zeroAddress);
  });

  it('a treasury that cannot accept ETH makes creation revert', async () => {
    const { viem, owner, creator, as } = await feeSetup();
    const sink = await viem.deployContract('RejectsEther', []);
    await (await as(owner)).write.setTreasury([sink.address]);
    await assert.rejects((await as(creator)).write.createBag([REF, hashOf('a'), 'bag:fee', true], { value: FEE }), /FeeTransferFailed/);
  });

  it('recordBagVersion is not payable', async () => {
    const { factory } = await feeSetup();
    const record = factory.abi.find((e) => e.type === 'function' && e.name === 'recordBagVersion') as { stateMutability: string };
    assert.equal(record.stateMutability, 'nonpayable');
  });

  it('only the owner can change the fee or treasury, and the fee can never exceed the immutable cap', async () => {
    const { owner, stranger, factory, as } = await feeSetup();
    await assert.rejects((await as(stranger)).write.setCreationFee([1n]), /NotOwner/);
    await assert.rejects((await as(stranger)).write.setTreasury([stranger.account.address]), /NotOwner/);
    await assert.rejects((await as(owner)).write.setCreationFee([FEE_CAP + 1n]), /FeeAboveCap/);
    await assert.rejects((await as(owner)).write.setTreasury([zeroAddress]), /ZeroAddress/);
    await (await as(owner)).write.setCreationFee([FEE_CAP]);
    assert.equal(await factory.read.creationFee(), FEE_CAP);
  });

  it('constructor rejects a fee above the cap and zero addresses', async () => {
    const { viem, owner, treasury } = await feeSetup();
    await assert.rejects(viem.deployContract('BagFactory', [owner.account.address, treasury.account.address, FEE_CAP + 1n, FEE_CAP]), /FeeAboveCap/);
    await assert.rejects(viem.deployContract('BagFactory', [zeroAddress, treasury.account.address, 0n, FEE_CAP]), /ZeroAddress/);
    await assert.rejects(viem.deployContract('BagFactory', [owner.account.address, zeroAddress, 0n, FEE_CAP]), /ZeroAddress/);
  });

  it('ownership handover is two-step', async () => {
    const { owner, stranger, factory, as } = await feeSetup();
    await (await as(owner)).write.transferOwnership([stranger.account.address]);
    assert.equal((await factory.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    await assert.rejects((await as(owner)).write.acceptOwnership(), /NotOwner/);
    await (await as(stranger)).write.acceptOwnership();
    assert.equal((await factory.read.owner()).toLowerCase(), stranger.account.address.toLowerCase());
    await assert.rejects((await as(owner)).write.setCreationFee([1n]), /NotOwner/);
  });
});
