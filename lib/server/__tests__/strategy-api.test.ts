import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import bagSchema from '@/docs/schemas/bag.v1.schema.json';
import strategySchema from '@/docs/schemas/strategy.v1.schema.json';

vi.mock('@/lib/server/purchase-execution', () => ({
  bagSlippageBps: (v: { recipe: { rebalanceRule?: { maxSlippageBps?: number } } }) => Math.min(300, Math.max(10, v.recipe.rebalanceRule?.maxSlippageBps ?? 100)),
}));
vi.mock('@/lib/server/price-provider', () => ({ getDisplayPriceProvider: () => ({}) }));

import { buildStrategyPassport } from '../strategy-passport';
import {
  buildBagJson,
  buildStrategyObject,
  buildStrategyVersions,
  isStrategyId,
  parseDefinition,
  StrategyVersionRow,
  validateDefinition,
} from '../strategy-api';
import { ValidateBagInputError } from '../validate-bag';
import { computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { BAG_JSON_FORMAT_VERSION, STRATEGY_API_SCHEMA_VERSION } from '@/types/strategy';
import { BagRecord, BasketRecipe, CanonicalAsset } from '@/types/basket-protocol';

const ID = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const NVDA = '0x00000000000000000000000000000000000000A1';
const AMD = '0x00000000000000000000000000000000000000a2';

function bag(over: Partial<BagRecord> = {}): BagRecord {
  return {
    id: ID, slug: 'ai', name: 'AI Infra (renamed)', symbol: 'AINF2', description: 'current text', creatorId: 'alice-internal-user-id',
    chain: 'robinhood', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE', status: 'ACTIVE', currentVersion: 2, currentVersionId: 'row-v2',
    parentBagId: null, rootBagId: null, registryId: null, contractAddress: null, performanceFeeLockedAt: null, performanceFeeBpsLocked: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z', ...over,
  } as BagRecord;
}
const recipe = (over: Partial<BasketRecipe> = {}) =>
  ({
    chain: 'robinhood', strategyType: 'STATIC_BASKET', mutability: 'MUTABLE', name: 'AI Infra', symbol: 'AINF', description: 'text at v2',
    assets: [
      { chain: 'robinhood', address: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 6000 },
      { chain: 'robinhood', address: AMD, symbol: 'AMD', decimals: 18, weightBps: 4000 },
    ],
    maxWeightBps: 7000, minWeightBps: 500, maxAssets: 10, minInvestment: 1, performanceFeeBps: 1000, unroutablePolicy: 'HOLD_INPUT',
    rebalanceRule: { frequency: 'MONTHLY', driftThresholdBps: 500, maxSlippageBps: 150 },
    ...over,
  }) as unknown as BasketRecipe;

const v2Recipe = recipe();
const rows: StrategyVersionRow[] = [
  { id: 'row-v1', version: 1, created_at: '2026-09-01T00:00:00Z', reason: 'Initial', recipe: recipe({ assets: [{ chain: 'robinhood', address: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 10000 }], performanceFeeBps: undefined }), onchain_tx_hash: null, onchain_composition_hash: null },
  { id: 'row-v2', version: 2, created_at: '2026-09-08T00:00:00Z', reason: 'Add AMD', recipe: v2Recipe, onchain_tx_hash: '0x' + '11'.repeat(32), onchain_composition_hash: computeOnChainCompositionHash(v2Recipe.assets) },
];

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(bagSchema, 'bag.v1.json');
ajv.addSchema(strategySchema);
const validBagJson = ajv.compile({ $ref: 'bag.v1.json' });
const validStrategy = ajv.getSchema('https://bagprotocol.com/schemas/strategy.v1.json#/definitions/strategy')!;
const validVersions = ajv.getSchema('https://bagprotocol.com/schemas/strategy.v1.json#/definitions/versions')!;
const validValidation = ajv.getSchema('https://bagprotocol.com/schemas/strategy.v1.json#/definitions/validation')!;

const NOT_REGISTERED = {
  status: 'NOT_REGISTERED', chainId: null, registryAddress: null, registryStrategyId: null, creator: null, txHash: null, blockNumber: null,
  forkOf: null, recordedFrom: null, verifiedBy: null, readFromChainThisRequest: false,
};

describe('bag.json for a stored version', () => {
  it('carries the version-time definition and metadata, identity, chainId from config and the on-chain commitment', () => {
    const doc = buildBagJson(bag(), rows[1]);
    expect(doc.bagJson).toBe(BAG_JSON_FORMAT_VERSION);
    expect(doc.ref).toEqual({ strategyId: ID, version: 2, parentVersion: 1, createdAt: '2026-09-08T00:00:00Z' });
    expect(doc.network.chainId).toBe(4663);
    // Version-time display values, not the Bag's current (renamed) ones.
    expect(doc.metadata).toEqual({
      name: 'AI Infra', symbol: 'AINF', description: 'text at v2',
      assets: [{ chain: 'robinhood', address: NVDA.toLowerCase(), symbol: 'NVDA' }, { chain: 'robinhood', address: AMD, symbol: 'AMD' }],
    });
    expect(doc.commitments).toEqual({
      onchainCompositionHash: rows[1].onchain_composition_hash,
      onchainTxHash: rows[1].onchain_tx_hash,
      onchainComposition: { status: 'MATCHES_RECORDED', recordedFrom: 'VERIFIED_TX_RECEIPT', comparedBy: 'BAG', readFromChainThisRequest: false },
      registry: NOT_REGISTERED,
    });
    expect(doc.definition.assets.map((a) => a.address)).toEqual([NVDA.toLowerCase(), AMD].sort());
    expect(doc.forkedFrom).toBeNull();
    expect(validBagJson(doc)).toBe(true);
  });

  it('reports a mismatching on-chain commitment as false and an absent one as null', () => {
    const tampered = { ...rows[1], onchain_composition_hash: '0x' + 'ee'.repeat(32) };
    expect(buildBagJson(bag(), tampered).commitments.onchainComposition).toEqual({ status: 'MISMATCH', recordedFrom: 'VERIFIED_TX_RECEIPT', comparedBy: 'BAG', readFromChainThisRequest: false });
    expect(buildBagJson(bag(), rows[0]).commitments).toEqual({
      onchainCompositionHash: null, onchainTxHash: null,
      onchainComposition: { status: 'NOT_RECORDED', recordedFrom: null, comparedBy: null, readFromChainThisRequest: false },
      registry: NOT_REGISTERED,
    });
    // Never claims a chain read.
    expect(JSON.stringify(buildBagJson(bag(), rows[1]))).not.toMatch(/"readFromChainThisRequest":true/);
  });

  it('is stable: the Bag\'s current metadata, status, fee lock or fork link never change the definition hash', () => {
    const h = buildBagJson(bag(), rows[1]).definitionHash;
    const changed = bag({ name: 'x', symbol: 'y', description: 'z', status: 'ARCHIVED', performanceFeeBpsLocked: 500, parentBagId: PARENT });
    const doc = buildBagJson(changed, rows[1]);
    expect(doc.definitionHash).toBe(h);
    expect(doc.forkedFrom).toEqual({ strategyId: PARENT, version: null });
  });

  it('StrategyRegistry: a verified registration of exactly this hash is REGISTERED (with fork origin); any other hash is not', () => {
    const hash = buildBagJson(bag(), rows[0]).definitionHash;
    const registration = {
      bag_id: ID, version: 1, chain: 'robinhood', registry_address: '0x' + 'aa'.repeat(20), registry_strategy_id: '0x' + 'bb'.repeat(32),
      definition_hash: hash, creator_wallet: '0x' + 'cc'.repeat(20), fork_of_registry_strategy_id: '0x' + 'dd'.repeat(32), fork_of_version: 3,
      tx_hash: '0x' + 'ee'.repeat(32), block_number: 42, log_index: 1,
    };
    const doc = buildBagJson(bag({ parentBagId: PARENT, parentBagVersion: 3 }), { ...rows[0], registration });
    expect(doc.commitments.registry).toEqual({
      status: 'REGISTERED', chainId: 4663, registryAddress: registration.registry_address, registryStrategyId: registration.registry_strategy_id,
      creator: registration.creator_wallet, txHash: registration.tx_hash, blockNumber: 42,
      forkOf: { registryStrategyId: registration.fork_of_registry_strategy_id, version: 3 },
      recordedFrom: 'VERIFIED_TX_RECEIPT', verifiedBy: 'BAG', readFromChainThisRequest: false,
    });
    expect(doc.forkedFrom).toEqual({ strategyId: PARENT, version: 3 });
    expect(validBagJson(doc)).toBe(true);
    // A recorded commitment that is not this version's hash is never shown as registered.
    expect(buildBagJson(bag(), { ...rows[0], registration: { ...registration, definition_hash: '0x' + '12'.repeat(32) } }).commitments.registry).toEqual(NOT_REGISTERED);
  });

  it('legacy fields the recipe never had stay null (v1 had no fee set)', () => {
    expect(buildBagJson(bag(), rows[0]).definition.rules.performanceFeeBps).toBeNull();
  });

  it('exposes no internal ids', () => {
    const s = JSON.stringify(buildBagJson(bag(), rows[1]));
    expect(s).not.toContain('alice-internal-user-id');
    expect(s).not.toContain('row-v2');
  });
});

describe('schemas reject what the contract does not allow', () => {
  it('bag.json and Strategy schemas are strict', () => {
    const doc = buildBagJson(bag(), rows[1]);
    expect(validBagJson({ ...doc, extra: 1 })).toBe(false);
    expect(validBagJson({ ...doc, definition: { ...doc.definition, rules: { ...doc.definition.rules, swapSlippageBps: '100' } } })).toBe(false);
    expect(validBagJson({ ...doc, definitionHash: '0x1234' })).toBe(false);
    expect(validBagJson({ ...doc, bagJson: 2 })).toBe(false);
    expect(validStrategy({})).toBe(false);
    expect(validVersions({ schemaVersion: 1, strategyId: ID, currentVersion: null, versions: [{}] })).toBe(false);
  });
});

describe('versions list', () => {
  it('newest first, current marked, each with its definitionHash and commitment', () => {
    const r = buildStrategyVersions(bag(), rows);
    expect(r).toMatchObject({ schemaVersion: STRATEGY_API_SCHEMA_VERSION, strategyId: ID, currentVersion: 2 });
    expect(r.versions.map((v) => [v.version, v.isCurrent, v.parentVersion])).toEqual([[2, true, 1], [1, false, null]]);
    expect(r.versions[0].definitionHash).toBe(buildBagJson(bag(), rows[1]).definitionHash);
    expect(r.versions[0].definitionHash).not.toBe(r.versions[1].definitionHash);
    expect(validVersions(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain('row-v');
  });
});

describe('Strategy object', () => {
  const passport = (b: BagRecord) =>
    buildStrategyPassport({
      bag: b, currentVersion: { id: 'row-v2', bagId: ID, version: 2, compositionHash: 'h', recipe: v2Recipe, createdBy: 'alice-internal-user-id', reason: 'Add AMD', createdAt: '2026-09-08T00:00:00Z' },
      versions: [], deployment: null, creators: new Map(), assetsByKey: new Map([[`robinhood:${NVDA.toLowerCase()}`, { routeStatus: 'NO_ROUTE', routeCheckedAt: '2026-10-01T00:00:00Z' } as CanonicalAsset]]),
      nav: { tvlUsd: null, navPerShare: null, asOf: null }, returns: null, holders: null, ancestors: [], missingAncestorIds: [], children: [], childCount: 0,
      viewerUserId: null, now: new Date('2026-10-03T00:00:00Z'),
    });

  it('separates definition (bag.json), state, policy and lineage', () => {
    const b = bag();
    const s = buildStrategyObject(b, passport(b), rows);
    expect(s.definition?.definitionHash).toBe(buildBagJson(b, rows[1]).definitionHash);
    // Current display values live in state; bag.json keeps the version-time ones.
    expect(s.state.display).toMatchObject({ name: 'AI Infra (renamed)', symbol: 'AINF2' });
    expect(s.definition?.metadata.name).toBe('AI Infra');
    expect(s.state.routes.assets[0]).toMatchObject({ routeStatus: 'NO_ROUTE' });
    expect(s.state.routes.sourceInfo).toMatchObject({ source: 'BAG_ATTESTED', asOf: '2026-10-01T00:00:00Z' });
    expect(s.policy?.schemaVersion).toBe(2);
    expect(s.lineage).toMatchObject({ currentVersion: 2, versionCount: 2 });
    expect(s.links).toEqual({
      self: `/api/strategies/${ID}`, versions: `/api/strategies/${ID}/versions`, currentDefinition: `/api/strategies/${ID}/versions/2`,
      myExecutions: `/api/users/me/strategies/${ID}/executions`, passport: `/api/bags/${ID}/passport`,
    });
    expect(validStrategy(s)).toBe(true);
    expect(JSON.stringify(s)).not.toContain('alice-internal-user-id');
  });

  it('declared vs effective performance fee: the Bag-level lock wins, the definition keeps what was declared', () => {
    const open = buildStrategyObject(bag(), passport(bag()), rows);
    expect(open.state.performanceFee).toEqual({ declaredBps: 1000, effectiveBps: 1000, locked: false });
    const lockedBag = bag({ performanceFeeBpsLocked: 800 });
    const locked = buildStrategyObject(lockedBag, passport(lockedBag), rows);
    expect(locked.state.performanceFee).toEqual({ declaredBps: 1000, effectiveBps: 800, locked: true });
    expect(locked.definition?.definitionHash).toBe(open.definition?.definitionHash);
  });

  it('a Bag without a current version has no definition and no current-definition link', () => {
    const b = bag({ currentVersionId: null });
    const s = buildStrategyObject(b, passport(b), []);
    expect(s.definition).toBeNull();
    expect(s.links.currentDefinition).toBeNull();
    expect(s.lineage).toMatchObject({ currentVersion: null, versionCount: 0 });
    expect(validStrategy(s)).toBe(true);
  });
});

describe('isStrategyId', () => {
  it('only UUIDs reach the database', () => {
    expect(isStrategyId(ID)).toBe(true);
    for (const bad of ['', 'bag-1', `${ID} `, `${ID}' or 1=1`, '../x', ID.replace(/-/g, '')]) expect(isStrategyId(bad)).toBe(false);
  });
});

// ----------------------------- validate on a definition ------------------------

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const reg = (n: number, symbol: string, over: Partial<CanonicalAsset> = {}): CanonicalAsset => ({
  id: symbol, chain: 'robinhood', address: addr(n), symbol, decimals: 18, name: symbol, status: 'VERIFIED', assetType: 'stock', routeStatus: 'ROUTABLE', createdAt: '', updatedAt: '', ...over,
});
const registry = [reg(1, 'NVDA'), reg(2, 'AMD'), reg(3, 'USDC', { decimals: 6 })];
const definition = (over: Record<string, unknown> = {}, rules: Record<string, unknown> = {}) => ({
  kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'MUTABLE',
  assets: [
    { chain: 'robinhood', address: addr(2), decimals: 18, weightBps: 4000 },
    { chain: 'robinhood', address: addr(1), decimals: 18, weightBps: 6000 },
  ],
  rules: {
    weightBounds: { minBps: 500, maxBps: 7000 }, maxAssets: 10, minInvestment: { amount: '10', measuredAs: 'PAYMENT_TOKEN_AMOUNT' }, swapSlippageBps: 100,
    rebalance: { frequency: 'THRESHOLD_ONLY', driftThresholdBps: 500 }, performanceFeeBps: 1000, noRouteAssetPolicy: 'HOLD_INPUT', ...rules,
  },
  ...over,
});

describe('parseDefinition (strict shape)', () => {
  it('accepts { definition } or a whole bag.json document', () => {
    expect(parseDefinition({ definition: definition() }).assets.map((a) => a.address)).toEqual([addr(1), addr(2)]);
    const doc = buildBagJson(bag(), rows[1]);
    expect(parseDefinition(doc)).toEqual(doc.definition);
  });

  it('refuses unknown keys, missing keys, wrong types and other format versions', () => {
    const bad: unknown[] = [
      null,
      { definition: null },
      { definition: { ...definition(), extra: 1 } },
      { definition: definition({ rules: { ...definition().rules, investmentUsd: 100 } }) },
      { definition: (({ kind: _k, ...rest }) => rest)(definition()) },
      { definition: definition({}, { maxAssets: '10' }) },
      { definition: definition({}, { minInvestment: { amount: '1e3', measuredAs: 'PAYMENT_TOKEN_AMOUNT' } }) },
      { definition: definition({}, { minInvestment: { amount: '10', measuredAs: 'USD' } }) },
      { definition: definition({ chain: 'dogechain' }) },
      { definition: definition({ kind: 'LEVERAGED' }) },
      { definition: definition({ assets: [{ chain: 'robinhood', address: addr(1), weightBps: 10000 }] }) },
      // A symbol is display, not part of bag.json v1's definition.
      { definition: definition({ assets: [{ chain: 'robinhood', address: addr(1), symbol: 'NVDA', decimals: 18, weightBps: 10000 }] }) },
      { bagJson: 2, definition: definition() },
    ];
    for (const b of bad) expect(() => parseDefinition(b), JSON.stringify(b)).toThrow(ValidateBagInputError);
  });
});

describe('validateDefinition', () => {
  it('a valid definition: same engine as validate_bag, canonical form and hash returned', () => {
    const r = validateDefinition(parseDefinition({ definition: definition() }), registry);
    expect(r.validation.valid).toBe(true);
    expect(r.definition.assets.map((a) => a.address)).toEqual([addr(1), addr(2)]);
    expect(r.definitionHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Input order does not change the hash.
    const swapped = definition({ assets: [...definition().assets].reverse() });
    expect(validateDefinition(parseDefinition({ definition: swapped }), registry).definitionHash).toBe(r.definitionHash);
    expect(validValidation(r)).toBe(true);
  });

  it('findings point at definition paths, not validate_bag request fields', () => {
    const r = validateDefinition(parseDefinition({ definition: definition({}, { weightBounds: { minBps: 500, maxBps: 5000 } }) }), registry);
    expect(r.validation.valid).toBe(false);
    expect(r.validation.errors.map((e) => e.field)).toContain('assets[0].weightBps');
    const bad = validateDefinition(parseDefinition({ definition: definition({}, { maxAssets: 0 }) }), registry);
    expect(bad.validation.errors.find((e) => e.code === 'INVALID_POLICY_VALUE')?.field).toBe('rules.maxAssets');
  });

  it('declared decimals must match the registry', () => {
    const wrong = definition({ assets: [{ chain: 'robinhood', address: addr(3), decimals: 18, weightBps: 10000 }] });
    const r = validateDefinition(parseDefinition({ definition: wrong }), registry);
    expect(r.validation.valid).toBe(false);
    expect(r.validation.errors.find((e) => e.code === 'DECIMALS_MISMATCH')).toMatchObject({ rule: 'registry', field: 'assets[0].decimals', requested: 18, allowed: 6 });
    expect(r.validation.checks.find((c) => c.rule === 'registry')?.result).toBe('FAIL');
  });

  it('null means "not set": the policy view shows the protocol default that applies', () => {
    const r = validateDefinition(parseDefinition({ definition: definition({}, { noRouteAssetPolicy: null, performanceFeeBps: null }) }), registry);
    expect(r.definition.rules.noRouteAssetPolicy).toBeNull();
    expect(r.validation.policy.noRouteAssetPolicy).toMatchObject({ value: 'BLOCK', source: 'BAG_PROTOCOL' });
  });
});
