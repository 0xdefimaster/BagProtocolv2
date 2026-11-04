import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import type { Hex } from 'viem';
import { loadRuntimeArtifact } from '../../lib/blockchain/chain-readiness-artifacts';
import { checkChainReadiness, runtimeMatchesArtifact, summarizeGates, type ReadinessClient } from '../../lib/blockchain/chain-readiness';

// -----------------------------------------------------------------------------
// The readiness check's bytecode comparison against REAL Hardhat 3 artifacts
// (this repository's compiler output, loaded by the same loader the script
// uses) and REAL deployed runtime code on the in-process EVM — including the
// two contracts with constructor-set immutables: BagFactory (creationFeeCap,
// 3 slots) and StrategyCompositions (registry, 2 slots). Mocked references
// elsewhere prove the masking logic; this proves the loader and the compiler's
// immutableReferences line up with what actually gets deployed.
// In-process EVM only: not a live chain.
// -----------------------------------------------------------------------------

async function deployAll() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner] = await viem.getWalletClients();
  const registry = await viem.deployContract('StrategyRegistry', []);
  const factory = await viem.deployContract('BagFactory', [owner.account.address, owner.account.address, 0n, 10n ** 16n]);
  const compositions = await viem.deployContract('StrategyCompositions', [registry.address]);
  const code = async (address: Hex) => (await publicClient.getCode({ address })) as Hex;
  return { publicClient, registry, factory, compositions, code };
}

const immutableSlots = (name: string) => Object.values(loadRuntimeArtifact(name)!.immutableReferences ?? {}).reduce((n, r) => n + r.length, 0);

describe('chain readiness — real artifacts and deployed code', () => {
  it('the loader reads hh3 artifacts with the compiler-declared immutable references', () => {
    assert.equal(immutableSlots('StrategyRegistry'), 0);
    assert.equal(immutableSlots('BagFactory'), 3);
    assert.equal(immutableSlots('StrategyCompositions'), 2);
    assert.equal(loadRuntimeArtifact('DoesNotExist'), undefined);
  });

  it('deployed runtime matches its own artifact; with immutables it matches only after masking them', async () => {
    const { registry, factory, compositions, code } = await deployAll();
    const reg = runtimeMatchesArtifact(await code(registry.address), loadRuntimeArtifact('StrategyRegistry')!);
    assert.deepEqual([reg.exact, reg.masked], [true, true]);
    for (const [c, name] of [[factory, 'BagFactory'], [compositions, 'StrategyCompositions']] as const) {
      const r = runtimeMatchesArtifact(await code(c.address), loadRuntimeArtifact(name)!);
      assert.equal(r.exact, false, `${name}: constructor-set immutables differ from the artifact's zero placeholders`);
      assert.equal(r.masked, true, `${name}: equal once the declared immutable slots are masked`);
    }
  });

  it('masking does not hide code: a changed opcode byte, or another contract, does not match', async () => {
    const { factory, registry, code } = await deployAll();
    const art = loadRuntimeArtifact('BagFactory')!;
    const live = await code(factory.address);
    const masked = new Set(Object.values(art.immutableReferences ?? {}).flat().flatMap((r) => Array.from({ length: r.length }, (_, i) => r.start + i)));
    let at = 10;
    while (masked.has(at)) at++;
    const byte = parseInt(live.slice(2 + at * 2, 4 + at * 2), 16);
    const tampered = `${live.slice(0, 2 + at * 2)}${((byte + 1) & 0xff).toString(16).padStart(2, '0')}${live.slice(4 + at * 2)}` as Hex;
    assert.equal(runtimeMatchesArtifact(tampered, art).masked, false);
    assert.equal(runtimeMatchesArtifact(await code(registry.address), art).masked, false);
  });

  it('end to end: B_CORE and B_APP pass against deployed code, and compositions is bound to this registry', async () => {
    const { publicClient, registry, factory, compositions } = await deployAll();
    // The in-process chain id is 31337; present it as Base so the per-chain variables are read. Tokens are absent
    // here (gate A fails) — this test is about gate B.
    const client = {
      getChainId: async () => 8453,
      getCode: (a: { address: Hex }) => publicClient.getCode(a),
      readContract: (a: Parameters<ReadinessClient['readContract']>[0]) => publicClient.readContract(a as never),
      request: async () => {
        throw new Error('unsupported');
      },
    } as ReadinessClient;
    const checks = await checkChainReadiness({
      chain: 'base',
      client,
      env: { STRATEGY_REGISTRY_ADDRESS_BASE: registry.address, FACTORY_ADDRESS_BASE: factory.address, STRATEGY_COMPOSITIONS_ADDRESS_BASE: compositions.address },
      artifacts: { StrategyRegistry: loadRuntimeArtifact('StrategyRegistry'), BagFactory: loadRuntimeArtifact('BagFactory'), StrategyCompositions: loadRuntimeArtifact('StrategyCompositions') },
    });
    const b = checks.filter((c) => c.gate === 'B_CORE' || c.gate === 'B_APP');
    assert.deepEqual(
      b.map((c) => [c.name, c.status]),
      [
        ['STRATEGYREGISTRY_DEPLOYED', 'PASS'],
        ['STRATEGYREGISTRY_BYTECODE', 'PASS'],
        ['BAGFACTORY_DEPLOYED', 'PASS'],
        ['BAGFACTORY_BYTECODE', 'PASS'],
        ['STRATEGYCOMPOSITIONS_DEPLOYED', 'PASS'],
        ['STRATEGYCOMPOSITIONS_BYTECODE', 'PASS'],
        ['STRATEGYCOMPOSITIONS_REGISTRY', 'PASS'],
      ]
    );
    const s = summarizeGates(checks);
    assert.deepEqual([s.gates.B_CORE, s.gates.B_APP], ['PASS', 'PASS']);
    assert.equal(s.gates.A, 'FAIL'); // no WETH/USDC on the in-process chain
  });
});
