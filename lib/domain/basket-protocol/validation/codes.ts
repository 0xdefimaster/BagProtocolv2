// -----------------------------------------------------------------------------
// Centralized validation codes for `validateBasketRecipe()`. No component or
// validator should write a raw string literal for a code — import from here,
// so every place that ever needs to branch on "which rule failed" (UI error
// banners, tests, future backend/contract-layer validation) has one source
// of truth for the string contract.
// -----------------------------------------------------------------------------

export const VALIDATION_CODES = {
  // Metadata
  INVALID_NAME: 'INVALID_NAME',
  INVALID_SYMBOL: 'INVALID_SYMBOL',
  INVALID_DESCRIPTION: 'INVALID_DESCRIPTION',
  INVALID_CHAIN: 'INVALID_CHAIN',
  // Phase 11 — strategy type is closed to `STRATEGY_TYPES` (types/basket-protocol.ts).
  INVALID_STRATEGY_TYPE: 'INVALID_STRATEGY_TYPE',

  // Assets
  NO_ASSETS: 'NO_ASSETS',
  TOO_MANY_ASSETS: 'TOO_MANY_ASSETS',
  DUPLICATE_ASSET: 'DUPLICATE_ASSET',
  DUPLICATE_ASSET_ADDRESS: 'DUPLICATE_ASSET_ADDRESS',
  ASSET_CHAIN_MISMATCH: 'ASSET_CHAIN_MISMATCH',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_DECIMALS: 'INVALID_DECIMALS',
  INVALID_WEIGHT: 'INVALID_WEIGHT',

  // Weight invariants
  WEIGHTS_NOT_100: 'WEIGHTS_NOT_100',
  BELOW_MIN_WEIGHT: 'BELOW_MIN_WEIGHT',
  ABOVE_MAX_WEIGHT: 'ABOVE_MAX_WEIGHT',
  INVALID_WEIGHT_BOUNDS: 'INVALID_WEIGHT_BOUNDS',

  // Rebalance rule
  INVALID_REBALANCE_FREQUENCY: 'INVALID_REBALANCE_FREQUENCY',
  INVALID_DRIFT_THRESHOLD: 'INVALID_DRIFT_THRESHOLD',
  INVALID_SLIPPAGE: 'INVALID_SLIPPAGE',

  // Other recipe-level fields (light checks, non-blocking by default)
  INVALID_MIN_INVESTMENT: 'INVALID_MIN_INVESTMENT',
  LOW_ASSET_COUNT: 'LOW_ASSET_COUNT',
  // Phase 22 — performance fee cap (types/basket-protocol.ts's MAX_PERFORMANCE_FEE_BPS).
  INVALID_PERFORMANCE_FEE: 'INVALID_PERFORMANCE_FEE',

  // Asset Registry (Phase 5) — external validation, NOT part of the pure
  // `VALIDATORS` array in ./index.ts. See ./registry-validation.ts.
  ASSET_NOT_VERIFIED: 'ASSET_NOT_VERIFIED',
} as const;

export type ValidationCode = (typeof VALIDATION_CODES)[keyof typeof VALIDATION_CODES];
