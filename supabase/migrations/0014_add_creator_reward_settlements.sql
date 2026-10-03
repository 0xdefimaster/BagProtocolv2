-- 0014_add_creator_reward_settlements.sql
--
-- Upgrades creator rewards from "activities row = paper ledger credit"
-- (0013) to an explicit on-chain settlement lifecycle. A row in
-- `activities` (FORK_ROYALTY_EARNED / PERFORMANCE_FEE_EARNED) was never
-- proof that real USDG sits in CreatorRewardsVault
-- (contracts/CreatorRewardsVault.sol) — this table is what closes that
-- gap, one row per reward event, tracked from EARNED through to
-- CONFIRMED on-chain (or FAILED/CANCELLED).
--
-- Two settlement paths write into this table (see
-- lib/server/creator-rewards-settlement.ts and
-- contracts/RedeemFeeRouter.sol):
--   1. Fork royalty (purchase-time): still resolved by the cross-chain
--      LI.FI purchase flow, so it cannot yet be made atomic with the
--      user's own purchase transaction (see that file's doc block for
--      why). Settlement worker picks up EARNED rows and submits a
--      `CreatorRewardsVault.settleReward` transaction after the fact —
--      still idempotent (refId = deterministic hash of this row's id),
--      never a second charge to the user, but not single-signature.
--   2. Performance fee (redeem-time): settled ATOMICALLY by
--      RedeemFeeRouter in the same transaction as the user's own redeem
--      swap. For this path, a row here is inserted ALREADY confirmed
--      (status starts at 'CONFIRMED', on_chain_tx_hash populated) by the
--      route handler once RedeemFeeRouter's `Redeemed` event is observed
--      — never a naive "we asked the router, so the creator must have
--      been paid" assumption; the caller must have the transaction
--      receipt with the matching event in hand.
--
-- Legacy note: rewards recorded ONLY in `activities` before this
-- migration (see 0013) are NOT retroactively considered settled. See
-- docs/CREATOR_REWARDS_SETTLEMENT.md "historical rewards" section for the
-- explicit, one-time, idempotent migration process required before any
-- of that legacy balance could become claimable on-chain. This migration
-- does not perform that backfill — doing so automatically would be
-- exactly the "pretend a database row is money" failure this table
-- exists to prevent.

create table if not exists creator_reward_settlements (
  id uuid primary key default gen_random_uuid(),

  -- Who earned it and for which bag/reward type — same shape as the
  -- 0013 activities encoding, but now structured columns instead of a
  -- colon-joined string, so the settlement worker doesn't need to
  -- re-parse `activities.action`.
  creator_id uuid not null references users(id),
  creator_wallet text not null, -- snapshot of users.wallet_address AT THE TIME this row was created — see "wallet changes" note below
  bag_id uuid not null references bags(id),
  reward_type text not null check (reward_type in ('FORK_ROYALTY', 'PERFORMANCE_FEE')),

  -- The exact off-chain event this settlement is FOR — never a second,
  -- independently-computed value. One of these two is set depending on
  -- reward_type; enforced by the check constraint below.
  source_activity_id uuid references activities(id),
  source_redeem_intent_id uuid references redeem_intents(id),

  -- Money, in both units — see lib/config/robinhood-chain.ts's
  -- quoteDecimalToRewardTokenRaw/rewardTokenRawToQuoteDecimal for the
  -- ONLY sanctioned conversion between them. Never derive one from the
  -- other with floating point at read time.
  gross_amount_quote text not null, -- decimal string, same convention as activities.action's amount
  reward_amount_token_raw text not null, -- raw USDG base units, as decimal text (numeric can't hold uint256 safely as text round-trips cleanly)
  reward_token_address text not null,
  reward_token_decimals integer not null,
  reward_chain_id integer not null,

  status text not null default 'EARNED' check (
    status in ('EARNED', 'PENDING_SETTLEMENT', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'RETRYABLE', 'CANCELLED')
  ),

  -- The vault's bytes32 refId this settlement used/will use — deterministic
  -- (keccak256 of this row's id, computed by the settlement worker /
  -- route handler, never random) so a retried job always recomputes the
  -- SAME refId and CreatorRewardsVault.refUsed naturally rejects a
  -- duplicate on-chain, even if the DB-level idempotency check below
  -- somehow raced.
  settlement_ref_id text,
  onchain_tx_hash text,
  settled_at timestamptz,
  claimed_at timestamptz, -- set once we observe a Withdrawn event for this creator covering this settlement — best-effort display only, NEVER authoritative for "is this claimable" (the vault's own balanceOf is)
  failure_reason text,

  -- Optimistic-lock-style counter so the settlement worker can detect
  -- "someone else already claimed this job" without a DB-level advisory
  -- lock — see lib/server/creator-rewards-settlement.ts's claimNextBatch().
  attempt_count integer not null default 0,
  locked_by text,
  locked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint creator_reward_settlements_source_matches_type check (
    (reward_type = 'FORK_ROYALTY' and source_activity_id is not null and source_redeem_intent_id is null)
    or
    (reward_type = 'PERFORMANCE_FEE' and source_redeem_intent_id is not null)
  )
);

-- One settlement row per source event, ever. This is the DATABASE-layer
-- idempotency guarantee (section 17's "database" requirement) — a
-- worker/route handler that races or retries and tries to insert a
-- second row for the same source_activity_id / source_redeem_intent_id
-- gets a unique-violation, not a silent duplicate.
create unique index if not exists creator_reward_settlements_source_activity_uidx
  on creator_reward_settlements (source_activity_id)
  where source_activity_id is not null;

create unique index if not exists creator_reward_settlements_source_redeem_intent_uidx
  on creator_reward_settlements (source_redeem_intent_id)
  where source_redeem_intent_id is not null;

-- The BLOCKCHAIN-layer idempotency guarantee's DB-side mirror: once a
-- refId has actually been used on-chain, no other row may claim it.
create unique index if not exists creator_reward_settlements_ref_id_uidx
  on creator_reward_settlements (settlement_ref_id)
  where settlement_ref_id is not null;

create index if not exists creator_reward_settlements_creator_idx
  on creator_reward_settlements (creator_id, status);

create index if not exists creator_reward_settlements_pending_idx
  on creator_reward_settlements (status, created_at)
  where status in ('EARNED', 'RETRYABLE');

alter table creator_reward_settlements enable row level security;

-- Creators may read their own settlement rows (for the dashboard's
-- "pending settlement" / "failed" states — see hooks/useCreatorRewards.ts
-- follow-up). No insert/update/delete policy for authenticated users:
-- only service_role (server-side worker / route handlers) ever writes.
create policy creator_reward_settlements_select_own
  on creator_reward_settlements for select
  using (creator_id = auth.uid());

revoke all on creator_reward_settlements from public;
grant select on creator_reward_settlements to authenticated;
grant all on creator_reward_settlements to service_role;

-- Concurrency-safe batch claim, same `for update skip locked` pattern the
-- rest of this codebase's row-locking RPCs use (see 0004/0012/0013).
-- `skip locked` (not a bare `for update`) is the important part here: it
-- lets N settlement worker instances run concurrently, each grabbing a
-- disjoint batch, rather than blocking on each other or racing to double-
-- process the same row (section 18's "implement concurrency protection").
create or replace function claim_reward_settlement_batch(p_worker_id text, p_limit integer default 20)
returns setof creator_reward_settlements
language plpgsql
as $$
begin
  return query
    update creator_reward_settlements
    set status = 'PENDING_SETTLEMENT',
        locked_by = p_worker_id,
        locked_at = now(),
        attempt_count = attempt_count + 1,
        updated_at = now()
    where id in (
      select id from creator_reward_settlements
      where status in ('EARNED', 'RETRYABLE')
      order by created_at asc
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

revoke execute on function claim_reward_settlement_batch from public;
grant execute on function claim_reward_settlement_batch to service_role;
