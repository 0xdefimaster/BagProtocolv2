import { keccak256, stringToHex } from 'viem';
import type { BasketRecipe } from '@/types/basket-protocol';
import { BAG_JSON_HASH_DOMAIN, BagAssetDisplay, BagDefinition, BagDefinitionAsset } from '@/types/strategy';
import { normalizeAssetAddress } from './asset-identity';

// -----------------------------------------------------------------------------
// bag.json v1: building a definition from a stored recipe, canonicalizing it
// and hashing it. Pure; no I/O. Spec: docs/BAG_JSON_V1_DESIGN.md §3–4.
//
// Unlike `canonicalCompositionString` (on-chain compositionHash: addresses as
// stored, `localeCompare` order), this canonical form is reproducible by
// anyone: lowercase EVM addresses, code-unit ordering, RFC 8785 serialization.
// -----------------------------------------------------------------------------

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the JSON values bag.json uses:
 * object keys sorted by UTF-16 code units, no whitespace, strings and numbers
 * serialized as ECMAScript JSON.stringify does. Refuses values JSON cannot
 * represent instead of dropping them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => {
          if (obj[k] === undefined) throw new Error(`canonicalJson: "${k}" is undefined.`);
          return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
        })
        .join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}.`);
  }
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical copy of a definition: normalized addresses, assets in (chain, address) order. Idempotent. */
export function normalizeDefinition(def: BagDefinition): BagDefinition {
  const assets: BagDefinitionAsset[] = def.assets
    .map((a) => ({ chain: a.chain, address: normalizeAssetAddress(a.chain, a.address), decimals: a.decimals, weightBps: a.weightBps }))
    .sort((a, b) => byCodeUnits(a.chain, b.chain) || byCodeUnits(a.address, b.address));
  const r = def.rules;
  return {
    kind: def.kind,
    chain: def.chain,
    mutability: def.mutability,
    assets,
    rules: {
      weightBounds: { minBps: r.weightBounds.minBps, maxBps: r.weightBounds.maxBps },
      maxAssets: r.maxAssets,
      minInvestment: r.minInvestment ? { amount: r.minInvestment.amount, measuredAs: r.minInvestment.measuredAs } : null,
      swapSlippageBps: r.swapSlippageBps,
      rebalance: r.rebalance ? { frequency: r.rebalance.frequency, driftThresholdBps: r.rebalance.driftThresholdBps } : null,
      performanceFeeBps: r.performanceFeeBps,
      noRouteAssetPolicy: r.noRouteAssetPolicy,
    },
  };
}

/** The exact string the hash covers: domain prefix + JCS of the normalized definition. */
export function definitionHashPreimage(def: BagDefinition): string {
  return BAG_JSON_HASH_DOMAIN + canonicalJson(normalizeDefinition(def));
}

export function computeDefinitionHash(def: BagDefinition): string {
  return keccak256(stringToHex(definitionHashPreimage(def)));
}

/** Plain decimal string for a stored number (never exponent notation). Null if it is not a finite, non-negative number. */
export function decimalString(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const s = String(n);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  // Shift the decimal point of the shortest round-trip digits: exact, no rounding.
  const digits = m[1] + (m[2] ?? '');
  const point = 1 + Number(m[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

const intOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/**
 * The definition a stored recipe commits to.
 *
 * `null` means "not set by the creator in this version": the field is absent from the stored recipe. It is
 * never replaced by today's default (the policy view says which default applies), so a stored version's
 * hash never moves when a default changes. An explicit value, including 0 where 0 is valid (e.g.
 * `performanceFeeBps: 0`), is kept as is and hashes differently from `null`.
 *
 * One normalization: `swapSlippageBps` is `null` unless the recipe's `rebalanceRule.maxSlippageBps` is a
 * positive number. 0 or a negative value is not a usable slippage (recipe validation rejects it, and
 * `deriveStrategyPolicy` applies the protocol default instead), so it is recorded as "not set".
 */
export function definitionFromRecipe(recipe: Partial<BasketRecipe> & Pick<BasketRecipe, 'chain' | 'assets'>): BagDefinition {
  const rr = recipe.rebalanceRule;
  const slippage = rr?.maxSlippageBps;
  const minInvestment = decimalString(recipe.minInvestment);
  return normalizeDefinition({
    kind: recipe.strategyType ?? null,
    chain: recipe.chain,
    mutability: recipe.mutability ?? null,
    assets: recipe.assets.map((a) => ({ chain: a.chain, address: a.address, decimals: a.decimals, weightBps: a.weightBps })),
    rules: {
      weightBounds: { minBps: intOrNull(recipe.minWeightBps), maxBps: intOrNull(recipe.maxWeightBps) },
      maxAssets: intOrNull(recipe.maxAssets),
      minInvestment: minInvestment === null ? null : { amount: minInvestment, measuredAs: 'PAYMENT_TOKEN_AMOUNT' },
      swapSlippageBps: typeof slippage === 'number' && Number.isFinite(slippage) && slippage > 0 ? slippage : null,
      rebalance: rr ? { frequency: rr.frequency ?? null, driftThresholdBps: intOrNull(rr.driftThresholdBps) } : null,
      performanceFeeBps: intOrNull(recipe.performanceFeeBps),
      noRouteAssetPolicy: recipe.unroutablePolicy ?? null,
    },
  });
}

/** Display names of the recipe's assets, in definition order. Not part of the definition or its hash. */
export function assetDisplayFromRecipe(recipe: Pick<BasketRecipe, 'assets'>): BagAssetDisplay[] {
  return recipe.assets
    .map((a) => ({ chain: a.chain, address: normalizeAssetAddress(a.chain, a.address), symbol: a.symbol }))
    .sort((a, b) => byCodeUnits(a.chain, b.chain) || byCodeUnits(a.address, b.address));
}
