import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { computeDefinitionHash, definitionFromRecipe } from '../bag-json';
import { readRegistryRecord, registryStrategyId, verifyBagJsonCommitment } from '../strategy-registry';

const UUID = '11111111-1111-4111-8111-111111111111';
const CREATOR = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const REGISTRY = '0x0000000000000000000000000000000000000001';
const definition = definitionFromRecipe({
  chain: 'robinhood',
  strategyType: 'STATIC_BASKET',
  assets: [
    { symbol: 'TSLA', name: 'Tesla', chain: 'robinhood', address: '0x11111111111111111111111111111111111111aa', decimals: 18, weightBps: 6000 },
    { symbol: 'AAPL', name: 'Apple', chain: 'robinhood', address: '0x22222222222222222222222222222222222222bb', decimals: 18, weightBps: 4000 },
  ],
} as never);
const hash = computeDefinitionHash(definition) as `0x${string}`;
const bagJson = { definition, definitionHash: hash, ref: { strategyId: UUID, version: 2, parentVersion: 1, createdAt: '' } };
const id = registryStrategyId(CREATOR, UUID);
const record = (o: Partial<Parameters<typeof verifyBagJsonCommitment>[1]> = {}) => ({ registryStrategyId: id, creator: CREATOR, version: 2, definitionHash: hash, fork: null, ...o });
const failed = (r: ReturnType<typeof verifyBagJsonCommitment>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('registryStrategyId', () => {
  it('is keccak256(abi.encode(creator, uuid as bytes32)) — the same id BagFactory.deriveBagId gives', () => {
    const ref = `0x${UUID.replace(/-/g, '').padStart(64, '0')}` as `0x${string}`;
    expect(id).toBe(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [CREATOR, ref])));
    expect(registryStrategyId(OTHER, UUID)).not.toBe(id);
  });
});

describe('verifyBagJsonCommitment', () => {
  it('verifies when every check holds', () => {
    expect(verifyBagJsonCommitment(bagJson, record())).toMatchObject({ verified: true, recomputedDefinitionHash: hash });
  });

  it('never trusts the stated hash: a changed definition fails even with the original hash attached', () => {
    const tampered = { ...bagJson, definition: { ...definition, assets: definition.assets.map((a) => ({ ...a, weightBps: 5000 })) } };
    expect(failed(verifyBagJsonCommitment(tampered, record()))).toEqual(['DEFINITION_HASH_RECOMPUTED', 'DEFINITION_MATCHES_REGISTRY']);
  });

  it("another creator's entry, an unregistered version, or a different commitment do not verify", () => {
    expect(failed(verifyBagJsonCommitment(bagJson, record({ creator: OTHER })))).toEqual(['STRATEGY_ID_BOUND_TO_CREATOR']);
    expect(failed(verifyBagJsonCommitment(bagJson, record({ definitionHash: null })))).toEqual(['VERSION_REGISTERED', 'DEFINITION_MATCHES_REGISTRY']);
    expect(failed(verifyBagJsonCommitment(bagJson, record({ definitionHash: `0x${'ab'.repeat(32)}` })))).toEqual(['DEFINITION_MATCHES_REGISTRY']);
    expect(failed(verifyBagJsonCommitment(bagJson, record({ version: 3 })))).toContain('VERSION_REGISTERED');
  });
});

describe('readRegistryRecord', () => {
  const ZERO32 = `0x${'0'.repeat(64)}`;
  const client = (s: { creator: string; latestVersion: number; forkOfStrategyId: string; forkOfVersion: number }) => ({
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) =>
      functionName === 'strategyOf' ? s : functionName === 'definitionHashOf' ? (args[1] === 2 ? hash : ZERO32) : null,
  });

  it('reads the committed hash and the fork origin', async () => {
    const r = await readRegistryRecord(client({ creator: CREATOR, latestVersion: 2, forkOfStrategyId: `0x${'cd'.repeat(32)}`, forkOfVersion: 3 }), REGISTRY, id, 2);
    expect(r).toMatchObject({ definitionHash: hash, fork: { parentStrategyId: `0x${'cd'.repeat(32)}`, parentVersion: 3 } });
  });

  it('an unregistered strategy, or a version beyond the latest, is null — never a guess', async () => {
    const none = await readRegistryRecord(client({ creator: `0x${'0'.repeat(40)}`, latestVersion: 0, forkOfStrategyId: ZERO32, forkOfVersion: 0 }), REGISTRY, id, 1);
    expect(none).toMatchObject({ definitionHash: null, fork: null });
    const beyond = await readRegistryRecord(client({ creator: CREATOR, latestVersion: 1, forkOfStrategyId: ZERO32, forkOfVersion: 0 }), REGISTRY, id, 2);
    expect(beyond.definitionHash).toBeNull();
  });
});
