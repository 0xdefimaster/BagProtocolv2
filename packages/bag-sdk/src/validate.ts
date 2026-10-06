import { chainIdOf, normalizeAddress, type BagChain } from './chains';
import { computeDefinitionHash, normalizeDefinition } from './definition';
import type { BagDocument, BagIssue, Hex } from './types';

// -----------------------------------------------------------------------------
// validateBag: the rules a parsed bag.json v1 document must satisfy. Pure and
// deterministic: same document (and same token list) → same result, findings
// in a fixed order. Never touches the network.
//
// Mirrors the rules BAG applies when a version is created (weights, bounds,
// duplicates, decimals, fee cap, slippage and drift ranges), with the v1
// defaults below used ONLY to check a `null` ("not set") rule; they are never
// written into the document or the hash.
//
// Not here, on purpose: BAG's asset allowlist, routes, prices, price impact
// and deposit size. Those depend on the market or on a deployment and belong
// to quoting/compiling, not to the artifact.
// -----------------------------------------------------------------------------

/** Frozen with v1. What a `null` rule is checked against; changing one is a spec change (bag.json/v2). */
export const V1_RULE_DEFAULTS = Object.freeze({
  minWeightBps: 100,
  maxWeightBps: 7000,
  /** `maxAssets: null` allows max(asset count, 10), capped by MAX_ASSETS. */
  maxAssetsFloor: 10,
});

export const V1_LIMITS = Object.freeze({
  TOTAL_WEIGHT_BPS: 10_000,
  /** Weights must sum to 10000 bps ± this (BAG's rule since v1, for UI rounding). */
  WEIGHT_SUM_TOLERANCE_BPS: 2,
  MAX_ASSETS: 100,
  MIN_DECIMALS: 0,
  MAX_DECIMALS: 18,
  MAX_PERFORMANCE_FEE_BPS: 3000,
});

/** What the caller knows about a token (e.g. read with `readTokenDecimals`). */
export interface TokenInfo {
  chain: BagChain;
  address: string;
  decimals: number;
}

export interface ValidateBagOptions {
  /**
   * Token decimals to check the declared ones against. Without it the decimals are only range-checked and a
   * DECIMALS_NOT_CHECKED warning says so.
   */
  tokens?: TokenInfo[];
}

export interface BagValidation {
  valid: boolean;
  /** Recomputed from the definition. Says nothing about validity on its own. */
  definitionHash: Hex;
  errors: BagIssue[];
  warnings: BagIssue[];
}

const key = (chain: string, address: string) => `${chain}:${normalizeAddress(address)}`;
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const inRange = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

export function validateBag(bag: BagDocument, options: ValidateBagOptions = {}): BagValidation {
  const issues: BagIssue[] = [];
  const err = (code: string, path: string, message: string) => issues.push({ code, severity: 'error', path, message });
  const warn = (code: string, path: string, message: string) => issues.push({ code, severity: 'warning', path, message });

  const d = bag.definition;
  const r = d.rules;
  const L = V1_LIMITS;
  const definitionHash = computeDefinitionHash(d);

  // ---- assets ----
  if (d.assets.length === 0) err('NO_ASSETS', 'definition.assets', 'A strategy needs at least one asset.');
  if (d.assets.length === 1) warn('LOW_ASSET_COUNT', 'definition.assets', 'A single-asset basket offers no diversification.');
  if (d.assets.length > L.MAX_ASSETS) err('TOO_MANY_ASSETS', 'definition.assets', `At most ${L.MAX_ASSETS} assets.`);

  const seen = new Set<string>();
  d.assets.forEach((a, i) => {
    const p = `definition.assets[${i}]`;
    if (a.chain !== d.chain) err('ASSET_CHAIN_MISMATCH', `${p}.chain`, `Asset is on ${a.chain}; a v1 strategy holds assets of its own chain (${d.chain}) only.`);
    const k = key(a.chain, a.address);
    if (seen.has(k)) err('DUPLICATE_ASSET', `${p}.address`, `${k} appears more than once (identity is chain + address, case-insensitive).`);
    seen.add(k);
    if (!inRange(a.decimals, L.MIN_DECIMALS, L.MAX_DECIMALS)) err('INVALID_DECIMALS', `${p}.decimals`, `decimals must be an integer from ${L.MIN_DECIMALS} to ${L.MAX_DECIMALS}.`);
    if (!inRange(a.weightBps, 1, L.TOTAL_WEIGHT_BPS)) err('INVALID_WEIGHT', `${p}.weightBps`, `weightBps must be an integer from 1 to ${L.TOTAL_WEIGHT_BPS}.`);
  });

  const total = d.assets.reduce((s, a) => s + (a.weightBps > 0 ? a.weightBps : 0), 0);
  if (d.assets.length > 0 && Math.abs(total - L.TOTAL_WEIGHT_BPS) > L.WEIGHT_SUM_TOLERANCE_BPS) {
    err('WEIGHTS_NOT_100', 'definition.assets', `Weights sum to ${total} bps; they must sum to ${L.TOTAL_WEIGHT_BPS} (± ${L.WEIGHT_SUM_TOLERANCE_BPS}).`);
  }

  // ---- token decimals (only against what the caller supplied) ----
  if (options.tokens) {
    const known = new Map(options.tokens.map((t) => [key(t.chain, t.address), t.decimals] as const));
    d.assets.forEach((a, i) => {
      const actual = known.get(key(a.chain, a.address));
      if (actual === undefined) warn('DECIMALS_NOT_CHECKED', `definition.assets[${i}].decimals`, `No token information for ${key(a.chain, a.address)}.`);
      else if (actual !== a.decimals) err('DECIMALS_MISMATCH', `definition.assets[${i}].decimals`, `Declares ${a.decimals} decimals; the token has ${actual}.`);
    });
  } else if (d.assets.length > 0) {
    warn('DECIMALS_NOT_CHECKED', 'definition.assets', 'Declared decimals were not compared with the tokens (pass `tokens`).');
  }

  // ---- rules ----
  const wb = r.weightBounds;
  if (wb.minBps !== null && !inRange(wb.minBps, 0, L.TOTAL_WEIGHT_BPS)) err('INVALID_RULE_VALUE', 'definition.rules.weightBounds.minBps', `minBps must be from 0 to ${L.TOTAL_WEIGHT_BPS}.`);
  if (wb.maxBps !== null && !inRange(wb.maxBps, 1, L.TOTAL_WEIGHT_BPS)) err('INVALID_RULE_VALUE', 'definition.rules.weightBounds.maxBps', `maxBps must be from 1 to ${L.TOTAL_WEIGHT_BPS}.`);
  const minBps = wb.minBps ?? V1_RULE_DEFAULTS.minWeightBps;
  const maxBps = wb.maxBps ?? V1_RULE_DEFAULTS.maxWeightBps;
  if (minBps > maxBps) {
    err('INVALID_WEIGHT_BOUNDS', 'definition.rules.weightBounds', `minBps (${minBps}) is greater than maxBps (${maxBps}).`);
  } else {
    d.assets.forEach((a, i) => {
      if (a.weightBps <= 0) return;
      const src = (declared: number | null) => (declared === null ? ' (v1 default; not set in the definition)' : '');
      if (a.weightBps < minBps) err('BELOW_MIN_WEIGHT', `definition.assets[${i}].weightBps`, `${a.weightBps} bps is below the minimum ${minBps}${src(wb.minBps)}.`);
      if (a.weightBps > maxBps) err('ABOVE_MAX_WEIGHT', `definition.assets[${i}].weightBps`, `${a.weightBps} bps is above the maximum ${maxBps}${src(wb.maxBps)}.`);
    });
  }

  if (r.maxAssets !== null) {
    if (!inRange(r.maxAssets, 1, L.MAX_ASSETS)) err('INVALID_RULE_VALUE', 'definition.rules.maxAssets', `maxAssets must be from 1 to ${L.MAX_ASSETS}.`);
    else if (d.assets.length > r.maxAssets) err('TOO_MANY_ASSETS', 'definition.assets', `${d.assets.length} assets; the definition allows ${r.maxAssets}.`);
  }

  // 0 is not a usable slippage: BAG records it as null ("not set"), so a definition never carries 0.
  if (r.swapSlippageBps !== null && !inRange(r.swapSlippageBps, 1, L.TOTAL_WEIGHT_BPS)) {
    err('INVALID_SLIPPAGE', 'definition.rules.swapSlippageBps', `swapSlippageBps must be from 1 to ${L.TOTAL_WEIGHT_BPS}, or null.`);
  }
  if (r.rebalance) {
    const drift = r.rebalance.driftThresholdBps;
    if (drift !== null && !inRange(drift, 0, L.TOTAL_WEIGHT_BPS)) err('INVALID_DRIFT_THRESHOLD', 'definition.rules.rebalance.driftThresholdBps', `driftThresholdBps must be from 0 to ${L.TOTAL_WEIGHT_BPS}.`);
    if (r.rebalance.frequency === 'MANUAL' && drift !== null && drift > 0 && drift < L.TOTAL_WEIGHT_BPS) {
      warn('DRIFT_NEVER_TRIGGERS', 'definition.rules.rebalance', 'Frequency is MANUAL: the drift threshold never triggers a rebalance.');
    }
  }
  if (r.performanceFeeBps !== null && !inRange(r.performanceFeeBps, 0, L.MAX_PERFORMANCE_FEE_BPS)) {
    err('INVALID_PERFORMANCE_FEE', 'definition.rules.performanceFeeBps', `performanceFeeBps must be from 0 to ${L.MAX_PERFORMANCE_FEE_BPS}, or null.`);
  }

  // ---- the document around the definition (none of it is hashed) ----
  if (bag.definitionHash !== undefined && bag.definitionHash.toLowerCase() !== definitionHash) {
    err('DEFINITION_HASH_MISMATCH', 'definitionHash', `States ${bag.definitionHash}; the definition hashes to ${definitionHash}.`);
  }
  if (bag.network && bag.network.chainId !== chainIdOf(d.chain)) {
    err('NETWORK_MISMATCH', 'network.chainId', `${d.chain} is chain id ${chainIdOf(d.chain)}, not ${bag.network.chainId}.`);
  }
  if (bag.ref) {
    const expected = bag.ref.version === 1 ? null : bag.ref.version - 1;
    if (bag.ref.parentVersion !== expected) {
      err('INVALID_PARENT_VERSION', 'ref.parentVersion', `Version ${bag.ref.version}'s parent is ${expected === null ? 'null (first version)' : `version ${expected}`}; versions are contiguous within a strategy.`);
    }
    if (bag.forkedFrom && bag.forkedFrom.strategyId === bag.ref.strategyId) {
      err('SELF_FORK', 'forkedFrom.strategyId', 'A fork is a different strategy than its parent.');
    }
  }
  if (bag.metadata) {
    const defined = new Set(normalizeDefinition(d).assets.map((a) => key(a.chain, a.address)));
    const named = new Set<string>();
    bag.metadata.assets.forEach((a, i) => {
      const k = key(a.chain, a.address);
      if (!defined.has(k)) err('METADATA_ASSET_UNKNOWN', `metadata.assets[${i}]`, `${k} is not an asset of the definition.`);
      if (named.has(k)) err('DUPLICATE_ASSET', `metadata.assets[${i}]`, `${k} is named more than once.`);
      named.add(k);
    });
  }

  issues.sort((a, b) => byCodeUnits(a.path, b.path) || byCodeUnits(a.code, b.code));
  const errors = issues.filter((i) => i.severity === 'error');
  return { valid: errors.length === 0, definitionHash, errors, warnings: issues.filter((i) => i.severity === 'warning') };
}
