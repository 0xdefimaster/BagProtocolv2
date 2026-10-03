import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { PointTransaction, PointTransactionType, UserPoints } from '@/types/domain';
import { realizedPnLToPoints } from '@/lib/domain/points/engine';

// -----------------------------------------------------------------------------
// Supabase-backed equivalent of lib/services/points-service.ts. Same
// derivation rule as before — BAG Points are always recomputed from
// totalRealizedPnL, never accumulated by summing deltas — now enforced by a
// real row instead of a localStorage array, so it survives a device change
// and can't be edited from DevTools.
// -----------------------------------------------------------------------------

interface UserPointsRow {
  user_id: string;
  season_id: string;
  total_realized_pnl: number;
  bag_points: number;
  points_spent: number;
  points_available: number;
}

interface PointTransactionRow {
  id: string;
  user_id: string;
  season_id: string;
  type: PointTransactionType;
  amount: number;
  reference_id: string | null;
  created_at: string;
}

function fromRow(row: UserPointsRow): UserPoints {
  return {
    userId: row.user_id,
    seasonId: row.season_id,
    totalRealizedPnL: row.total_realized_pnl,
    bagPoints: row.bag_points,
    pointsSpent: row.points_spent,
    pointsAvailable: row.points_available,
  };
}

function defaultUserPoints(userId: string, seasonId: string): UserPoints {
  return { userId, seasonId, totalRealizedPnL: 0, bagPoints: 0, pointsSpent: 0, pointsAvailable: 0 };
}

export async function getUserPoints(
  admin: SupabaseClient,
  userId: string,
  seasonId: string
): Promise<UserPoints> {
  const { data, error } = await admin
    .from('user_points')
    .select('user_id, season_id, total_realized_pnl, bag_points, points_spent, points_available')
    .eq('user_id', userId)
    .eq('season_id', seasonId)
    .maybeSingle<UserPointsRow>();

  if (error) throw new Error(error.message);
  return data ? fromRow(data) : defaultUserPoints(userId, seasonId);
}

export async function listTransactions(
  admin: SupabaseClient,
  userId: string,
  seasonId: string,
  limit = 100
): Promise<PointTransaction[]> {
  const { data, error } = await admin
    .from('point_transactions')
    .select()
    .eq('user_id', userId)
    .eq('season_id', seasonId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row: PointTransactionRow) => ({
    id: row.id,
    userId: row.user_id,
    seasonId: row.season_id,
    type: row.type,
    amount: row.amount,
    referenceId: row.reference_id ?? undefined,
    createdAt: row.created_at,
  }));
}

/**
 * Re-derives BAG Points from a portfolio's total realized PnL — the only
 * path that can increase bagPoints, called from the trades route right
 * after a SELL persists. Idempotent: replaying the same totalRealizedPnL
 * produces delta 0.
 */
export async function syncPointsFromRealizedPnL(
  admin: SupabaseClient,
  userId: string,
  seasonId: string,
  totalRealizedPnL: number,
  referenceId?: string
): Promise<{ userPoints: UserPoints; pointsAwarded: number }> {
  const current = await getUserPoints(admin, userId, seasonId);
  const newBagPoints = realizedPnLToPoints(totalRealizedPnL);
  const delta = newBagPoints - current.bagPoints;

  const updated: UserPoints = {
    ...current,
    totalRealizedPnL,
    bagPoints: newBagPoints,
    pointsAvailable: newBagPoints - current.pointsSpent,
  };

  const { error: upsertError } = await admin.from('user_points').upsert(
    {
      user_id: updated.userId,
      season_id: updated.seasonId,
      total_realized_pnl: updated.totalRealizedPnL,
      bag_points: updated.bagPoints,
      points_spent: updated.pointsSpent,
      points_available: updated.pointsAvailable,
    },
    { onConflict: 'user_id,season_id' }
  );
  if (upsertError) throw new Error(upsertError.message);

  if (delta > 0) {
    const { error: txError } = await admin.from('point_transactions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      season_id: seasonId,
      type: 'TRADE_PROFIT' satisfies PointTransactionType,
      amount: delta,
      reference_id: referenceId ?? null,
    });
    if (txError) throw new Error(txError.message);
  }

  return { userPoints: updated, pointsAwarded: Math.max(delta, 0) };
}
