import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { keccak256, toHex, parseEther, toFunctionSelector, zeroAddress, type Hex } from 'viem';
import { definitionFromRecipe } from '../../lib/domain/basket-protocol/bag-json';
import { computeOnChainBagId } from '../../lib/domain/basket-protocol/onchain';
import { registryStrategyId } from '../../lib/domain/basket-protocol/strategy-registry';
import {
  STRATEGY_COMPOSITIONS_ABI,
  compareComposition,
  computeOnchainCompositionHash,
  definitionToAllocations,
  readOnchainComposition,
  toContractAllocations,
} from '../../lib/domain/basket-protocol/strategy-compositions';

// -----------------------------------------------------------------------------
// CONTRACT TESTS (Hardhat in-process EVM) for StrategyCompositions: a strategy
// version's allocations, readable on-chain. Only the registered creator, only a
// registered version, once, in canonical form. The last suite checks BAG's own
// off-chain helpers against the contract (same order, same hash, same reads).
// NOT real-chain tests.
// -----------------------------------------------------------------------------

const UUID_A = '11111111-1111-4111-8111-111111111111';
const h = (seed: string): Hex => keccak256(toHex(seed));
const T1 = '0x1111111111111111111111111111111111111111' as const;
const T2 = '0x2222222222222222222222222222222222222222' as const;
const T3 = '0x3333333333333333333333333333333333333333' as const;
const RH = 4663n;

const ERRORS: Record<string, string> = {
  UnknownStrategy: 'UnknownStrategy(bytes32)',
  NotCreator: 'NotCreator(bytes32,address)',
  UnknownVersion: 'UnknownVersion(bytes32,uint32)',
  AlreadyPublished: 'AlreadyPublished(bytes32,uint32)',
  NotPublished: 'NotPublished(bytes32,uint32)',
  BadLength: 'BadLength(uint256)',
  InvalidAllocation: 'InvalidAllocation(uint256)',
  NotCanonical: 'NotCanonical(uint256)',
  WeightsNotTotal: 'WeightsNotTotal(uint256)',
  ZeroAddress: 'ZeroAddress()',
};
const rejects = (p: Promise<unknown>, name: string) =>
  assert.rejects(p, (e: Error) => e.message.includes(name) || e.message.includes(toFunctionSelector(ERRORS[name])), `expected ${name}`);

const alloc = (chainId: bigint, token: Hex, weightBps: number) => ({ chainId, token, weightBps });

async function setup() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [alice, bob] = await viem.getWalletClients();
  const registry = await viem.deployContract('StrategyRegistry', []);
  const compositions = await viem.deployContract('StrategyCompositions', [registry.address]);
  const reg = (w: typeof alice) => viem.getContractAt('StrategyRegistry', registry.address, { client: { wallet: w } });
  const comp = (w: typeof alice) => viem.getContractAt('StrategyCompositions', compositions.address, { client: { wallet: w } });
  await (await reg(alice)).write.registerStrategy([computeOnChainBagId(UUID_A), h('v1'), '']);
  await (await reg(alice)).write.publishVersion([registryStrategyId(alice.account.address, UUID_A), 2, h('v2'), '']);
  const id = registryStrategyId(alice.account.address, UUID_A);
  return { viem, publicClient, alice, bob, registry, compositions, reg, comp, id };
}

describe('StrategyCompositions — who and when', () => {
  it('the creator publishes a registered version once; it reads back exactly, with its hash and event', async () => {
    const { publicClient, alice, compositions, comp, id } = await setup();
    const a = [alloc(RH, T1, 6000), alloc(RH, T2, 4000)];
    const hash = await (await comp(alice)).write.publishComposition([id, 1, a]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await compositions.getEvents.CompositionPublished({}, { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.compositionHash, computeOnchainCompositionHash(a));
    assert.equal(await compositions.read.isPublished([id, 1]), true);
    assert.equal(await compositions.read.isPublished([id, 2]), false);
    assert.equal(await compositions.read.compositionHashOf([id, 1]), computeOnchainCompositionHash(a));
    const back = await compositions.read.compositionOf([id, 1]);
    assert.deepEqual(back.map((x) => [x.chainId, x.token.toLowerCase(), x.weightBps]), a.map((x) => [x.chainId, x.token, x.weightBps]));
    await rejects((await comp(alice)).write.publishComposition([id, 1, a]), 'AlreadyPublished');
  });

  it('nobody but the creator can publish; an unknown strategy, version 0 or an unregistered version is refused', async () => {
    const { alice, bob, comp, id } = await setup();
    const a = [alloc(RH, T1, 10000)];
    await rejects((await comp(bob)).write.publishComposition([id, 1, a]), 'NotCreator');
    await rejects((await comp(alice)).write.publishComposition([h('nope'), 1, a]), 'UnknownStrategy');
    await rejects((await comp(alice)).write.publishComposition([id, 0, a]), 'UnknownVersion');
    await rejects((await comp(alice)).write.publishComposition([id, 3, a]), 'UnknownVersion');
  });

  it('reading an unpublished version reverts rather than returning an empty list', async () => {
    const { compositions, id } = await setup();
    await rejects(compositions.read.compositionOf([id, 1]), 'NotPublished');
    await rejects(compositions.read.compositionHashOf([id, 1]), 'NotPublished');
  });
});

describe('StrategyCompositions — canonical form', () => {
  it('refuses empty or too long lists, zero chain/token/weight, wrong totals, duplicates and unsorted entries', async () => {
    const { alice, comp, id } = await setup();
    const c = await comp(alice);
    await rejects(c.write.publishComposition([id, 1, []]), 'BadLength');
    const tooMany = Array.from({ length: 65 }, (_, i) => alloc(RH, `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex, i === 0 ? 10000 - 64 : 1));
    await rejects(c.write.publishComposition([id, 1, tooMany]), 'BadLength');
    await rejects(c.write.publishComposition([id, 1, [alloc(0n, T1, 10000)]]), 'InvalidAllocation');
    await rejects(c.write.publishComposition([id, 1, [alloc(RH, zeroAddress, 10000)]]), 'InvalidAllocation');
    await rejects(c.write.publishComposition([id, 1, [alloc(RH, T1, 0), alloc(RH, T2, 10000)]]), 'InvalidAllocation');
    await rejects(c.write.publishComposition([id, 1, [alloc(RH, T1, 6000), alloc(RH, T2, 3999)]]), 'WeightsNotTotal');
    await rejects(c.write.publishComposition([id, 1, [alloc(RH, T1, 5000), alloc(RH, T1, 5000)]]), 'NotCanonical');
    await rejects(c.write.publishComposition([id, 1, [alloc(RH, T2, 5000), alloc(RH, T1, 5000)]]), 'NotCanonical');
    await rejects(c.write.publishComposition([id, 1, [alloc(RH, T1, 5000), alloc(1n, T2, 5000)]]), 'NotCanonical');
  });

  it('accepts exactly 64 allocations, and several chains in ascending order', async () => {
    const { alice, comp, compositions, id } = await setup();
    const c = await comp(alice);
    await c.write.publishComposition([id, 1, [alloc(1n, T3, 2000), alloc(RH, T1, 3000), alloc(RH, T2, 5000)]]);
    const max = Array.from({ length: 64 }, (_, i) => alloc(RH, `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex, i === 0 ? 10000 - 63 : 1));
    await c.write.publishComposition([id, 2, max]);
    assert.equal((await compositions.read.compositionOf([id, 2])).length, 64);
  });
});

describe('StrategyCompositions — no economic surface', () => {
  it('no owner, admin, fee or payable function; ETH is refused; the registry is fixed at deployment', async () => {
    const { viem, compositions, registry, alice } = await setup();
    const fns = compositions.abi.filter((e) => e.type === 'function') as { name: string; stateMutability: string }[];
    for (const forbidden of ['owner', 'transferOwnership', 'pause', 'upgradeTo', 'setFee', 'withdraw', 'setRegistry']) assert.ok(!fns.some((f) => f.name === forbidden), forbidden);
    assert.ok(!fns.some((f) => f.stateMutability === 'payable'));
    await assert.rejects(alice.sendTransaction({ to: compositions.address, value: parseEther('0.01') }));
    assert.equal((await compositions.read.registry()).toLowerCase(), registry.address.toLowerCase());
    await rejects(viem.deployContract('StrategyCompositions', [zeroAddress]), 'ZeroAddress');
  });

  it('the ABI BAG uses matches the compiled contract', async () => {
    const { compositions } = await setup();
    for (const entry of STRATEGY_COMPOSITIONS_ABI) {
      const compiled = compositions.abi.find((e) => e.type === entry.type && (e as { name?: string }).name === entry.name) as unknown as typeof entry;
      assert.ok(compiled, entry.name);
      const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'internalType' ? undefined : v)));
      assert.deepEqual(strip(compiled.inputs), strip(entry.inputs), entry.name);
      if (entry.type === 'function') assert.deepEqual(strip((compiled as { outputs: unknown }).outputs), strip(entry.outputs), entry.name);
    }
  });
});

describe('StrategyCompositions — BAG off-chain helpers against the contract', () => {
  const recipe = {
    chain: 'robinhood' as const,
    strategyType: 'STATIC_BASKET' as const,
    mutability: 'MUTABLE' as const,
    assets: [
      { symbol: 'TSLA', name: 'Tesla', chain: 'robinhood' as const, address: '0xBB11111111111111111111111111111111111111', decimals: 18, weightBps: 6000 },
      { symbol: 'AAPL', name: 'Apple', chain: 'robinhood' as const, address: '0x22222222222222222222222222222222222222AA', decimals: 18, weightBps: 4000 },
    ],
    minWeightBps: 100,
    maxWeightBps: 8000,
    maxAssets: 10,
    minInvestment: 100,
  };
  const chainIdOf = (c: string) => (c === 'robinhood' ? 4663 : null);

  it('a bag.json definition converts to the contract order, publishes, hashes the same and reads back equal', async () => {
    const { publicClient, alice, comp, compositions, id } = await setup();
    const converted = definitionToAllocations(definitionFromRecipe(recipe as never), chainIdOf);
    assert.ok(converted.ok);
    await (await comp(alice)).write.publishComposition([id, 1, toContractAllocations(converted.allocations)]);
    assert.equal(await compositions.read.compositionHashOf([id, 1]), computeOnchainCompositionHash(converted.allocations));
    const onchain = await readOnchainComposition(publicClient as never, compositions.address, id, 1);
    assert.ok(onchain);
    assert.deepEqual(compareComposition(converted.allocations, onchain), { matches: true, detail: '2 allocations match' });
    assert.equal(await readOnchainComposition(publicClient as never, compositions.address, id, 2), null);
  });

  it('a different definition does not match what is on-chain', async () => {
    const { publicClient, alice, comp, compositions, id } = await setup();
    const a = definitionToAllocations(definitionFromRecipe(recipe as never), chainIdOf);
    assert.ok(a.ok);
    await (await comp(alice)).write.publishComposition([id, 1, toContractAllocations(a.allocations)]);
    const changed = definitionToAllocations(definitionFromRecipe({ ...recipe, assets: [{ ...recipe.assets[0], weightBps: 5000 }, { ...recipe.assets[1], weightBps: 5000 }] } as never), chainIdOf);
    assert.ok(changed.ok);
    const onchain = await readOnchainComposition(publicClient as never, compositions.address, id, 1);
    assert.equal(compareComposition(changed.allocations, onchain!).matches, false);
  });
});

describe('StrategyCompositions — deployment checks (scripts/deploy-strategy-compositions.ts)', () => {
  it('a correct deployment passes every check; a wrong registry, a non-registry or no code is reported', async () => {
    const { viem, publicClient, registry, compositions } = await setup();
    const { verifyCompositionsDeployment, isStrategyRegistry } = await import('../../lib/blockchain/strategy-compositions-deploy');
    const chainId = await publicClient.getChainId();
    const failed = async (address: Hex, expected: { chainId: number; registry: Hex }) =>
      (await verifyCompositionsDeployment(publicClient as never, address, expected)).filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(await failed(compositions.address, { chainId, registry: registry.address }), []);
    assert.deepEqual(await failed(compositions.address, { chainId, registry: T1 }), ['registry']);
    assert.deepEqual(await failed(T2, { chainId, registry: registry.address }), ['contract code']);
    const notRegistry = await viem.deployContract('HookERC20', []);
    assert.equal(await isStrategyRegistry(publicClient as never, notRegistry.address), false);
    assert.equal(await isStrategyRegistry(publicClient as never, registry.address), true);
    const pointsElsewhere = await viem.deployContract('StrategyCompositions', [notRegistry.address]);
    assert.deepEqual(await failed(pointsElsewhere.address, { chainId, registry: notRegistry.address }), ['registry is a StrategyRegistry']);
  });
});
