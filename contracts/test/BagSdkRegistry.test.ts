import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { network } from 'hardhat';
import {
  hashBag,
  offChainRefOf,
  parseBag,
  registryStrategyId,
  STRATEGY_REGISTRY_DEPLOYMENTS,
  validateBag,
  verifyRegistryCommitment,
  type BagDocument,
  type ContractReader,
} from '../../packages/bag-sdk/src/index';

// -----------------------------------------------------------------------------
// The standalone SDK (packages/bag-sdk) against the REAL StrategyRegistry on
// Hardhat's in-process EVM. Nothing from the BAG app is imported: a creator
// registers the hash the SDK computes from a hand-written bag.json, and a
// third party verifies it with only the file, the expected creator, the
// registry address and an RPC client. NOT a real-chain test.
//
// The SDK verifies only on the strategy's own chain and at its known registry
// (STRATEGY_REGISTRY_DEPLOYMENTS), so the local EVM runs as Robinhood Chain and
// the deployed registry's runtime code is placed at the known Robinhood address
// (StrategyRegistry has no constructor arguments or immutables).
// -----------------------------------------------------------------------------

const KNOWN = STRATEGY_REGISTRY_DEPLOYMENTS.robinhood!;

const UUID = '55555555-5555-4555-8555-555555555555';
const FORK_UUID = '66666666-6666-4666-8666-666666666666';
const fileText = readFileSync(new URL('../../packages/bag-sdk/test/fixtures/external.bag.json', import.meta.url), 'utf8');

function served(uuid: string, version: number, mutate: (d: any) => void = () => {}): BagDocument {
  const raw = JSON.parse(fileText);
  mutate(raw);
  raw.ref = { strategyId: uuid, version, parentVersion: version === 1 ? null : version - 1, createdAt: '2026-10-06T00:00:00Z' };
  const r = parseBag(raw);
  assert.ok(r.ok, JSON.stringify(r.issues));
  return r.bag;
}

async function setup() {
  const { viem } = await network.connect({ override: { chainId: KNOWN.chainId } });
  const publicClient = await viem.getPublicClient();
  const client = publicClient as unknown as ContractReader;
  const [alice, bob] = await viem.getWalletClients();
  const deployed = await viem.deployContract('StrategyRegistry', []);
  const runtime = await publicClient.getCode({ address: deployed.address });
  assert.ok(runtime && runtime !== '0x');
  await (await viem.getTestClient()).setCode({ address: KNOWN.address, bytecode: runtime });
  const registry = await viem.getContractAt('StrategyRegistry', KNOWN.address);
  const as = (wallet: typeof alice) => viem.getContractAt('StrategyRegistry', registry.address, { client: { wallet } });
  return { registry, otherAddress: deployed.address, client, alice, bob, as };
}

describe('bag-sdk ↔ StrategyRegistry (in-process EVM)', () => {
  it('SDK strategy id equals the contract derivation', async () => {
    const { registry, alice } = await setup();
    assert.equal(await registry.read.deriveStrategyId([alice.account.address, offChainRefOf(UUID)]), registryStrategyId(alice.account.address, UUID));
  });

  it('a creator registers the SDK hash; a third party verifies v1 and v2 with the expected creator only', async () => {
    const { registry, client, alice, as } = await setup();
    const v1 = served(UUID, 1);
    const v2 = served(UUID, 2, (d) => (d.definition.rules.performanceFeeBps = 500));
    assert.ok(validateBag(v1).valid && validateBag(v2).valid);

    const r = await as(alice);
    await r.write.registerStrategy([offChainRefOf(UUID), hashBag(v1), '']);
    await r.write.publishVersions([registryStrategyId(alice.account.address, UUID), 2, [hashBag(v2)]]);

    for (const bag of [v1, v2]) {
      const v = await verifyRegistryCommitment({ bag, expectedCreator: alice.account.address, registry: registry.address, client });
      assert.equal(v.verified, true, JSON.stringify(v.checks));
    }
  });

  it('not verified: wrong expected creator, tampered definition, unregistered version, unknown registry address', async () => {
    const { registry, otherAddress, client, alice, bob, as } = await setup();
    const v1 = served(UUID, 1);
    await (await as(alice)).write.registerStrategy([offChainRefOf(UUID), hashBag(v1), '']);

    const wrongCreator = await verifyRegistryCommitment({ bag: v1, expectedCreator: bob.account.address, registry: registry.address, client });
    assert.equal(wrongCreator.verified, false);

    const tampered = served(UUID, 1, (d) => {
      d.definition.assets[0].weightBps = 5000;
      d.definition.assets[1].weightBps = 5000;
    });
    tampered.definitionHash = hashBag(v1); // the stated hash is never trusted
    assert.equal((await verifyRegistryCommitment({ bag: tampered, expectedCreator: alice.account.address, registry: registry.address, client })).verified, false);

    assert.equal((await verifyRegistryCommitment({ bag: served(UUID, 2), expectedCreator: alice.account.address, registry: registry.address, client })).verified, false);

    // The same registry code at any other address on this chain is refused before its records are read.
    const elsewhere = await verifyRegistryCommitment({ bag: v1, expectedCreator: alice.account.address, registry: otherAddress, client });
    assert.equal(elsewhere.verified, false);
    assert.equal(elsewhere.checks.find((c) => c.name === 'REGISTRY_ADDRESS_MATCHES_KNOWN_DEPLOYMENT')?.ok, false);
  });

  it('a fork verifies under its own creator and reports the exact parent version from the chain', async () => {
    const { registry, client, alice, bob, as } = await setup();
    const parent = served(UUID, 1);
    await (await as(alice)).write.registerStrategy([offChainRefOf(UUID), hashBag(parent), '']);
    const parentId = registryStrategyId(alice.account.address, UUID);

    const fork = served(FORK_UUID, 1, (d) => (d.forkedFrom = { strategyId: UUID, version: 1 }));
    await (await as(bob)).write.registerFork([offChainRefOf(FORK_UUID), parentId, 1, hashBag(fork), '']);

    const v = await verifyRegistryCommitment({ bag: fork, expectedCreator: bob.account.address, registry: registry.address, client });
    assert.equal(v.verified, true);
    assert.deepEqual(v.fork, { parentStrategyId: parentId, parentVersion: 1 });
    // The fork changed nothing: same content identity, different strategy identity.
    assert.equal(hashBag(fork), hashBag(parent));
    assert.notEqual(v.registryStrategyId, parentId);
  });
});
