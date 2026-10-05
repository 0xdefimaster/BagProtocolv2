-- 0053_redeem_settlement_plan.sql
--
-- Two-phase settlement attestation (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §9): phase 1 quotes the sale,
-- checks price quality and records the plan it checked (the settlement context hash, the executor, the user's
-- floor, the plan's expiry); phase 2 re-reads the state, refuses unless it still hashes to the same context, and
-- only then signs. The plan is server-written only and never accepted from a client.
alter table redeem_intents
  add column if not exists settlement_plan jsonb;
