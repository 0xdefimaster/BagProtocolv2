import { SupabaseClient } from '@supabase/supabase-js';
import { Season, SeasonStatus } from '@/types/domain';

// -----------------------------------------------------------------------------
// Production-hardening P0-6 — season is now DB-authoritative, and its
// `status` is ALWAYS derived from `now` vs `start_date`/`end_date` here,
// never trusted from the `seasons.status` column as-is. Before this, every
// season-scoped route imported the hardcoded `GENESIS_SEASON` TS constant
// (lib/config/season.ts) directly — which has `status: 'ACTIVE'` baked in
// at the source level, so the app kept treating Genesis Season 01 as
// active for as long as nobody edited that file, even well past its own
// `endDate` (2026-04-01). The `seasons` table (supabase/schema.sql) already
// existed and was already correctly seeded with real dates — it just had
// no reader. This is that reader.
//
// Rule, applied uniformly: `now < start` => UPCOMING, `start <= now < end`
// => ACTIVE, `now >= end` => ENDED. `getCurrentSeason()` returns the ONE
// row whose window contains `now` (there should only ever be one — seasons
// aren't expected to overlap), or `null` if none does. Callers MUST handle
// `null` explicitly (spec: "Aktif sezon yoksa sistem bunu açık şekilde ele
// almalı; eski sezonu ACTIVE varsaymamalı") — there is no fallback season.
// -----------------------------------------------------------------------------

interface SeasonRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  top_users_reward: number;
}

function deriveStatus(startDate: string, endDate: string, now: number): SeasonStatus {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (now < start) return 'UPCOMING';
  if (now < end) return 'ACTIVE';
  return 'ENDED';
}

function fromRow(row: SeasonRow, now: number): Season {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: deriveStatus(row.start_date, row.end_date, now),
    topUsersReward: row.top_users_reward,
  };
}

/**
 * The season whose window actually contains `now` (defaults to the real
 * current time — a caller can pass a fixed timestamp only for testing).
 * Returns `null` when no season is currently active — a past-Genesis,
 * pre-next-season gap is a real, expected state, not an error.
 */
export async function getCurrentSeason(admin: SupabaseClient, now: number = Date.now()): Promise<Season | null> {
  const nowIso = new Date(now).toISOString();
  const { data, error } = await admin
    .from('seasons')
    .select('id, name, start_date, end_date, top_users_reward')
    .lte('start_date', nowIso)
    .gt('end_date', nowIso)
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return fromRow(data as SeasonRow, now);
}

/** Looks up one season by id regardless of whether it's currently active — for display/audit contexts (e.g. showing a past season's name on an already-minted NFT) that must never fail just because that season has since ended. Still derives `status` from dates, same as `getCurrentSeason()`, never from the stored column. */
export async function getSeasonById(admin: SupabaseClient, seasonId: string, now: number = Date.now()): Promise<Season | null> {
  const { data, error } = await admin
    .from('seasons')
    .select('id, name, start_date, end_date, top_users_reward')
    .eq('id', seasonId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return fromRow(data as SeasonRow, now);
}
