// -----------------------------------------------------------------------------
// lib/config/execution.ts
//
// `BAG_EXECUTION_COMPILER_ENABLED` — server-side feature flag gating whether
// `lib/server/purchase-execution.ts`'s `createPurchaseIntentForUser()` routes
// a deposit's SWAP steps through the new `compileBagExecution()` layer
// (lib/execution/) or keeps using the pre-existing `buildPurchaseIntentSteps()`
// path directly. OFF by default — every existing deployment, and every
// existing test that doesn't explicitly set this env var, keeps running the
// exact legacy path unchanged.
//
// Read via `process.env` at CALL time (not cached at module load), the same
// convention `process.env.LIFI_API_KEY` already uses in purchase-execution.ts
// — so a test can toggle it per-case with `vi.stubEnv()`/direct assignment
// without needing to re-import the module.
// -----------------------------------------------------------------------------

export function isBagExecutionCompilerEnabled(): boolean {
  return process.env.BAG_EXECUTION_COMPILER_ENABLED === 'true';
}
