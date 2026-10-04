import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { keccak256, toHex, zeroHash, parseEther } from 'viem';
import { definitionFromRecipe, computeDefinitionHash } from '../../lib/domain/basket-protocol/bag-json';
import { STRATEGY_REGISTRY_READ_ABI, readRegistryRecord, registryStrategyId, verifyBagJsonCommitment } from '../../lib/domain/basket-protocol/strategy-registry';
import { computeOnChainBagId } from '../../lib/domain/basket-protocol/onchain';

// -----------------------------------------------------------------------------
// CONTRACT TESTS (Hardhat in-process EVM) for StrategyRegistry: identity and
// commitment only, no economic state. Version lineage (1, 2, 3 inside one
// strategy) and fork lineage (a new strategy pointing at an exact parent
// version) are tested as separate things. The last suite is the third-party
// check: given only strategyId, version, creator and bag.json, read the
// registry and confirm the commitment. NOT real-chain tests.
// -----------------------------------------------------------------------------

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const h = (seed: string): `0x${string}` => keccak256(toHex(seed));

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [alice, bob, carol] = await viem.getWalletClients();
  const registry = await viem.deployContract('StrategyRegistry', []);
  const as = (wallet: typeof alice) => viem.getContractAt('StrategyRegistry', registry.address, { client: { wallet } });
  return { viem, registry, publicClient, alice, bob, carol, as };
}

async function rejects(p: Promise<unknown>, error: string) {
  await assert.rejects(p, (e: Error) => e.message.includes(error), `expected ${error}`);
}

describe('StrategyRegistry — identity', () => {
  it('strategyId = keccak256(abi.encode(creator, offChainRef)): same as BagFactory.deriveBagId and the TS helper', async () => {
    const { viem, registry, alice } = await setup();
    const factory = await viem.deployContract('BagFactory', [alice.account.address, alice.account.address, 0n, 10n ** 16n]);
    const ref = computeOnChainBagId(UUID_A);
    const fromRegistry = await registry.read.deriveStrategyId([alice.account.address, ref]);
    assert.equal(fromRegistry, await factory.read.deriveBagId([alice.account.address, ref]));
    assert.equal(fromRegistry, registryStrategyId(alice.account.address, UUID_A));
  });

  it('the caller becomes the creator; another creator registering the same ref gets a different id (no squatting)', async () => {
    const { registry, as, alice, bob } = await setup();
    const ref = computeOnChainBagId(UUID_A);
    await (await as(bob)).write.registerStrategy([ref, h('bob-v1'), '']);
    await (await as(alice)).write.registerStrategy([ref, h('alice-v1'), '']);
    const aliceId = registryStrategyId(alice.account.address, UUID_A);
    const bobId = registryStrategyId(bob.account.address, UUID_A);
    assert.notEqual(aliceId, bobId);
    assert.equal((await registry.read.strategyOf([aliceId])).creator.toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(await registry.read.definitionHashOf([aliceId, 1]), h('alice-v1'));
  });

  it('cannot register twice, with a zero ref or a zero hash', async () => {
    const { as, alice } = await setup();
    const r = await as(alice);
    const ref = computeOnChainBagId(UUID_A);
    await r.write.registerStrategy([ref, h('v1'), '']);
    await rejects(r.write.registerStrategy([ref, h('v1-again'), '']), 'AlreadyRegistered');
    await rejects(r.write.registerStrategy([zeroHash, h('v1'), '']), 'ZeroOffChainRef');
    await rejects(r.write.registerStrategy([computeOnChainBagId(UUID_B), zeroHash, '']), 'ZeroDefinitionHash');
  });
});

describe('StrategyRegistry — version lineage (inside one strategy)', () => {
  it('versions are 1, 2, 3 with no gaps; only the creator publishes; history is immutable', async () => {
    const { registry, as, alice, bob } = await setup();
    const id = registryStrategyId(alice.account.address, UUID_A);
    const r = await as(alice);
    await r.write.registerStrategy([computeOnChainBagId(UUID_A), h('v1'), 'ipfs://v1']);
    await r.write.publishVersion([id, 2, h('v2'), '']);
    await rejects(r.write.publishVersion([id, 4, h('v4'), '']), 'UnexpectedVersion');
    await rejects(r.write.publishVersion([id, 2, h('v2-rewrite'), '']), 'UnexpectedVersion');
    await rejects((await as(bob)).write.publishVersion([id, 3, h('v3'), '']), 'NotCreator');
    await r.write.publishVersion([id, 3, h('v3'), '']);

    assert.equal((await registry.read.strategyOf([id])).latestVersion, 3);
    assert.deepEqual(await Promise.all([1, 2, 3].map((v) => registry.read.definitionHashOf([id, v]))), [h('v1'), h('v2'), h('v3')]);
    await rejects(registry.read.definitionHashOf([id, 4]), 'UnknownVersion');
    await rejects(registry.read.definitionHashOf([id, 0]), 'UnknownVersion');
  });

  it('history recorded before the registry existed can be published in one batch, still contiguous', async () => {
    const { registry, as, alice } = await setup();
    const id = registryStrategyId(alice.account.address, UUID_A);
    const r = await as(alice);
    await r.write.registerStrategy([computeOnChainBagId(UUID_A), h('v1'), '']);
    await r.write.publishVersions([id, 2, [h('v2'), h('v3'), h('v4')]]);
    assert.equal((await registry.read.strategyOf([id])).latestVersion, 4);
    await rejects(r.write.publishVersions([id, 6, [h('v6')]]), 'UnexpectedVersion');
    await rejects(r.write.publishVersions([id, 5, []]), 'EmptyBatch');
  });

  it('publishing to an unknown strategy reverts', async () => {
    const { as, alice } = await setup();
    await rejects((await as(alice)).write.publishVersion([h('nope'), 1, h('v1'), '']), 'UnknownStrategy');
  });
});

describe('StrategyRegistry — fork lineage (between strategies)', () => {
  it('a fork is a NEW strategy with its own creator and its own version 1, pointing at an exact parent version', async () => {
    const { registry, as, alice, bob, carol } = await setup();
    const a = registryStrategyId(alice.account.address, UUID_A);
    const ra = await as(alice);
    await ra.write.registerStrategy([computeOnChainBagId(UUID_A), h('A-v1'), '']);
    await ra.write.publishVersions([a, 2, [h('A-v2'), h('A-v3')]]);

    // BAG A v3 ├── fork → BAG B v1   └── fork → BAG C v1
    await (await as(bob)).write.registerFork([computeOnChainBagId(UUID_B), a, 3, h('B-v1'), '']);
    await (await as(carol)).write.registerFork([computeOnChainBagId(UUID_C), a, 3, h('C-v1'), '']);
    const b = registryStrategyId(bob.account.address, UUID_B);
    const c = registryStrategyId(carol.account.address, UUID_C);

    for (const [id, creator] of [[b, bob], [c, carol]] as const) {
      const s = await registry.read.strategyOf([id]);
      assert.equal(s.creator.toLowerCase(), creator.account.address.toLowerCase());
      assert.equal(s.latestVersion, 1);
      assert.equal(s.forkOfStrategyId, a);
      assert.equal(s.forkOfVersion, 3);
    }
    // The fork's own version lineage starts at 1 and continues independently of the parent.
    await (await as(bob)).write.publishVersion([b, 2, h('B-v2'), '']);
    assert.equal((await registry.read.strategyOf([b])).latestVersion, 2);
    // The parent is untouched: still v3, not a fork, and the fork's creator cannot publish to it.
    const parent = await registry.read.strategyOf([a]);
    assert.equal(parent.latestVersion, 3);
    assert.equal(parent.forkOfStrategyId, zeroHash);
    await rejects((await as(bob)).write.publishVersion([a, 4, h('A-v4'), '']), 'NotCreator');
  });

  it('a fork must name a registered parent version', async () => {
    const { as, alice, bob } = await setup();
    const a = registryStrategyId(alice.account.address, UUID_A);
    await (await as(alice)).write.registerStrategy([computeOnChainBagId(UUID_A), h('A-v1'), '']);
    await rejects((await as(bob)).write.registerFork([computeOnChainBagId(UUID_B), a, 2, h('B-v1'), '']), 'UnknownVersion');
    await rejects((await as(bob)).write.registerFork([computeOnChainBagId(UUID_B), h('nope'), 1, h('B-v1'), '']), 'UnknownVersion');
  });
});

describe('StrategyRegistry — no economic surface', () => {
  it('no owner, no admin, no payable function; ETH cannot be sent to it', async () => {
    const { registry, alice } = await setup();
    const fns = registry.abi.filter((e) => e.type === 'function') as { name: string; stateMutability: string }[];
    for (const forbidden of ['owner', 'transferOwnership', 'pause', 'upgradeTo', 'setFee', 'withdraw']) assert.ok(!fns.some((f) => f.name === forbidden), forbidden);
    assert.ok(!fns.some((f) => f.stateMutability === 'payable'));
    assert.ok(!registry.abi.some((e) => e.type === 'receive' || e.type === 'fallback'));
    await assert.rejects(alice.sendTransaction({ to: registry.address, value: parseEther('0.01') }));
  });

  it('the read ABI used by off-chain verifiers matches the compiled contract', async () => {
    const { registry } = await setup();
    for (const entry of STRATEGY_REGISTRY_READ_ABI) {
      const compiled = registry.abi.find((e) => e.type === 'function' && (e as { name: string }).name === entry.name) as unknown as typeof entry;
      assert.ok(compiled, entry.name);
      assert.deepEqual(JSON.parse(JSON.stringify(compiled.inputs)).map((i: { type: string }) => i.type), entry.inputs.map((i) => i.type));
      assert.deepEqual(JSON.parse(JSON.stringify(compiled.outputs)).map((o: { type: string }) => o.type), entry.outputs.map((o) => o.type));
      assert.equal(compiled.stateMutability, entry.stateMutability);
    }
  });
});

describe('StrategyRegistry — third-party verification of a real bag.json', () => {
  // The bag.json is built by BAG's own code; the verifier only gets (strategyId, version, creator, bag.json) and an RPC.
  const recipe = {
    chain: 'robinhood' as const,
    strategyType: 'STATIC_BASKET' as const,
    mutability: 'MUTABLE' as const,
    assets: [
      { symbol: 'TSLA', name: 'Tesla', chain: 'robinhood' as const, address: '0x11111111111111111111111111111111111111AA', decimals: 18, weightBps: 6000 },
      { symbol: 'AAPL', name: 'Apple', chain: 'robinhood' as const, address: '0x22222222222222222222222222222222222222BB', decimals: 18, weightBps: 4000 },
    ],
    minWeightBps: 100,
    maxWeightBps: 8000,
    maxAssets: 10,
    minInvestment: 100,
  };
  const bagJsonFor = (version: number, r: typeof recipe = recipe) => {
    const definition = definitionFromRecipe(r as never);
    return { definition, definitionHash: computeDefinitionHash(definition), ref: { strategyId: UUID_A, version, parentVersion: version > 1 ? version - 1 : null, createdAt: '2026-10-04T00:00:00Z' } };
  };

  async function registered() {
    const ctx = await setup();
    await (await ctx.as(ctx.alice)).write.registerStrategy([computeOnChainBagId(UUID_A), bagJsonFor(1).definitionHash as `0x${string}`, '']);
    const id = registryStrategyId(ctx.alice.account.address, UUID_A);
    return { ...ctx, id };
  }

  it('the registered bag.json verifies: hash recomputed, id bound to the creator, version registered, commitment matches', async () => {
    const { publicClient, registry, alice, id } = await registered();
    const bagJson = bagJsonFor(1);
    const record = await readRegistryRecord(publicClient as never, registry.address, registryStrategyId(alice.account.address, bagJson.ref.strategyId), 1);
    const v = verifyBagJsonCommitment(bagJson, record);
    assert.equal(record.registryStrategyId, id);
    assert.deepEqual(v.checks.map((c) => [c.name, c.ok]), [
      ['DEFINITION_HASH_RECOMPUTED', true],
      ['STRATEGY_ID_BOUND_TO_CREATOR', true],
      ['VERSION_REGISTERED', true],
      ['DEFINITION_MATCHES_REGISTRY', true],
    ]);
    assert.equal(v.verified, true);
    assert.equal(await registry.read.matches([id, 1, bagJson.definitionHash as `0x${string}`]), true);
  });

  it('a tampered definition fails, even if its stated hash is copied from the original', async () => {
    const { publicClient, registry, id, alice } = await registered();
    const original = bagJsonFor(1);
    const tampered = { ...original, definition: bagJsonFor(1, { ...recipe, assets: [{ ...recipe.assets[0], weightBps: 7000 }, { ...recipe.assets[1], weightBps: 3000 }] }).definition };
    const v = verifyBagJsonCommitment(tampered, await readRegistryRecord(publicClient as never, registry.address, id, 1));
    assert.equal(v.verified, false);
    assert.equal(v.checks.find((c) => c.name === 'DEFINITION_HASH_RECOMPUTED')!.ok, false);
    assert.equal(v.checks.find((c) => c.name === 'DEFINITION_MATCHES_REGISTRY')!.ok, false);
    void alice;
  });

  it("another creator's entry, or an unregistered version, does not verify", async () => {
    const { publicClient, registry, id, bob } = await registered();
    const bagJson = bagJsonFor(1);
    const wrongCreator = await readRegistryRecord(publicClient as never, registry.address, id, 1);
    const asBob = verifyBagJsonCommitment(bagJson, { ...wrongCreator, creator: bob.account.address });
    assert.equal(asBob.checks.find((c) => c.name === 'STRATEGY_ID_BOUND_TO_CREATOR')!.ok, false);

    const v2 = verifyBagJsonCommitment(bagJsonFor(2), await readRegistryRecord(publicClient as never, registry.address, id, 2));
    assert.equal(v2.checks.find((c) => c.name === 'VERSION_REGISTERED')!.ok, false);
    assert.equal(v2.verified, false);
  });
});
