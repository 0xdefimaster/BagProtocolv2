-- 0023_add_execution_mode.sql
--
-- Adds `execution_mode` (nullable text) to `purchase_intents`.
--
-- Why (item 8 — UI signaling): `compileBagExecution()` already produces a
-- `CompiledExecution.mode` (`SINGLE_TX` / `MULTI_TX` / `CROSS_CHAIN` /
-- `UNSUPPORTED`, lib/execution/types.ts) describing what the compiled
-- execution ACTUALLY requires from the wallet — but until now that value
-- was computed and then discarded at `compiledExecutionToPurchaseIntentSteps()`,
-- so nothing downstream could ever see it. The purchase UI consequently
-- told every user the same thing ("signs and sends a real transaction",
-- singular) whether the compiled result was one Composer transaction or a
-- sequential LI.FI plan needing an approval plus a swap per leg. That is
-- the specific dishonesty `ExecutionMode`'s own doc calls out: "never let
-- the UI say '1 signature' when the compiled result is actually MULTI_TX".
--
-- This column is where the compiled mode is persisted so the intent the
-- browser already fetches carries it, no new endpoint required.
--
-- Null for every existing row and for every intent created while
-- `BAG_EXECUTION_COMPILER_ENABLED` is off (lib/config/execution.ts) — the
-- legacy path has no `CompiledExecution` to take a mode from. The UI
-- treats null as "unknown", and falls back to describing the expectation
-- from the intent's own steps rather than asserting a count it cannot
-- know (see lib/execution/signing-expectation.ts). Nothing to backfill:
-- a legacy intent genuinely never had a compiler-determined mode.

alter table purchase_intents
  add column if not exists execution_mode text;
