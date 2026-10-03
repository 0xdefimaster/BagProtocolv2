-- 0015_backfill_legacy_creator_rewards.sql
--
-- One-time, idempotent backfill of pre-0014 creator rewards (activities
-- rows written by apply_purchase_execution()/apply_redeem_execution()
-- BEFORE creator_reward_settlements existed) into the new settlement
-- lifecycle table, at status EARNED — NOT CONFIRMED. This does NOT make
-- any legacy reward claimable on-chain by itself: it only unblocks the
-- accounting path so the existing settlement worker
-- (lib/server/creator-rewards-settlement.ts) can pick these rows up like
-- any other EARNED fork-royalty row, exactly once real USDG funding for
-- them has been separately arranged. See
-- docs/CREATOR_REWARDS_SETTLEMENT.md's "Historical / legacy rewards"
-- section for the full rationale — this migration is the "step 2"
-- (idempotent script) that doc said was missing.
--
-- IMPORTANT SCOPE NOTE: only FORK_ROYALTY_EARNED rows are backfilled by
-- this migration. PERFORMANCE_FEE_EARNED legacy rows are intentionally
-- NOT backfilled here — see the long comment above
-- backfill_legacy_performance_fee_rewards() below for why that path is a
-- best-effort correlation (bag_id + exact-transaction-timestamp match
-- against a companion REDEEM_EXECUTED row) rather than a guaranteed one,
-- and is exposed as a separate, explicitly-invoked function so it is
-- never silently run as part of `supabase db push` without someone
-- reviewing its output first.
--
-- Idempotency: safe to run this migration (or re-invoke either function)
-- any number of times. Every insert is protected by the SAME unique
-- indexes 0014 already created (`creator_reward_settlements_source_
-- activity_uidx` / `..._source_redeem_intent_uidx`) via `on conflict do
-- nothing` — a row already backfilled is simply skipped, never
-- duplicated, never re-credited.

-- ---------------------------------------------------------------------------
-- Fork royalty: unambiguous. FORK_ROYALTY_EARNED's own activities.id IS
-- the source_activity_id the 0014 schema wants — no correlation needed,
-- unlike performance fee below.
-- ---------------------------------------------------------------------------
create or replace function backfill_legacy_fork_royalty_rewards()
returns table(inserted_count integer, skipped_malformed_count integer)
language plpgsql
as $$
declare
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_row record;
  v_amount numeric;
  v_bag_id uuid;
  v_wallet text;
begin
  for v_row in
    select a.id, a.user_id, a.action, a.created_at
    from activities a
    where a.action like 'FORK_ROYALTY_EARNED:%'
      -- Already covered — either backfilled by a prior run of this
      -- function, or settled the "normal" way after 0014 shipped.
      and not exists (
        select 1 from creator_reward_settlements s
        where s.source_activity_id = a.id
      )
  loop
    -- action shape: 'FORK_ROYALTY_EARNED:<amount>:<bagId>' — same parse
    -- rule as lib/server/creator-rewards-repo.ts's parseRewardActivity(),
    -- kept in sync deliberately (see that file's own comment on why the
    -- colon-joined convention exists at all).
    begin
      v_amount := split_part(substring(v_row.action from length('FORK_ROYALTY_EARNED:') + 1), ':', 1)::numeric;
      v_bag_id := split_part(substring(v_row.action from length('FORK_ROYALTY_EARNED:') + 1), ':', 2)::uuid;
    exception when others then
      -- Malformed/unparseable row — never guess, never invent a bag_id
      -- or amount. Skip and count it so the caller can investigate.
      v_skipped := v_skipped + 1;
      continue;
    end;

    select wallet_address into v_wallet from users where id = v_row.user_id;
    if v_wallet is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_activity_id, gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, created_at
    ) values (
      v_row.user_id, v_wallet, v_bag_id, 'FORK_ROYALTY',
      v_row.id, v_amount::text,
      -- USDG, 6 decimals (lib/config/robinhood-chain.ts) — gross_amount_quote
      -- here always already has <= 2 decimal places (apply_purchase_
      -- execution() rounds with `round(..., 2)` before ever writing the
      -- activities row), so floor(amount * 10^6) is exact, never lossy.
      floor(v_amount * 1000000)::text,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'EARNED', v_row.created_at
    )
    on conflict (source_activity_id) where source_activity_id is not null do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return query select v_inserted, v_skipped;
end;
$$;

revoke execute on function backfill_legacy_fork_royalty_rewards from public;
grant execute on function backfill_legacy_fork_royalty_rewards to service_role;

-- ---------------------------------------------------------------------------
-- Performance fee: needs a redeem_intents.id to satisfy 0014's check
-- constraint (`reward_type = 'PERFORMANCE_FEE' requires source_redeem_
-- intent_id is not null`), but the legacy PERFORMANCE_FEE_EARNED string
-- itself only ever encoded '<amount>:<bagId>' — no intent id.
--
-- Correlation trick: apply_redeem_execution() (0013) always inserts the
-- creator's PERFORMANCE_FEE_EARNED row and the redeemer's own
-- 'REDEEM_EXECUTED:<intentId>:<bagId>' row in the SAME function call,
-- i.e. the SAME database transaction — and `now()` in Postgres returns
-- the transaction's start time, identical for every statement inside one
-- transaction. So for a given PERFORMANCE_FEE_EARNED row, the matching
-- REDEEM_EXECUTED row (same bag_id, IDENTICAL created_at timestamp down
-- to the microsecond) reveals the intent id we need.
--
-- This is a real correlation, not a guess — but it is not proof the way
-- source_activity_id's direct foreign key is, so this function is kept
-- SEPARATE from the fork-royalty one above, is NOT called automatically
-- by this migration file, and returns its unmatched rows explicitly so a
-- human reviews them rather than this silently leaving some legacy
-- performance fees unmigrated with no visibility. Call manually:
--   select * from backfill_legacy_performance_fee_rewards();
-- ---------------------------------------------------------------------------
create or replace function backfill_legacy_performance_fee_rewards()
returns table(inserted_count integer, unmatched_count integer, malformed_count integer)
language plpgsql
as $$
declare
  v_inserted integer := 0;
  v_unmatched integer := 0;
  v_malformed integer := 0;
  v_row record;
  v_amount numeric;
  v_bag_id uuid;
  v_wallet text;
  v_intent_id uuid;
begin
  for v_row in
    select a.id, a.user_id, a.action, a.created_at
    from activities a
    where a.action like 'PERFORMANCE_FEE_EARNED:%'
      and not exists (
        select 1 from creator_reward_settlements s
        where s.source_activity_id = a.id
      )
  loop
    begin
      v_amount := split_part(substring(v_row.action from length('PERFORMANCE_FEE_EARNED:') + 1), ':', 1)::numeric;
      v_bag_id := split_part(substring(v_row.action from length('PERFORMANCE_FEE_EARNED:') + 1), ':', 2)::uuid;
    exception when others then
      v_malformed := v_malformed + 1;
      continue;
    end;

    -- Find the companion REDEEM_EXECUTED row: same bag, exact same
    -- transaction timestamp. Ambiguous match (more than one candidate) is
    -- treated as unmatched, not "pick the first one" — a wrong intent id
    -- here would misattribute a real user's redemption to the wrong
    -- settlement row.
    select (split_part(substring(re.action from length('REDEEM_EXECUTED:') + 1), ':', 1))::uuid
      into v_intent_id
    from activities re
    where re.action like 'REDEEM_EXECUTED:%:' || v_bag_id::text
      and re.created_at = v_row.created_at
    limit 2; -- fetch up to 2 just to detect ambiguity below without a second query

    if not found then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    -- Re-check for ambiguity explicitly (the LIMIT 2 above only prevented
    -- an unbounded scan; this confirms exactly one candidate existed).
    if (
      select count(*) from activities re
      where re.action like 'REDEEM_EXECUTED:%:' || v_bag_id::text
        and re.created_at = v_row.created_at
    ) <> 1 then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    select wallet_address into v_wallet from users where id = v_row.user_id;
    if v_wallet is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    insert into creator_reward_settlements (
      creator_id, creator_wallet, bag_id, reward_type,
      source_activity_id, source_redeem_intent_id,
      gross_amount_quote, reward_amount_token_raw,
      reward_token_address, reward_token_decimals, reward_chain_id,
      status, created_at
    ) values (
      v_row.user_id, v_wallet, v_bag_id, 'PERFORMANCE_FEE',
      v_row.id, v_intent_id,
      v_amount::text, floor(v_amount * 1000000)::text,
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 4663,
      'EARNED', v_row.created_at
    )
    on conflict (source_redeem_intent_id) where source_redeem_intent_id is not null do nothing;

    if found then
      v_inserted := v_inserted + 1;
    else
      v_unmatched := v_unmatched + 1; -- redeem_intent_id already used by another settlement row — investigate, don't silently drop
    end if;
  end loop;

  return query select v_inserted, v_unmatched, v_malformed;
end;
$$;

revoke execute on function backfill_legacy_performance_fee_rewards from public;
grant execute on function backfill_legacy_performance_fee_rewards to service_role;

-- Fork royalty backfill IS safe to run automatically as part of applying
-- this migration (unambiguous, direct FK correlation) — performance fee
-- backfill is not auto-invoked here, per the rationale above.
select backfill_legacy_fork_royalty_rewards();
