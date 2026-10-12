import { describe, expect, it, vi } from 'vitest';

// The builder is pure; these modules are only needed by the loader.
vi.mock('@/lib/server/purchase-execution', () => ({
  bagSlippageBps: (v: { recipe: { rebalanceRule?: { maxSlippageBps?: number } } }) => Math.min(300, Math.max(10, v.recipe.rebalanceRule?.maxSlippageBps ?? 100)),
}));
vi.mock('@/lib/server/price-provider', () => ({ getDisplayPriceProvider: () => ({}) }));

import { buildStrategyPassport, StrategyPassportInput } from '../strategy-passport';
import { deriveStrategyPolicy } from '../strategy-policy';
import { BagRecord, BagVersionRecord, BasketRecipe, CanonicalAsset } from '@/types/basket-protocol';
import type { CreatorProfile } from '@/types';
import type { BagDeployment } from '../bag-deployment-repo';

const NVDA = '0x00000000000000000000000000000000000000a1';
const AMD = '0x00000000000000000000000000000000000000a2';

function bag(over: Partial<BagRecord> = {}): BagRecord {
  return {
    id: 'bag-2', slug: 'ai-infra', name: 'AI Infrastructure', symbol: 'AINF', description: 'AI supply chain', creatorId: 'alice',
    chain: 'robinhood', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE', status: 'ACTIVE', currentVersion: 2, currentVersionId: 'v2',
    parentBagId: null, rootBagId: null, registryId: null, contractAddress: null, performanceFeeLockedAt: null, performanceFeeBpsLocked: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z', ...over,
  } as BagRecord;
}

const recipe = {
  assets: [
    { chain: 'robinhood', address: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 6000 },
    { chain: 'robinhood', address: AMD, symbol: 'AMD', decimals: 18, weightBps: 4000 },
  ],
  maxWeightBps: 7000, minWeightBps: 500, maxAssets: 10, minInvestment: 1, performanceFeeBps: 1000, unroutablePolicy: 'HOLD_INPUT',
  rebalanceRule: { frequency: 'MONTHLY', driftThresholdBps: 500, maxSlippageBps: 150 },
} as unknown as BasketRecipe;

const currentVersion: BagVersionRecord = { id: 'v2', bagId: 'bag-2', version: 2, compositionHash: 'h2', recipe, createdBy: 'alice', reason: 'Lower NVDA', createdAt: '2026-09-08T00:00:00Z' };
const HASH = '0x' + 'ab'.repeat(32);
const versions = [
  { id: 'v2', version: 2, created_at: '2026-09-08T00:00:00Z', reason: 'Lower NVDA', composition_hash: 'h2', onchain_tx_hash: '0x' + '11'.repeat(32), onchain_version: 2, onchain_composition_hash: HASH, metadata_uri: null },
  { id: 'v1', version: 1, created_at: '2026-09-01T00:00:00Z', reason: 'Initial creation', composition_hash: 'h1', onchain_tx_hash: null, onchain_version: null, onchain_composition_hash: null, metadata_uri: null },
];

const deployment: BagDeployment = {
  id: 'd', bagId: 'bag-2', chain: 'robinhood', status: 'DEPLOYED', factoryAddress: '0xfactory', contractAddress: '0xcontract',
  txHash: '0x' + '22'.repeat(32), blockNumber: 123, errorMessage: null, onChainBagId: ('0x' + '33'.repeat(32)) as `0x${string}`,
  onChainCreator: '0xalice' as `0x${string}`, onChainVersion: 2, createdAt: '', updatedAt: '',
};

const profile = (id: string, name: string): CreatorProfile => ({ id, name, avatar: '', address: `0x${id}`, followers: 0, forks: 0 });
const creators = new Map([['alice', profile('alice', 'Alice')], ['bob', profile('bob', 'Bob')], ['carol', profile('carol', 'Carol')]]);

function input(over: Partial<StrategyPassportInput> = {}): StrategyPassportInput {
  return {
    bag: bag(), currentVersion, versions, deployment, creators,
    assetsByKey: new Map([[`robinhood:${NVDA}`, { name: 'NVIDIA', assetType: 'stock', routeStatus: 'ROUTABLE', routeCheckedAt: '2026-10-01T00:00:00Z' } as CanonicalAsset]]),
    nav: { tvlUsd: '1234.5', navPerShare: '1.05', asOf: '2026-10-02T00:00:00Z' },
    returns: null, holders: 3, ancestors: [], missingAncestorIds: [], children: [], childCount: 0, viewerUserId: null,
    now: new Date('2026-10-03T00:00:00Z'), ...over,
  };
}

describe('buildStrategyPassport', () => {
  it('puts identity, on-chain record, creator, current version, composition and performance in one response, each with its source', () => {
    const p = buildStrategyPassport(input());
    expect(p.schemaVersion).toBe(1);
    expect(p.identity).toMatchObject({ bagId: 'bag-2', name: 'AI Infrastructure', status: 'ACTIVE' });
    expect(p.identity.sourceInfo).toEqual({ source: 'DATABASE', asOf: '2026-09-08T00:00:00Z', verifiableBy: 'NONE', readFromChainThisRequest: false });
    expect(p.onchain).toMatchObject({ chainId: 4663, contractAddress: '0xcontract', onChainVersion: 2, deploymentBlock: 123 });
    // An on-chain record is verifiable by tx hash, but this response did NOT re-read the chain.
    expect(p.onchain!.sourceInfo).toMatchObject({ source: 'ONCHAIN', verifiableBy: 'TX_HASH', readFromChainThisRequest: false });
    expect(p.onchain!.explorerUrl).toContain('/tx/0x2222');
    expect(p.creator).toMatchObject({ name: 'Alice', walletAddress: '0xalice' });
    expect(p.currentVersion).toMatchObject({ version: 2, reason: 'Lower NVDA', onchainCompositionHash: HASH });
    expect(p.composition.totalWeightBps).toBe(10000);
    expect(p.composition.assets[0]).toMatchObject({ symbol: 'NVDA', name: 'NVIDIA', assetType: 'stock', routeStatus: 'ROUTABLE' });
    expect(p.composition.assets[1]).toMatchObject({ symbol: 'AMD', name: null, routeStatus: null });
    expect(p.performance).toMatchObject({ tvlUsd: '1234.5', navPerShare: '1.05', holders: 3 });
    expect(p.performance.sourceInfo.source).toBe('BAG_DERIVED');
  });

  it('exposes no internal identifiers (user ids, row ids, internal fingerprints)', () => {
    const json = JSON.stringify(buildStrategyPassport(input({ bag: bag({ parentBagId: 'bag-1' }), ancestors: [bag({ id: 'bag-1', creatorId: 'bob' })] })));
    expect(json).not.toMatch(/"userId"|"versionId"|"creatorId"|"createdBy"/);
    expect(json).not.toContain('"alice"'); // creator user id
    expect(json).not.toContain('"bob"');
    expect(json).not.toContain('"h2"'); // BAG's internal composition fingerprint
    expect(json).not.toContain('"v2"'); // version row id
  });

  it('keeps a stable top-level shape (schema stability)', () => {
    const p = buildStrategyPassport(input());
    expect(Object.keys(p).sort()).toEqual(['composition', 'creator', 'currentVersion', 'generatedAt', 'identity', 'lineage', 'onchain', 'performance', 'policy', 'schemaVersion']);
    expect(Object.keys(p.lineage).sort()).toEqual(['forks', 'versions']);
    expect(Object.keys(p.lineage.forks).sort()).toEqual(['ancestors', 'childCount', 'children', 'forkRoyaltyFeeShareBps', 'forkedFromVersion', 'isOriginal', 'rootBagId', 'sourceInfo']);
  });

  it('uses the canonical StrategyPolicy, derived exactly as validate_bag derives it', () => {
    const p = buildStrategyPassport(input());
    expect(p.policy).toEqual(deriveStrategyPolicy(recipe, { mutability: 'MUTABLE', deployed: true, performanceFeeBpsLocked: null }));
    expect(p.policy!.maxSlippageBps).toMatchObject({ value: 150, enforcement: 'ONCHAIN_ENFORCED', source: 'CREATOR_RECIPE' });
    expect(p.policy!.compositionChanges).toMatchObject({ value: 'ONCHAIN_VERSION_ONLY', enforcement: 'DATABASE_TRIGGER' });
    expect(buildStrategyPassport(input({ currentVersion: null })).policy).toBeNull();
  });

  it('a locked fee and an undeployed Bag are reflected in the policy and on-chain section', () => {
    const locked = buildStrategyPassport(input({ bag: bag({ performanceFeeBpsLocked: 500, performanceFeeLockedAt: '2026-09-10T00:00:00Z' }) }));
    expect(locked.policy!.performanceFeeBps).toMatchObject({ value: 500, status: 'LOCKED', enforcement: 'DATABASE_TRIGGER' });
    const draft = buildStrategyPassport(input({ deployment: null }));
    expect(draft.onchain).toBeNull();
    expect(draft.policy!.compositionChanges.value).toBe('CREATOR_EDITABLE');
  });

  it('keeps version lineage (same Bag over time) separate from fork lineage (other Bags)', () => {
    const parent = bag({ id: 'bag-1', name: 'AI Core', creatorId: 'bob', status: 'ACTIVE' });
    const p = buildStrategyPassport(input({ bag: bag({ parentBagId: 'bag-1', rootBagId: 'bag-0' }), ancestors: [parent], missingAncestorIds: ['bag-0'] }));

    expect(p.lineage.versions.nodes.map((n) => [n.version, n.parentVersion, n.isCurrent])).toEqual([
      [1, null, false],
      [2, 1, true],
    ]);
    expect(p.lineage.versions.nodes[0].onchain).toBeNull();
    expect(p.lineage.versions.nodes[1].onchain).toMatchObject({ onchainVersion: 2, compositionHash: HASH, sourceInfo: { source: 'ONCHAIN', readFromChainThisRequest: false } });

    expect(p.lineage.forks.isOriginal).toBe(false);
    expect(p.lineage.forks.rootBagId).toBe('bag-0');
    expect(p.lineage.forks.ancestors).toEqual([
      expect.objectContaining({ bagId: 'bag-1', visible: true, name: 'AI Core', creator: expect.objectContaining({ name: 'Bob' }) }),
      expect.objectContaining({ bagId: 'bag-0', visible: false, name: null }),
    ]);
    expect(p.lineage.forks.forkRoyaltyFeeShareBps).toBe(2000);
    expect(p.lineage.forks.forkedFromVersion).toBeNull();
  });

  it('never discloses a non-public fork to someone other than its creator', () => {
    const publicFork = bag({ id: 'f1', name: 'Public fork', creatorId: 'bob', parentBagId: 'bag-2' });
    const draftFork = bag({ id: 'f2', name: 'Secret draft', creatorId: 'carol', status: 'DRAFT', parentBagId: 'bag-2' });
    const privateParent = bag({ id: 'bag-1', name: 'Hidden parent', creatorId: 'carol', status: 'ARCHIVED' });

    const anon = buildStrategyPassport(input({ bag: bag({ parentBagId: 'bag-1' }), ancestors: [privateParent], children: [publicFork, draftFork], childCount: 2 }));
    expect(anon.lineage.forks.children.map((c) => c.name)).toEqual(['Public fork']);
    expect(anon.lineage.forks.childCount).toBe(2);
    expect(anon.lineage.forks.ancestors[0]).toEqual({ bagId: 'bag-1', visible: false, name: null, symbol: null, status: null, creator: null, createdAt: null });
    expect(JSON.stringify(anon)).not.toContain('Secret draft');
    expect(JSON.stringify(anon)).not.toContain('Hidden parent');

    const carol = buildStrategyPassport(input({ bag: bag({ parentBagId: 'bag-1' }), ancestors: [privateParent], children: [publicFork, draftFork], childCount: 2, viewerUserId: 'carol' }));
    expect(carol.lineage.forks.children.map((c) => c.name)).toEqual(['Public fork', 'Secret draft']);
    expect(carol.lineage.forks.ancestors[0]).toMatchObject({ visible: true, name: 'Hidden parent' });
  });
});
