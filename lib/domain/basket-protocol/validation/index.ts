import { BasketRecipe, ValidationIssue, ValidationResult } from '@/types/basket-protocol';
import { validateAssets, validateEconomics, validateMetadata, validateRebalanceRule, validateStrategyType, validateWeightBounds, validateWeightInvariants } from './validators';

// -----------------------------------------------------------------------------
// `validateBasketRecipe()` — the single entry point Phase 3+ (Create Bag flow,
// Bag Factory, backend API route) is meant to call. Pure and dependency-free:
// same `BasketRecipe` in, same `ValidationResult` out, every time. No
// Solidity/RPC/Supabase/API involved — this is domain validation only. See
// spec section 4: "Validation should exist at multiple layers: frontend,
// backend, smart contract. Never trust frontend validation alone" — this
// function is written so it can run unmodified in all three:
//   - directly in a React component (frontend)
//   - in an API route handler before writing to Supabase (backend)
//   - ported/mirrored into Solidity for the on-chain invariant checks in the
//     Bag Factory (Phase 4) — the rules here are the source of truth for what
//     that Solidity should also enforce.
// -----------------------------------------------------------------------------

const VALIDATORS: Array<(recipe: BasketRecipe) => ValidationIssue[]> = [
  validateMetadata,
  validateStrategyType,
  validateAssets,
  validateWeightInvariants,
  validateWeightBounds,
  validateRebalanceRule,
  validateEconomics,
];

export function validateBasketRecipe(recipe: BasketRecipe): ValidationResult {
  const issues = VALIDATORS.flatMap((validator) => validator(recipe));
  const valid = !issues.some((i) => i.severity === 'ERROR');
  return { valid, issues };
}

/** Convenience filters — UI code reaches for these instead of re-filtering `issues` inline. */
export function getErrors(result: ValidationResult): ValidationIssue[] {
  return result.issues.filter((i) => i.severity === 'ERROR');
}

export function getWarnings(result: ValidationResult): ValidationIssue[] {
  return result.issues.filter((i) => i.severity === 'WARNING');
}

export { VALIDATION_CODES } from './codes';
export type { ValidationCode } from './codes';
export * from './validators';
// Phase 5 — external Asset Registry validation. Kept as a separate export,
// NOT part of `VALIDATORS` above — see registry-validation.ts's module doc.
export * from './registry-validation';
