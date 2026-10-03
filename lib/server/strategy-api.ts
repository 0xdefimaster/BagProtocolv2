import type { SupabaseClient } from '@supabase/supabase-js';
import { BagRecord, BasketRecipe, CanonicalAsset, ChainId, RebalanceFrequency, STRATEGY_TYPES, SUPPORTED_CHAINS } from '@/types/basket-protocol';
import type { SourceInfo, StrategyPassport } from '@/types/strategy-passport';
import {
  BAG_JSON_FORMAT_VERSION,
  BagDefinition,
  BagJson,
  STRATEGY_API_SCHEMA_VERSION,
  StrategyObject,
  StrategyValidationResponse,
  StrategyVersionSummary,
  StrategyVersionsResponse,
} from '@/types/strategy';
import { computeDefinitionHash, definitionFromRecipe, normalizeDefinition } from '@/lib/domain/basket-protocol/bag-json';
import { computeOnChainCompositionHash } from '@/lib/domain/basket-protocol/onchain';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { BAG_CHAINS, BagChain } from '@/lib/config/chains';
import { loadStrategyPassport } from '@/lib/server/strategy-passport';
import { ValidateBagInputError, ValidateBagRequest, ValidationFinding, parseValidateBagRequest, validateBag } from '@/lib/server/validate-bag';

// -----------------------------------------------------------------------------
// Unified Strategy API (GET /api/strategies/*): bag.json v1 per version, the
// Strategy object (definition + state + policy + lineage) and validate on a
// bag.json definition. Composes the existing builders (Passport, policy,
// validate_bag); no new tables, no duplicated rules.
// Design: docs/BAG_JSON_V1_DESIGN.md.
// -----------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strategy ids are Bag UUIDs; anything else is answered 404 before any query. */
export const isStrategyId = (id: string) => UUID_RE.test(id);

/** Columns read from bag_versions (checked against the real schema by an integration test). */
export const STRATEGY_VERSION_COLUMNS = 'id,version,created_at,reason,recipe,onchain_tx_hash,onchain_composition_hash';

export interface StrategyVersionRow {
  id: string;
  version: number;
  created_at: string;
  reason: string;
  recipe: BasketRecipe;
  onchain_tx_hash: string | null;
  onchain_composition_hash: string | null;
}

export async function loadStrategyVersionRows(admin: SupabaseClient, bagId: string): Promise<StrategyVersionRow[]> {
  const { data, error } = await admin.from('bag_versions').select(STRATEGY_VERSION_COLUMNS).eq('bag_id', bagId).order('version', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as StrategyVersionRow[];
}

const chainIdOf = (chain: ChainId): number | null => (BAG_CHAINS as Partial<Record<string, (typeof BAG_CHAINS)[BagChain]>>)[chain]?.chainId ?? null;

function commitmentsOf(row: StrategyVersionRow): BagJson['commitments'] {
  const recorded = row.onchain_composition_hash;
  let committed: boolean | null = null;
  if (recorded) {
    try {
      committed = computeOnChainCompositionHash(row.recipe.assets).toLowerCase() === recorded.toLowerCase();
    } catch {
      committed = false;
    }
  }
  return { onchainCompositionHash: recorded ?? null, onchainTxHash: row.onchain_tx_hash ?? null, compositionCommittedOnchain: committed };
}

/** bag.json for one stored version. Pure. */
export function buildBagJson(bag: BagRecord, row: StrategyVersionRow): BagJson {
  const definition = definitionFromRecipe({ ...row.recipe, chain: row.recipe.chain ?? bag.chain });
  return {
    bagJson: BAG_JSON_FORMAT_VERSION,
    definition,
    definitionHash: computeDefinitionHash(definition),
    ref: { strategyId: bag.id, version: row.version, parentVersion: row.version > 1 ? row.version - 1 : null, createdAt: row.created_at },
    network: { chainId: chainIdOf(definition.chain) },
    metadata: { name: row.recipe.name ?? '', symbol: row.recipe.symbol ?? '', description: row.recipe.description ?? '' },
    commitments: commitmentsOf(row),
    forkedFrom: bag.parentBagId ? { strategyId: bag.parentBagId, version: null } : null,
  };
}

const currentRowOf = (bag: BagRecord, rows: StrategyVersionRow[]) => rows.find((r) => r.id === bag.currentVersionId) ?? null;

/** Version list, newest first. Pure. */
export function buildStrategyVersions(bag: BagRecord, rows: StrategyVersionRow[]): StrategyVersionsResponse {
  const current = currentRowOf(bag, rows);
  const versions: StrategyVersionSummary[] = [...rows]
    .sort((a, b) => b.version - a.version)
    .map((row) => {
      const doc = buildBagJson(bag, row);
      return {
        version: row.version,
        parentVersion: doc.ref.parentVersion,
        createdAt: row.created_at,
        reason: row.reason,
        isCurrent: current?.id === row.id,
        definitionHash: doc.definitionHash,
        commitments: doc.commitments,
      };
    });
  return { schemaVersion: STRATEGY_API_SCHEMA_VERSION, strategyId: bag.id, currentVersion: current?.version ?? null, versions };
}

export const strategyLinks = (id: string, currentVersion: number | null): StrategyObject['links'] => ({
  self: `/api/strategies/${id}`,
  versions: `/api/strategies/${id}/versions`,
  currentDefinition: currentVersion === null ? null : `/api/strategies/${id}/versions/${currentVersion}`,
  myExecutions: `/api/users/me/strategies/${id}/executions`,
  passport: `/api/bags/${id}/passport`,
});

/** The Strategy object from an already built Passport and the version rows. Pure. */
export function buildStrategyObject(bag: BagRecord, passport: StrategyPassport, rows: StrategyVersionRow[]): StrategyObject {
  const current = currentRowOf(bag, rows);
  const definition = current ? buildBagJson(bag, current) : null;
  const checkedAt = passport.composition.assets.map((a) => a.routeCheckedAt).filter((t): t is string => !!t).sort();
  const routesSource: SourceInfo = { source: 'BAG_ATTESTED', asOf: checkedAt.length ? checkedAt[checkedAt.length - 1] : null, verifiableBy: 'NONE', readFromChainThisRequest: false };
  const locked = bag.performanceFeeBpsLocked ?? null;
  return {
    schemaVersion: STRATEGY_API_SCHEMA_VERSION,
    generatedAt: passport.generatedAt,
    strategyId: bag.id,
    definition,
    state: {
      status: passport.identity.status,
      slug: passport.identity.slug,
      display: { sourceInfo: passport.identity.sourceInfo, name: passport.identity.name, symbol: passport.identity.symbol, description: passport.identity.description },
      creator: passport.creator,
      onchain: passport.onchain,
      performance: passport.performance,
      routes: {
        sourceInfo: routesSource,
        assets: passport.composition.assets.map((a) => ({ chain: a.chain, address: a.address, routeStatus: a.routeStatus, routeCheckedAt: a.routeCheckedAt })),
      },
      performanceFee: {
        declaredBps: definition?.definition.rules.performanceFeeBps ?? null,
        effectiveBps: passport.policy?.performanceFeeBps.value ?? locked,
        locked: locked !== null,
      },
    },
    policy: passport.policy,
    lineage: { currentVersion: current?.version ?? null, versionCount: rows.length, forks: passport.lineage.forks },
    links: strategyLinks(bag.id, current?.version ?? null),
  };
}

export async function loadStrategyObject(admin: SupabaseClient, bag: BagRecord, viewerUserId: string | null): Promise<StrategyObject> {
  const [passport, rows] = await Promise.all([loadStrategyPassport(admin, bag, viewerUserId), loadStrategyVersionRows(admin, bag.id)]);
  return buildStrategyObject(bag, passport, rows);
}

// ----------------------------- validate on a definition ------------------------

const DEFINITION_KEYS = ['kind', 'chain', 'mutability', 'assets', 'rules'];
const RULE_KEYS = ['weightBounds', 'maxAssets', 'minInvestment', 'swapSlippageBps', 'rebalance', 'performanceFeeBps', 'noRouteAssetPolicy'];
const ASSET_KEYS = ['chain', 'address', 'symbol', 'decimals', 'weightBps'];
const DECIMAL_RE = /^\d+(\.\d+)?$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function exactKeys(v: Record<string, unknown>, keys: string[], at: string) {
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new ValidateBagInputError(`${at}.${k} is not part of bag.json v1.`);
  for (const k of keys) if (!(k in v)) throw new ValidateBagInputError(`${at}.${k} is required (use null for "not set").`);
}
function numOrNull(v: unknown, at: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidateBagInputError(`${at} must be a number or null.`);
  return v;
}
function strOrNull(v: unknown, at: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new ValidateBagInputError(`${at} must be a string or null.`);
  return v;
}

/**
 * Strict shape check of a submitted bag.json `definition` (or a whole bag.json document; only its
 * definition is used). Unknown or missing keys are refused. Values are checked by validate_bag, not here.
 */
export function parseDefinition(body: unknown): BagDefinition {
  if (!isObject(body)) throw new ValidateBagInputError('Body must be a JSON object.');
  const raw = body.definition;
  if (!isObject(raw)) throw new ValidateBagInputError('definition must be an object (a bag.json v1 definition).');
  if ('bagJson' in body && body.bagJson !== BAG_JSON_FORMAT_VERSION) throw new ValidateBagInputError(`Only bag.json v${BAG_JSON_FORMAT_VERSION} is supported.`);
  exactKeys(raw, DEFINITION_KEYS, 'definition');

  if (typeof raw.chain !== 'string' || !(SUPPORTED_CHAINS as readonly string[]).includes(raw.chain)) throw new ValidateBagInputError('definition.chain is not a supported chain.');
  if (raw.kind !== null && !(STRATEGY_TYPES as readonly unknown[]).includes(raw.kind)) throw new ValidateBagInputError(`definition.kind must be one of ${STRATEGY_TYPES.join(', ')} or null.`);
  if (raw.mutability !== null && raw.mutability !== 'MUTABLE' && raw.mutability !== 'IMMUTABLE') throw new ValidateBagInputError('definition.mutability must be MUTABLE, IMMUTABLE or null.');
  if (!Array.isArray(raw.assets)) throw new ValidateBagInputError('definition.assets must be an array.');

  const assets = raw.assets.map((a: unknown, i: number) => {
    const at = `definition.assets[${i}]`;
    if (!isObject(a)) throw new ValidateBagInputError(`${at} must be an object.`);
    exactKeys(a, ASSET_KEYS, at);
    if (typeof a.chain !== 'string' || !(SUPPORTED_CHAINS as readonly string[]).includes(a.chain)) throw new ValidateBagInputError(`${at}.chain is not a supported chain.`);
    if (typeof a.address !== 'string' || typeof a.symbol !== 'string') throw new ValidateBagInputError(`${at}.address and .symbol must be strings.`);
    if (typeof a.decimals !== 'number' || typeof a.weightBps !== 'number' || !Number.isFinite(a.decimals) || !Number.isFinite(a.weightBps)) {
      throw new ValidateBagInputError(`${at}.decimals and .weightBps must be numbers.`);
    }
    return { chain: a.chain as ChainId, address: a.address, symbol: a.symbol, decimals: a.decimals, weightBps: a.weightBps };
  });

  const r = raw.rules;
  if (!isObject(r)) throw new ValidateBagInputError('definition.rules must be an object.');
  exactKeys(r, RULE_KEYS, 'definition.rules');
  if (!isObject(r.weightBounds)) throw new ValidateBagInputError('definition.rules.weightBounds must be an object.');
  exactKeys(r.weightBounds, ['minBps', 'maxBps'], 'definition.rules.weightBounds');
  let minInvestment: BagDefinition['rules']['minInvestment'] = null;
  if (r.minInvestment !== null) {
    if (!isObject(r.minInvestment)) throw new ValidateBagInputError('definition.rules.minInvestment must be an object or null.');
    exactKeys(r.minInvestment, ['amount', 'measuredAs'], 'definition.rules.minInvestment');
    if (typeof r.minInvestment.amount !== 'string' || !DECIMAL_RE.test(r.minInvestment.amount)) throw new ValidateBagInputError('definition.rules.minInvestment.amount must be a decimal string.');
    if (r.minInvestment.measuredAs !== 'PAYMENT_TOKEN_AMOUNT') throw new ValidateBagInputError('definition.rules.minInvestment.measuredAs must be PAYMENT_TOKEN_AMOUNT.');
    minInvestment = { amount: r.minInvestment.amount, measuredAs: 'PAYMENT_TOKEN_AMOUNT' };
  }
  let rebalance: BagDefinition['rules']['rebalance'] = null;
  if (r.rebalance !== null) {
    if (!isObject(r.rebalance)) throw new ValidateBagInputError('definition.rules.rebalance must be an object or null.');
    exactKeys(r.rebalance, ['frequency', 'driftThresholdBps'], 'definition.rules.rebalance');
    rebalance = {
      frequency: strOrNull(r.rebalance.frequency, 'definition.rules.rebalance.frequency') as RebalanceFrequency | null,
      driftThresholdBps: numOrNull(r.rebalance.driftThresholdBps, 'definition.rules.rebalance.driftThresholdBps'),
    };
  }

  return normalizeDefinition({
    kind: raw.kind as BagDefinition['kind'],
    chain: raw.chain as ChainId,
    mutability: raw.mutability as BagDefinition['mutability'],
    assets,
    rules: {
      weightBounds: { minBps: numOrNull(r.weightBounds.minBps, 'definition.rules.weightBounds.minBps'), maxBps: numOrNull(r.weightBounds.maxBps, 'definition.rules.weightBounds.maxBps') },
      maxAssets: numOrNull(r.maxAssets, 'definition.rules.maxAssets'),
      minInvestment,
      swapSlippageBps: numOrNull(r.swapSlippageBps, 'definition.rules.swapSlippageBps'),
      rebalance,
      performanceFeeBps: numOrNull(r.performanceFeeBps, 'definition.rules.performanceFeeBps'),
      noRouteAssetPolicy: strOrNull(r.noRouteAssetPolicy, 'definition.rules.noRouteAssetPolicy') as BagDefinition['rules']['noRouteAssetPolicy'],
    },
  });
}

/** The validate_bag request a definition corresponds to: `null` (not set) leaves the protocol default. */
export function definitionToValidateRequest(def: BagDefinition): ValidateBagRequest {
  const r = def.rules;
  const policy: NonNullable<ValidateBagRequest['policy']> = {};
  if (r.weightBounds.maxBps !== null) policy.maxSingleAssetWeightBps = r.weightBounds.maxBps;
  if (r.weightBounds.minBps !== null) policy.minSingleAssetWeightBps = r.weightBounds.minBps;
  if (r.maxAssets !== null) policy.maxAssets = r.maxAssets;
  if (r.minInvestment !== null) policy.minInvestmentUsd = Number(r.minInvestment.amount);
  if (r.swapSlippageBps !== null) policy.maxSlippageBps = r.swapSlippageBps;
  if (r.performanceFeeBps !== null) policy.performanceFeeBps = r.performanceFeeBps;
  if (r.noRouteAssetPolicy !== null) policy.noRouteAssetPolicy = r.noRouteAssetPolicy;
  if (r.rebalance?.frequency) policy.rebalanceFrequency = r.rebalance.frequency;
  if (r.rebalance && r.rebalance.driftThresholdBps !== null) policy.driftThresholdBps = r.rebalance.driftThresholdBps;
  return parseValidateBagRequest({
    chain: def.chain,
    assets: def.assets.map((a) => ({ chain: a.chain, address: a.address, symbol: a.symbol, weightBps: a.weightBps })),
    policy,
    ...(def.mutability ? { mutability: def.mutability } : {}),
  });
}

/** validate_bag's field names → paths in the definition. */
const FIELD_PATHS: Record<string, string> = {
  'policy.maxSingleAssetWeightBps': 'rules.weightBounds.maxBps',
  'policy.minSingleAssetWeightBps': 'rules.weightBounds.minBps',
  'policy.maxAssets': 'rules.maxAssets',
  'policy.minInvestmentUsd': 'rules.minInvestment.amount',
  'policy.maxSlippageBps': 'rules.swapSlippageBps',
  'policy.performanceFeeBps': 'rules.performanceFeeBps',
  'policy.noRouteAssetPolicy': 'rules.noRouteAssetPolicy',
  'policy.rebalanceFrequency': 'rules.rebalance.frequency',
  'policy.driftThresholdBps': 'rules.rebalance.driftThresholdBps',
};
const remapField = (f: ValidationFinding): ValidationFinding => ({ ...f, field: FIELD_PATHS[f.field] ?? f.field });

/**
 * validate_bag on a canonical definition, plus one check validate_bag cannot do on its own input: a
 * definition declares each asset's decimals, which must match the asset registry. Pure.
 */
export function validateDefinition(def: BagDefinition, registry: CanonicalAsset[]): StrategyValidationResponse {
  const definition = normalizeDefinition(def);
  const result = validateBag(definitionToValidateRequest(definition), registry);
  const byKey = new Map(registry.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a] as const));
  const decimalErrors: ValidationFinding[] = [];
  definition.assets.forEach((a, i) => {
    const reg = byKey.get(assetIdentityKey(a));
    if (reg && reg.decimals !== a.decimals) {
      decimalErrors.push({
        code: 'DECIMALS_MISMATCH',
        severity: 'error',
        rule: 'registry',
        field: `assets[${i}].decimals`,
        message: `assets[${i}] declares ${a.decimals} decimals; the asset registry records ${reg.decimals}.`,
        asset: { chain: a.chain, address: a.address, symbol: a.symbol },
        requested: a.decimals,
        allowed: reg.decimals,
      });
    }
  });
  const errors = [...result.errors, ...decimalErrors].map(remapField);
  const checks = decimalErrors.length ? result.checks.map((c) => (c.rule === 'registry' ? { ...c, result: 'FAIL' as const } : c)) : result.checks;
  return {
    schemaVersion: STRATEGY_API_SCHEMA_VERSION,
    definitionHash: computeDefinitionHash(definition),
    definition,
    validation: { ...result, valid: errors.length === 0, errors, warnings: result.warnings.map(remapField), info: result.info.map(remapField), checks },
  };
}
