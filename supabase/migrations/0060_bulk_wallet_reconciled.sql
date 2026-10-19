-- -----------------------------------------------------------------------------
-- 0060 — mark many wallets verified in one call.
--
-- The Transfer-log scan (lib/server/wallet-transfer-scan.ts) now runs every
-- minute. It used to call mark_wallet_reconciled once per covered wallet, one
-- HTTP round trip each: fine hourly, far too many every minute. This marks a
-- whole list at one block in a single statement. Same rule as the per-wallet
-- function (0049): the block only moves forward, never back.
-- -----------------------------------------------------------------------------

create or replace function mark_wallets_reconciled(p_user_ids uuid[], p_block_number bigint) returns integer
language sql
as $$
  with upserted as (
    insert into wallet_reconciliation_state (user_id, last_checked_at, last_block_number)
    select distinct u, now(), p_block_number from unnest(p_user_ids) as u
    on conflict (user_id) do update
      set last_checked_at = now(),
          last_block_number = greatest(coalesce(wallet_reconciliation_state.last_block_number, excluded.last_block_number), excluded.last_block_number)
    returning 1
  )
  select count(*)::integer from upserted
$$;

do $$
begin
  revoke execute on function mark_wallets_reconciled(uuid[], bigint) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke execute on function mark_wallets_reconciled(uuid[], bigint) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke execute on function mark_wallets_reconciled(uuid[], bigint) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function mark_wallets_reconciled(uuid[], bigint) to service_role; end if;
end $$;
