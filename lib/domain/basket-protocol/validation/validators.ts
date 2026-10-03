import { BasketRecipe, ChainId, MAX_PERFORMANCE_FEE_BPS, RebalanceFrequency, RecipeAsset, STRATEGY_TYPES, SUPPORTED_CHAINS, ValidationIssue, isStrategyType } from '@/types/basket-protocol';
import { VALIDATION_CODES } from './codes';

// -----------------------------------------------------------------------------
// Pure, dependency-free validators. Each function inspects one concern and
// returns the list of issues it found (possibly empty) — `index.ts` composes
// them into `validateBasketRecipe()`. No I/O, no Supabase, no RPC, no wallet:
// same input always produces the same output.
// -----------------------------------------------------------------------------

function issue(
  code: string,
  severity: 'ERROR' | 'WARNING',
  message: string,
  path?: string
): ValidationIssue {
  return { code, severity, message, path };
}

// ----------------------------- 1. Basic metadata --------------------------------

const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 64;

export function validateMetadata(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!recipe.name || recipe.name.trim().length === 0) {
    issues.push(issue(VALIDATION_CODES.INVALID_NAME, 'ERROR', 'Recipe name must not be empty.', 'name'));
  } else if (recipe.name.length > MAX_NAME_LENGTH) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_NAME,
        'ERROR',
        `Recipe name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        'name'
      )
    );
  }

  if (!recipe.symbol || recipe.symbol.trim().length === 0) {
    issues.push(issue(VALIDATION_CODES.INVALID_SYMBOL, 'ERROR', 'Recipe symbol must not be empty.', 'symbol'));
  } else if (recipe.symbol.length > MAX_SYMBOL_LENGTH) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_SYMBOL,
        'ERROR',
        `Recipe symbol must be ${MAX_SYMBOL_LENGTH} characters or fewer.`,
        'symbol'
      )
    );
  } else if (!/^[A-Z0-9._-]+$/i.test(recipe.symbol)) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_SYMBOL,
        'ERROR',
        'Recipe symbol may only contain letters, digits, "." "_" "-".',
        'symbol'
      )
    );
  }

  if (!recipe.description || recipe.description.trim().length === 0) {
    // A missing thesis/description doesn't block deployment — it just makes
    // for a bad Explore-page listing — so this stays a warning, not an error.
    issues.push(
      issue(VALIDATION_CODES.INVALID_DESCRIPTION, 'WARNING', 'Recipe has no description.', 'description')
    );
  }

  if (!SUPPORTED_CHAINS.includes(recipe.chain)) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_CHAIN,
        'ERROR',
        `Chain "${recipe.chain}" is not supported. Supported chains: ${SUPPORTED_CHAINS.join(', ')}.`,
        'chain'
      )
    );
  }

  return issues;
}

// --------------------------- 1b. Strategy type (Phase 11) ------------------------
//
// Closed-set check, same pattern as `validateMetadata`'s chain check below —
// deliberately its own validator (not folded into `validateMetadata`) so a
// future strategy type only ever means widening `STRATEGY_TYPES`
// (types/basket-protocol.ts) plus whatever strategy-specific validators
// that type needs; it never means touching this file's existing checks.

export function validateStrategyType(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isStrategyType(recipe.strategyType)) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_STRATEGY_TYPE,
        'ERROR',
        `"${recipe.strategyType}" is not a supported strategy type. Supported: ${STRATEGY_TYPES.join(', ')}.`,
        'strategyType'
      )
    );
  }

  return issues;
}

// ----------------------------- 2. Assets -----------------------------------------

// Chain-specific address shape checks. Kept minimal on purpose (see Phase 2
// brief: don't attempt full chain-specific validation here) but structured
// as a per-chain lookup so a real `ChainAdapter` (spec section 21) can later
// swap these out for checksum/PDA-aware validation without touching the
// rest of this file.
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Base58, no 0/O/I/l, and roughly the length of a real Solana public key.
// Deliberately loose — this is a shape check, not a curve-point check.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const EVM_CHAINS: ChainId[] = ['ethereum', 'base', 'arbitrum', 'robinhood'];

function isValidAddressForChain(address: string, chain: ChainId): boolean {
  if (EVM_CHAINS.includes(chain)) return EVM_ADDRESS_RE.test(address);
  if (chain === 'solana') return SOLANA_ADDRESS_RE.test(address);
  // Unknown/future chain: no shape rule registered yet — fail closed rather
  // than silently accepting anything.
  return false;
}

const MIN_DECIMALS = 0;
const MAX_DECIMALS = 18;

export function validateAssets(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { assets } = recipe;

  if (assets.length === 0) {
    issues.push(issue(VALIDATION_CODES.NO_ASSETS, 'ERROR', 'A recipe must contain at least one asset.', 'assets'));
    return issues; // nothing further to check
  }

  if (typeof recipe.maxAssets === 'number' && assets.length > recipe.maxAssets) {
    issues.push(
      issue(
        VALIDATION_CODES.TOO_MANY_ASSETS,
        'ERROR',
        `Recipe has ${assets.length} assets, exceeding the maximum of ${recipe.maxAssets}.`,
        'assets'
      )
    );
  }

  if (assets.length === 1) {
    issues.push(
      issue(
        VALIDATION_CODES.LOW_ASSET_COUNT,
        'WARNING',
        'A single-asset basket offers no diversification.',
        'assets'
      )
    );
  }

  const seenSymbols = new Set<string>();
  const seenAddresses = new Set<string>();

  assets.forEach((asset: RecipeAsset, i: number) => {
    const path = `assets[${i}]`;

    const symbolKey = asset.symbol.trim().toUpperCase();
    if (symbolKey && seenSymbols.has(symbolKey)) {
      issues.push(
        issue(VALIDATION_CODES.DUPLICATE_ASSET, 'ERROR', `Asset "${asset.symbol}" appears more than once.`, path)
      );
    }
    seenSymbols.add(symbolKey);

    const addressKey = `${asset.chain}:${asset.address.trim().toLowerCase()}`;
    if (seenAddresses.has(addressKey)) {
      issues.push(
        issue(
          VALIDATION_CODES.DUPLICATE_ASSET_ADDRESS,
          'ERROR',
          `Address "${asset.address}" on ${asset.chain} appears more than once.`,
          `${path}.address`
        )
      );
    }
    seenAddresses.add(addressKey);

    if (asset.chain !== recipe.chain) {
      // Cross-chain baskets aren't modeled yet (see spec section 21 —
      // multi-chain is a later phase with its own ChainAdapter). For now a
      // recipe is single-chain; flag any asset that disagrees.
      issues.push(
        issue(
          VALIDATION_CODES.ASSET_CHAIN_MISMATCH,
          'ERROR',
          `Asset "${asset.symbol}" is on ${asset.chain}, but the recipe is on ${recipe.chain}.`,
          `${path}.chain`
        )
      );
    }

    if (!isValidAddressForChain(asset.address, asset.chain)) {
      issues.push(
        issue(
          VALIDATION_CODES.INVALID_ADDRESS,
          'ERROR',
          `"${asset.address}" is not a valid ${asset.chain} address.`,
          `${path}.address`
        )
      );
    }

    if (
      !Number.isInteger(asset.decimals) ||
      asset.decimals < MIN_DECIMALS ||
      asset.decimals > MAX_DECIMALS
    ) {
      issues.push(
        issue(
          VALIDATION_CODES.INVALID_DECIMALS,
          'ERROR',
          `Decimals for "${asset.symbol}" must be an integer between ${MIN_DECIMALS} and ${MAX_DECIMALS}.`,
          `${path}.decimals`
        )
      );
    }

    if (!Number.isFinite(asset.weightBps) || asset.weightBps <= 0) {
      issues.push(
        issue(
          VALIDATION_CODES.INVALID_WEIGHT,
          'ERROR',
          `Weight for "${asset.symbol}" must be a positive number.`,
          `${path}.weightBps`
        )
      );
    }
  });

  return issues;
}

// ----------------------------- 3. Weight invariants -------------------------------

// Weights are integer basis points (10000 = 100%), so in principle they
// should sum exactly. A small tolerance still absorbs any float→bps
// rounding done upstream (e.g. `bagPositionsToRecipeAssets`, which rounds
// a percentage to the nearest bp) without opening the door to a real
// mis-allocation like 40+30+20=90.
const WEIGHT_SUM_TOLERANCE_BPS = 2;
const TOTAL_WEIGHT_BPS = 10_000;

export function validateWeightInvariants(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validAssets = recipe.assets.filter((a) => Number.isFinite(a.weightBps) && a.weightBps > 0);
  if (validAssets.length === 0) return issues; // already reported by validateAssets

  const total = validAssets.reduce((sum, a) => sum + a.weightBps, 0);
  if (Math.abs(total - TOTAL_WEIGHT_BPS) > WEIGHT_SUM_TOLERANCE_BPS) {
    issues.push(
      issue(
        VALIDATION_CODES.WEIGHTS_NOT_100,
        'ERROR',
        `Asset weights must sum to 100% (${(TOTAL_WEIGHT_BPS / 100).toFixed(2)}%). Got ${(total / 100).toFixed(2)}%.`,
        'assets'
      )
    );
  }

  return issues;
}

// ----------------------------- 4. Min / max weight ---------------------------------

export function validateWeightBounds(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { minWeightBps, maxWeightBps } = recipe;

  if (
    typeof minWeightBps === 'number' &&
    typeof maxWeightBps === 'number' &&
    minWeightBps > maxWeightBps
  ) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_WEIGHT_BOUNDS,
        'ERROR',
        `minWeightBps (${minWeightBps}) cannot be greater than maxWeightBps (${maxWeightBps}).`,
        'minWeightBps'
      )
    );
    return issues; // bounds themselves are broken — don't cascade per-asset noise
  }

  recipe.assets.forEach((asset, i) => {
    const path = `assets[${i}].weightBps`;
    if (!Number.isFinite(asset.weightBps) || asset.weightBps <= 0) return; // reported by validateAssets

    if (typeof minWeightBps === 'number' && asset.weightBps < minWeightBps) {
      issues.push(
        issue(
          VALIDATION_CODES.BELOW_MIN_WEIGHT,
          'ERROR',
          `"${asset.symbol}" weight (${(asset.weightBps / 100).toFixed(2)}%) is below the minimum of ${(minWeightBps / 100).toFixed(2)}%.`,
          path
        )
      );
    }
    if (typeof maxWeightBps === 'number' && asset.weightBps > maxWeightBps) {
      issues.push(
        issue(
          VALIDATION_CODES.ABOVE_MAX_WEIGHT,
          'ERROR',
          `"${asset.symbol}" weight (${(asset.weightBps / 100).toFixed(2)}%) exceeds the maximum of ${(maxWeightBps / 100).toFixed(2)}%.`,
          path
        )
      );
    }
  });

  return issues;
}

// ----------------------------- 5. Rebalance rule ------------------------------------

const VALID_FREQUENCIES: RebalanceFrequency[] = ['MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY', 'THRESHOLD_ONLY'];

export function validateRebalanceRule(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rule = recipe.rebalanceRule;

  if (!rule) {
    // Shouldn't happen given the type, but recipes may be built from
    // untyped/external input (API payloads, on-chain reads) at runtime.
    issues.push(
      issue(VALIDATION_CODES.INVALID_REBALANCE_FREQUENCY, 'ERROR', 'Recipe is missing a rebalance rule.', 'rebalanceRule')
    );
    return issues;
  }

  if (!VALID_FREQUENCIES.includes(rule.frequency)) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_REBALANCE_FREQUENCY,
        'ERROR',
        `"${rule.frequency}" is not a valid rebalance frequency.`,
        'rebalanceRule.frequency'
      )
    );
  }

  if (
    !Number.isFinite(rule.driftThresholdBps) ||
    rule.driftThresholdBps < 0 ||
    rule.driftThresholdBps > TOTAL_WEIGHT_BPS
  ) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_DRIFT_THRESHOLD,
        'ERROR',
        'Drift threshold must be between 0% and 100%.',
        'rebalanceRule.driftThresholdBps'
      )
    );
  }

  if (
    !Number.isFinite(rule.maxSlippageBps) ||
    rule.maxSlippageBps < 0 ||
    rule.maxSlippageBps > TOTAL_WEIGHT_BPS
  ) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_SLIPPAGE,
        'ERROR',
        'Max slippage must be between 0% and 100%.',
        'rebalanceRule.maxSlippageBps'
      )
    );
  }

  if (
    rule.frequency === 'MANUAL' &&
    Number.isFinite(rule.driftThresholdBps) &&
    rule.driftThresholdBps > 0 &&
    rule.driftThresholdBps < TOTAL_WEIGHT_BPS
  ) {
    // Not a contradiction worth blocking on — a manual-frequency rule can
    // still carry a threshold for informational/future use — but worth
    // surfacing since it does nothing today.
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_REBALANCE_FREQUENCY,
        'WARNING',
        'Rebalance frequency is MANUAL — the configured drift threshold will never trigger automatically.',
        'rebalanceRule'
      )
    );
  }

  return issues;
}

// ----------------------------- Other light checks -----------------------------------

export function validateEconomics(recipe: BasketRecipe): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Number.isFinite(recipe.minInvestment) || recipe.minInvestment < 0) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_MIN_INVESTMENT,
        'ERROR',
        'Minimum investment must be zero or a positive number.',
        'minInvestment'
      )
    );
  }

  // Phase 22 — performanceFeeBps is optional (0 = no fee, valid), but if set
  // must be a non-negative integer within MAX_PERFORMANCE_FEE_BPS. See
  // types/basket-protocol.ts's Phase 22 doc block for why 0 is valid and
  // what the cap protects against.
  if (
    recipe.performanceFeeBps !== undefined &&
    (!Number.isInteger(recipe.performanceFeeBps) || recipe.performanceFeeBps < 0 || recipe.performanceFeeBps > MAX_PERFORMANCE_FEE_BPS)
  ) {
    issues.push(
      issue(
        VALIDATION_CODES.INVALID_PERFORMANCE_FEE,
        'ERROR',
        `Performance fee must be a whole number of basis points between 0 and ${MAX_PERFORMANCE_FEE_BPS} (${MAX_PERFORMANCE_FEE_BPS / 100}%).`,
        'performanceFeeBps'
      )
    );
  }

  return issues;
}
