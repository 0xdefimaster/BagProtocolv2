import {
  BagMutability,
  BasketRecipe,
  CanonicalAsset,
  ChainId,
  DEFAULT_MAX_WEIGHT_BPS,
  DEFAULT_MIN_WEIGHT_BPS,
  DEFAULT_REBALANCE_RULE,
  DEFAULT_STRATEGY_TYPE,
  RebalanceFrequency,
  SUPPORTED_CHAINS,
  UNROUTABLE_POLICIES,
  UnroutablePolicy,
  ValidationIssue,
  defaultMaxAssets,
} from '@/types/basket-protocol';
import { Enforcement, StrategyPolicy, StrategyPolicyKey } from '@/types/strategy-policy';
import { VALIDATION_CODES, validateAssets, validateEconomics, validateRebalanceRule, validateWeightBounds, validateWeightInvariants } from '@/lib/domain/basket-protocol/validation';
import { assetIdentityKey } from '@/lib/domain/basket-protocol/asset-identity';
import { deriveStrategyPolicy } from '@/lib/server/strategy-policy';

// -----------------------------------------------------------------------------
// validate_bag: checks a proposed composition + policy against the SAME rules
// BAG applies when a Bag is created or bought — it runs the existing domain
// validators (validateBasketRecipe's parts, registry verification,
// applyUnroutablePolicy's weight cap, purchase-preview's minimum) — and returns
// deterministic, machine-readable findings: what failed or passed, why, and who
// would enforce it. Nothing is written. Backs POST /api/bags/validate and,
// later, the MCP validate_bag tool.
// -----------------------------------------------------------------------------

export const VALIDATE_BAG_SCHEMA_VERSION = 1;
export const MAX_VALIDATE_ASSETS = 100;

export interface ValidateBagRequest {
  /** Defaults to 'robinhood'. */
  chain?: ChainId;
  assets: { chain?: ChainId; address: string; symbol?: string; weightBps: number }[];
  /** Omitted fields take the defaults a newly created Bag gets. */
  policy?: {
    maxSingleAssetWeightBps?: number;
    minSingleAssetWeightBps?: number;
    maxAssets?: number;
    minInvestmentUsd?: number;
    maxSlippageBps?: number;
    performanceFeeBps?: number;
    noRouteAssetPolicy?: UnroutablePolicy;
    rebalanceFrequency?: RebalanceFrequency;
    driftThresholdBps?: number;
  };
  mutability?: BagMutability;
  /** Optional deposit size to check against minInvestmentUsd. */
  investmentUsd?: number;
}

export type FindingSeverity = 'error' | 'warning' | 'info';
export type CheckResult = 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED';

/** The rule a finding belongs to: a policy key, or a structural rule. */
export type FindingRule = StrategyPolicyKey | 'composition' | 'weightsSum' | 'uniqueAssets' | 'registry' | 'routes';

export interface ValidationFinding {
  code: string;
  severity: FindingSeverity;
  rule: FindingRule;
  /** Dot-path into the request, e.g. `assets[2].weightBps` or `policy.maxSlippageBps`. */
  field: string;
  message: string;
  asset?: { chain: ChainId; address: string; symbol: string };
  requested?: number;
  allowed?: number;
}

export interface ValidationCheck {
  rule: FindingRule;
  result: CheckResult;
  /** Who enforces the rule once the Bag exists; null for purely structural checks done here. */
  enforcement: Enforcement | null;
  findings: number;
}

export interface ValidateBagResult {
  schemaVersion: typeof VALIDATE_BAG_SCHEMA_VERSION;
  valid: boolean;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  info: ValidationFinding[];
  checks: ValidationCheck[];
  /** The policy these assets were checked against (same object the Passport shows). */
  policy: StrategyPolicy;
}

export class ValidateBagInputError extends Error {}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
const RULE_ORDER: FindingRule[] = [
  'composition',
  'uniqueAssets',
  'registry',
  'weightsSum',
  'maxSingleAssetWeightBps',
  'minSingleAssetWeightBps',
  'maxAssets',
  'minInvestmentUsd',
  'maxSlippageBps',
  'performanceFeeBps',
  'noRouteAssetPolicy',
  'rebalanceRule',
  'routes',
];

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Rejects malformed requests (wrong types) before any rule runs; rule violations are findings, not exceptions. */
export function parseValidateBagRequest(body: unknown): ValidateBagRequest {
  const b = body as Partial<ValidateBagRequest> | null;
  if (!b || typeof b !== 'object') throw new ValidateBagInputError('Body must be a JSON object.');
  if (b.chain !== undefined && !SUPPORTED_CHAINS.includes(b.chain)) throw new ValidateBagInputError(`Unsupported chain "${String(b.chain)}".`);
  if (!Array.isArray(b.assets)) throw new ValidateBagInputError('assets must be an array.');
  if (b.assets.length > MAX_VALIDATE_ASSETS) throw new ValidateBagInputError(`At most ${MAX_VALIDATE_ASSETS} assets.`);
  for (const [i, a] of b.assets.entries()) {
    if (!a || typeof a !== 'object' || typeof a.address !== 'string' || typeof a.weightBps !== 'number') {
      throw new ValidateBagInputError(`assets[${i}] needs an address (string) and weightBps (number).`);
    }
    if (a.chain !== undefined && !SUPPORTED_CHAINS.includes(a.chain)) throw new ValidateBagInputError(`assets[${i}].chain is not supported.`);
  }
  if (b.policy !== undefined && (typeof b.policy !== 'object' || b.policy === null)) throw new ValidateBagInputError('policy must be an object.');
  for (const [k, v] of Object.entries(b.policy ?? {})) {
    if (k === 'noRouteAssetPolicy' || k === 'rebalanceFrequency') {
      if (typeof v !== 'string') throw new ValidateBagInputError(`policy.${k} must be a string.`);
    } else if (typeof v !== 'number') {
      throw new ValidateBagInputError(`policy.${k} must be a number.`);
    }
  }
  if (b.investmentUsd !== undefined && typeof b.investmentUsd !== 'number') throw new ValidateBagInputError('investmentUsd must be a number.');
  if (b.mutability !== undefined && b.mutability !== 'MUTABLE' && b.mutability !== 'IMMUTABLE') throw new ValidateBagInputError('mutability must be MUTABLE or IMMUTABLE.');
  return b as ValidateBagRequest;
}

/** Which policy rule an existing validator's code belongs to. */
function ruleForCode(code: string): FindingRule {
  switch (code) {
    case VALIDATION_CODES.ABOVE_MAX_WEIGHT:
      return 'maxSingleAssetWeightBps';
    case VALIDATION_CODES.BELOW_MIN_WEIGHT:
      return 'minSingleAssetWeightBps';
    case VALIDATION_CODES.INVALID_WEIGHT_BOUNDS:
      return 'maxSingleAssetWeightBps';
    case VALIDATION_CODES.TOO_MANY_ASSETS:
      return 'maxAssets';
    case VALIDATION_CODES.WEIGHTS_NOT_100:
      return 'weightsSum';
    case VALIDATION_CODES.DUPLICATE_ASSET:
    case VALIDATION_CODES.DUPLICATE_ASSET_ADDRESS:
      return 'uniqueAssets';
    case VALIDATION_CODES.INVALID_MIN_INVESTMENT:
      return 'minInvestmentUsd';
    case VALIDATION_CODES.INVALID_PERFORMANCE_FEE:
      return 'performanceFeeBps';
    case VALIDATION_CODES.INVALID_SLIPPAGE:
      return 'maxSlippageBps';
    case VALIDATION_CODES.INVALID_REBALANCE_FREQUENCY:
    case VALIDATION_CODES.INVALID_DRIFT_THRESHOLD:
      return 'rebalanceRule';
    default:
      return 'composition';
  }
}

/** Maps a recipe path from the domain validators back to the request's field names. */
function fieldForPath(path: string | undefined): string {
  if (!path) return 'assets';
  return path
    .replace(/^minWeightBps$/, 'policy.minSingleAssetWeightBps')
    .replace(/^maxWeightBps$/, 'policy.maxSingleAssetWeightBps')
    .replace(/^minInvestment$/, 'policy.minInvestmentUsd')
    .replace(/^performanceFeeBps$/, 'policy.performanceFeeBps')
    .replace(/^rebalanceRule\.maxSlippageBps$/, 'policy.maxSlippageBps')
    .replace(/^rebalanceRule\.driftThresholdBps$/, 'policy.driftThresholdBps')
    .replace(/^rebalanceRule(\.frequency)?$/, 'policy.rebalanceFrequency');
}

function assetIndex(path: string | undefined): number | null {
  const m = path?.match(/^assets\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/**
 * Pure: validates `req` given the registry rows for its assets (any status).
 * Same input → same output, findings in a fixed order.
 */
export function validateBag(req: ValidateBagRequest, registry: CanonicalAsset[]): ValidateBagResult {
  const chain: ChainId = req.chain ?? 'robinhood';
  const byKey = new Map(registry.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a] as const));
  const p = req.policy ?? {};
  const findings: ValidationFinding[] = [];

  const resolved = req.assets.map((a) => {
    const assetChain = a.chain ?? chain;
    const reg = byKey.get(assetIdentityKey({ chain: assetChain, address: a.address }));
    return {
      input: a,
      reg,
      recipeAsset: { chain: assetChain, address: a.address, symbol: reg?.symbol ?? a.symbol ?? a.address, decimals: reg?.decimals ?? 18, weightBps: a.weightBps },
    };
  });
  const assetOf = (i: number | null) => (i === null || !resolved[i] ? undefined : { chain: resolved[i].recipeAsset.chain, address: resolved[i].recipeAsset.address, symbol: resolved[i].recipeAsset.symbol });

  // Policy values must be in range before they can be applied.
  const policyRanges: [keyof NonNullable<ValidateBagRequest['policy']>, StrategyPolicyKey, number, number][] = [
    ['maxSingleAssetWeightBps', 'maxSingleAssetWeightBps', 1, 10000],
    ['minSingleAssetWeightBps', 'minSingleAssetWeightBps', 0, 10000],
    ['maxAssets', 'maxAssets', 1, MAX_VALIDATE_ASSETS],
  ];
  for (const [key, rule, min, max] of policyRanges) {
    if (p[key] !== undefined && !isInt(p[key], min, max)) {
      findings.push({ code: 'INVALID_POLICY_VALUE', severity: 'error', rule, field: `policy.${key}`, message: `policy.${key} must be an integer between ${min} and ${max}.`, requested: Number(p[key]) });
    }
  }
  if (p.noRouteAssetPolicy !== undefined && !UNROUTABLE_POLICIES.includes(p.noRouteAssetPolicy)) {
    findings.push({ code: 'INVALID_POLICY_VALUE', severity: 'error', rule: 'noRouteAssetPolicy', field: 'policy.noRouteAssetPolicy', message: `policy.noRouteAssetPolicy must be one of ${UNROUTABLE_POLICIES.join(', ')}.` });
  }

  const recipe: BasketRecipe = {
    id: 'validate',
    bagId: 'validate',
    name: 'validate',
    symbol: 'VALIDATE',
    description: '',
    chain,
    strategyType: DEFAULT_STRATEGY_TYPE,
    assets: resolved.map((r) => r.recipeAsset),
    rebalanceRule: {
      frequency: p.rebalanceFrequency ?? DEFAULT_REBALANCE_RULE.frequency,
      driftThresholdBps: p.driftThresholdBps ?? DEFAULT_REBALANCE_RULE.driftThresholdBps,
      maxSlippageBps: p.maxSlippageBps ?? DEFAULT_REBALANCE_RULE.maxSlippageBps,
    },
    minInvestment: p.minInvestmentUsd ?? 0,
    maxAssets: isInt(p.maxAssets, 1, MAX_VALIDATE_ASSETS) ? p.maxAssets : defaultMaxAssets(req.assets.length),
    minWeightBps: isInt(p.minSingleAssetWeightBps, 0, 10000) ? p.minSingleAssetWeightBps : DEFAULT_MIN_WEIGHT_BPS,
    maxWeightBps: isInt(p.maxSingleAssetWeightBps, 1, 10000) ? p.maxSingleAssetWeightBps : DEFAULT_MAX_WEIGHT_BPS,
    mutability: req.mutability ?? 'MUTABLE',
    performanceFeeBps: p.performanceFeeBps ?? 0,
    unroutablePolicy: p.noRouteAssetPolicy && UNROUTABLE_POLICIES.includes(p.noRouteAssetPolicy) ? p.noRouteAssetPolicy : undefined,
    version: 1,
    createdAt: new Date(0).toISOString(),
  };

  // 1. The existing structural validators — the same ones createBag/createBagVersion run.
  const structural: ValidationIssue[] = [
    ...validateAssets(recipe),
    ...validateWeightInvariants(recipe),
    ...validateWeightBounds(recipe),
    ...validateRebalanceRule(recipe),
    ...validateEconomics(recipe),
  ];
  for (const issue of structural) {
    const rule = ruleForCode(issue.code);
    const idx = assetIndex(issue.path);
    const finding: ValidationFinding = { code: issue.code, severity: issue.severity === 'ERROR' ? 'error' : 'warning', rule, field: fieldForPath(issue.path), message: issue.message };
    const asset = assetOf(idx);
    if (asset) finding.asset = asset;
    if (issue.code === VALIDATION_CODES.ABOVE_MAX_WEIGHT && idx !== null) Object.assign(finding, { requested: recipe.assets[idx].weightBps, allowed: recipe.maxWeightBps });
    if (issue.code === VALIDATION_CODES.BELOW_MIN_WEIGHT && idx !== null) Object.assign(finding, { requested: recipe.assets[idx].weightBps, allowed: recipe.minWeightBps });
    if (issue.code === VALIDATION_CODES.TOO_MANY_ASSETS) Object.assign(finding, { requested: recipe.assets.length, allowed: recipe.maxAssets });
    if (issue.code === VALIDATION_CODES.WEIGHTS_NOT_100) {
      Object.assign(finding, { requested: recipe.assets.filter((a) => Number.isFinite(a.weightBps) && a.weightBps > 0).reduce((s, a) => s + a.weightBps, 0), allowed: 10000 });
    }
    findings.push(finding);
  }

  // 2. Registry: every asset must be a VERIFIED registry asset (as at publish/purchase).
  resolved.forEach((r, i) => {
    if (!r.reg) {
      findings.push({ code: 'ASSET_NOT_FOUND', severity: 'error', rule: 'registry', field: `assets[${i}].address`, message: `No asset ${r.recipeAsset.chain}:${r.recipeAsset.address} in BAG's asset registry.`, asset: assetOf(i) });
    } else if (r.reg.status !== 'VERIFIED') {
      findings.push({ code: VALIDATION_CODES.ASSET_NOT_VERIFIED, severity: 'error', rule: 'registry', field: `assets[${i}].address`, message: `${r.reg.symbol} is in the registry but not VERIFIED (${r.reg.status}).`, asset: assetOf(i) });
    }
  });

  // 3. Routes: the registry's background check (BAG-attested, may be stale; purchases re-quote live).
  const policyForRoutes = recipe.unroutablePolicy ?? 'BLOCK';
  let noRouteWeight = 0;
  resolved.forEach((r, i) => {
    if (!r.reg) return;
    if (r.reg.routeStatus === 'NO_ROUTE') {
      noRouteWeight += Number.isFinite(r.recipeAsset.weightBps) ? r.recipeAsset.weightBps : 0;
      findings.push({
        code: 'ASSET_NO_ROUTE',
        severity: 'warning',
        rule: 'routes',
        field: `assets[${i}].address`,
        message:
          policyForRoutes === 'BLOCK'
            ? `${r.recipeAsset.symbol} had no swap route at the last check; under BLOCK a purchase fails until a route exists.`
            : `${r.recipeAsset.symbol} had no swap route at the last check; under ${policyForRoutes} a purchase skips it.`,
        asset: assetOf(i),
      });
    } else if (!r.reg.routeStatus) {
      findings.push({ code: 'ROUTE_UNCHECKED', severity: 'info', rule: 'routes', field: `assets[${i}].address`, message: `${r.recipeAsset.symbol} has not been route-checked yet; purchases quote live.`, asset: assetOf(i) });
    }
  });
  if (policyForRoutes !== 'BLOCK' && noRouteWeight > 0) {
    const cap = deriveStrategyPolicy(recipe, { mutability: recipe.mutability, deployed: false, performanceFeeBpsLocked: null }).noRouteAssetPolicy.maxUnroutableWeightBps;
    if (noRouteWeight > cap) {
      findings.push({
        code: 'UNROUTABLE_WEIGHT_TOO_HIGH',
        severity: 'warning',
        rule: 'noRouteAssetPolicy',
        field: 'policy.noRouteAssetPolicy',
        message: `Assets without a route total ${noRouteWeight} bps, above the ${cap} bps a purchase may skip; purchases would be refused.`,
        requested: noRouteWeight,
        allowed: cap,
      });
    }
  }

  // 4. Minimum investment (same comparison as purchase-preview.ts), when a size is given.
  if (req.investmentUsd !== undefined && recipe.minInvestment > 0 && req.investmentUsd < recipe.minInvestment) {
    findings.push({
      code: 'MIN_INVESTMENT_NOT_MET',
      severity: 'error',
      rule: 'minInvestmentUsd',
      field: 'investmentUsd',
      message: `The minimum investment is $${recipe.minInvestment}.`,
      requested: req.investmentUsd,
      allowed: recipe.minInvestment,
    });
  }

  const policy = deriveStrategyPolicy(recipe, { mutability: recipe.mutability, deployed: false, performanceFeeBpsLocked: null });

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
      a.field.localeCompare(b.field, 'en', { numeric: true }) ||
      a.code.localeCompare(b.code)
  );

  const enforcementOf = (rule: FindingRule): Enforcement | null =>
    rule in policy && rule !== 'composition' ? (policy as unknown as Record<string, { enforcement: Enforcement }>)[rule].enforcement : rule === 'routes' ? 'ATTESTED_ONLY' : null;
  const checks: ValidationCheck[] = RULE_ORDER.map((rule) => {
    const mine = findings.filter((f) => f.rule === rule);
    const skipped = rule === 'minInvestmentUsd' && req.investmentUsd === undefined && !mine.length;
    const result: CheckResult = mine.some((f) => f.severity === 'error') ? 'FAIL' : mine.some((f) => f.severity === 'warning') ? 'WARN' : skipped ? 'SKIPPED' : 'PASS';
    return { rule, result, enforcement: enforcementOf(rule), findings: mine.length };
  });

  const errors = findings.filter((f) => f.severity === 'error');
  return {
    schemaVersion: VALIDATE_BAG_SCHEMA_VERSION,
    valid: errors.length === 0,
    errors,
    warnings: findings.filter((f) => f.severity === 'warning'),
    info: findings.filter((f) => f.severity === 'info'),
    checks,
    policy,
  };
}
