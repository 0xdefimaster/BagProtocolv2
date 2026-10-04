-- 0047_redeem_composer_transaction.sql
--
-- Adds `composer_transaction` (nullable jsonb) to `redeem_intents`, the
-- redemption counterpart of 0021 on `purchase_intents`.
--
-- Why: a redemption without a performance fee (and with no RedeemFeeRouter
-- configured) can now sell every leg in ONE LI.FI Composer transaction
-- (lib/server/redeem-composer.ts) instead of one LI.FI route per asset. That
-- transaction ({ to, data, value, chainId, approvals }) is stored here between
-- intent creation and signing, and verification checks the reported hash
-- against exactly this sender/target/calldata/value.
--
-- Null for every existing row and every per-asset redemption. The application
-- only writes the column when it is set, so per-asset redemptions keep working
-- on a database where this has not been run yet. Safe to run more than once.

alter table redeem_intents
  add column if not exists composer_transaction jsonb;
