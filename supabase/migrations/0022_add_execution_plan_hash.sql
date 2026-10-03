-- 0022_add_execution_plan_hash.sql
--
-- Adds `execution_plan_hash` (nullable text) to `purchase_intents`.
--
-- Why: lib/execution/compiler.ts's `compileBagExecution()` stamps every
-- `CompiledExecution` with a sha256 `executionPlanHash`
-- (lib/execution/plan.ts's `computeBagExecutionGraphHash()`) — a
-- fingerprint of the provider-independent `BagExecutionGraph` a purchase
-- was actually compiled from. This column is where that value is
-- persisted so `prepareExecution()` (lib/server/purchase-execution.ts) can
-- re-derive the CURRENT graph's hash at execute time and compare, the
-- same integrity pattern `route_fingerprint` (0004_add_purchase_intents.sql)
-- already established for the pre-compiler `ExecutionPlan` shape — this is
-- the compiler-layer equivalent, not a replacement for it. Both checks run
-- side by side when the new layer is active; `route_fingerprint`'s check
-- alone already protects every legacy (flag-off) intent exactly as before.
--
-- Null for every existing row and for every intent created while
-- `BAG_EXECUTION_COMPILER_ENABLED` is off (lib/config/execution.ts) — the
-- legacy path never had a `BagExecutionGraph` to hash in the first place.
-- `prepareExecution()` only runs the new mismatch check when this column
-- is non-null on the intent being executed, so a null value is the normal
-- case for the legacy path, not a migration gap to backfill.

alter table purchase_intents
  add column if not exists execution_plan_hash text;
