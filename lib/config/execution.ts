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

/**
 * `BAG_WALLET_BATCH_BINDING` — how a Composer purchase, sale or rebalance transaction that a smart-account wallet
 * (EIP-7702) sent as a batch is bound to the call BAG built (lib/blockchain/composer-status.ts):
 *
 * - `off` (default; also any unset or unknown value): unchanged legacy binding, calldata containment. Known gaps
 *   T-1 (other calls in the batch are credited) and F-01 (a DelegationManager address is not checked).
 * - `shadow`: the legacy verdict still decides; the exact binding (@bagprotocol/sdk wallet-envelope) runs beside it,
 *   with its historical state reads, and one `[wallet-binding-shadow]` log line records whether they agree.
 * - `enforce`: the exact binding decides. Unreadable historical state keeps the transaction pending, never passes.
 *
 * Read at call time, like the flag above.
 */
export type WalletBatchBindingMode = 'off' | 'shadow' | 'enforce';

export function walletBatchBindingMode(): WalletBatchBindingMode {
  const value = (process.env.BAG_WALLET_BATCH_BINDING ?? '').trim().toLowerCase();
  return value === 'shadow' || value === 'enforce' ? value : 'off';
}
