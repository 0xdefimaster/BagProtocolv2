-- 0041_purchase_intent_fallback.sql
--
-- Adds `fallback` (nullable jsonb) to `purchase_intents`: the creator's
-- unroutable-asset policy as it was applied to THIS purchase (see
-- `UNROUTABLE_POLICIES` in types/basket-protocol.ts and
-- lib/domain/basket-protocol/deposit/unroutable.ts):
--
--   { "policy": "HOLD_INPUT" | "REFUND",
--     "assets": [{ "chain", "address", "symbol" }],   -- assets held/refunded
--     "unroutableWeightBps": 1200,
--     "amountScaleBps": 10000 | 8800,                  -- REFUND spends less
--     "requestedAmountRaw": "100000000",               -- what the buyer typed
--     "inputSymbol": "USDG", "inputDecimals": 6 }
--
-- prepareExecution() re-derives the same effective recipe from this record,
-- so the plan fingerprint check keeps working for partial purchases. Null for
-- every purchase where all assets were routable (and every existing row).
-- Safe to run more than once.

alter table purchase_intents
  add column if not exists fallback jsonb;

notify pgrst, 'reload schema';
