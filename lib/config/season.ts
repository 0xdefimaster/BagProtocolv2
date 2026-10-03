import { Season } from '@/types/domain';

// -----------------------------------------------------------------------------
// Production-hardening P0-6 — NO LONGER AUTHORITATIVE. `GENESIS_SEASON`'s
// `status: 'ACTIVE'` below is a historical seed value only — every route
// that needs to know the REAL current season now calls
// `lib/server/season-repo.ts`'s `getCurrentSeason()`, which reads the
// `seasons` table (supabase/schema.sql) and derives status from
// `start_date`/`end_date` vs the actual current time, never from a
// hardcoded field in this file. This constant is kept only for
// `LEADERBOARD_TOP_N` and as the original seed data's own record — do not
// import `GENESIS_SEASON.status` (or assume `.id` is "the" current season)
// from new code.
// -----------------------------------------------------------------------------

// First season: 90 days, used to determine the first 20 users for
// Robinhood Chain mainnet Genesis / Early Access once that ships.
// UI should present this as an access tier, never as a financial guarantee.
export const GENESIS_SEASON: Season = {
  id: 'season-genesis-01',
  name: 'BAG Genesis Season 01',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-04-01T00:00:00.000Z',
  status: 'ACTIVE',
  topUsersReward: 20,
};

export const LEADERBOARD_TOP_N = 20;
