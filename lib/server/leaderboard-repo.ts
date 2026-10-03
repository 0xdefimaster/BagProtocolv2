import { SupabaseClient } from '@supabase/supabase-js';
import { LeaderboardEntry, LeaderboardResult } from '@/types/domain';

// -----------------------------------------------------------------------------
// Replaces lib/services/leaderboard-service.ts's 42-seeded-fake-trader
// generator. Every user now writes real trades into the same Postgres
// database (see trading-repo.ts), so the leaderboard is a real query over
// user_points joined to users — exactly what supabase/MIGRATION.md's step 2
// described. No fake rows are generated or merged in anymore.
// -----------------------------------------------------------------------------

interface RankedRow {
  user_id: string;
  total_realized_pnl: number;
  bag_points: number;
  users: { wallet_address: string; display_name: string | null } | null;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function getLeaderboard(
  admin: SupabaseClient,
  seasonId: string,
  selfUserId: string,
  topN: number
): Promise<LeaderboardResult> {
  // Full season ranking, best PnL first. Season populations are small
  // (this is a paper-trading demo, not a mainnet chain), so pulling every
  // row and ranking in memory is simpler than a window-function round trip
  // and still cheap — revisit with a `rank() over (...)` view if this ever
  // needs to scale past a few thousand participants.
  const { data, error } = await admin
    .from('user_points')
    .select('user_id, total_realized_pnl, bag_points, users(wallet_address, display_name)')
    .eq('season_id', seasonId)
    .order('total_realized_pnl', { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as RankedRow[];

  const entries: LeaderboardEntry[] = rows.map((row, index) => ({
    rank: index + 1,
    userId: row.user_id,
    displayName:
      row.users?.display_name ?? (row.users?.wallet_address ? shortAddress(row.users.wallet_address) : 'Trader'),
    realizedPnL: row.total_realized_pnl,
    bagPoints: row.bag_points,
    isSelf: row.user_id === selfUserId,
  }));

  const selfIndex = rows.findIndex((row) => row.user_id === selfUserId);
  const self =
    selfIndex >= 0
      ? {
          rank: selfIndex + 1,
          bagPoints: rows[selfIndex].bag_points,
          realizedPnL: rows[selfIndex].total_realized_pnl,
          pointsToNextRank:
            selfIndex === 0 ? 0 : Math.max(0, rows[selfIndex - 1].bag_points - rows[selfIndex].bag_points + 1),
        }
      : null;

  return {
    seasonId,
    entries: entries.slice(0, topN),
    topN,
    self,
  };
}
