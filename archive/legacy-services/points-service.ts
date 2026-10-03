import { PointTransaction, PointTransactionType, UserPoints } from '@/types/domain';
import { realizedPnLToPoints } from '@/lib/domain/points/engine';
import { readCollection, writeCollection, genId, nowIso } from './db';

// -----------------------------------------------------------------------------
// PARTIALLY superseded by the Supabase migration (see supabase/MIGRATION.md).
//
// syncPointsFromRealizedPnL() below is dead — hooks/usePoints.ts now reads
// from app/api/points, backed by lib/server/points-repo.ts, and every SELL
// awards points through that path instead of this one.
//
// spendPoints() is still LIVE: lib/services/box-service.ts calls it to pay
// for a box, and that still reads/writes the localStorage `user_points`
// collection — which is now a *different* balance than the real Supabase
// one trading awards into. Concretely: a user's real BAG Points balance
// lives in Supabase and grows from real trades, but box-service.ts checks
// this file's localStorage copy, which nothing writes to anymore, so it
// will always read as 0 and every box purchase will fail with "Not enough
// BAG Points." This is a known gap, not a fix applied here — closing it
// means migrating boxes/inventory to Supabase too (see MIGRATION.md's
// "still on localStorage" section), at which point this whole file goes
// away along with box-service.ts's `readCollection`/`writeCollection` use.
// -----------------------------------------------------------------------------

const POINTS_COLLECTION = 'user_points';
const TRANSACTIONS_COLLECTION = 'point_transactions';

function readAllPoints(): UserPoints[] {
  return readCollection<UserPoints>(POINTS_COLLECTION);
}

function writeAllPoints(items: UserPoints[]) {
  writeCollection(POINTS_COLLECTION, items);
}

function defaultUserPoints(userId: string, seasonId: string): UserPoints {
  return { userId, seasonId, totalRealizedPnL: 0, bagPoints: 0, pointsSpent: 0, pointsAvailable: 0 };
}

export function getUserPoints(userId: string, seasonId: string): UserPoints {
  const all = readAllPoints();
  return all.find((p) => p.userId === userId && p.seasonId === seasonId) ?? defaultUserPoints(userId, seasonId);
}

export function listTransactions(userId: string, seasonId?: string): PointTransaction[] {
  return readCollection<PointTransaction>(TRANSACTIONS_COLLECTION)
    .filter((t) => t.userId === userId && (!seasonId || t.seasonId === seasonId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function appendTransaction(tx: PointTransaction) {
  const all = readCollection<PointTransaction>(TRANSACTIONS_COLLECTION);
  all.push(tx);
  writeCollection(TRANSACTIONS_COLLECTION, all);
}

/**
 * Re-derives BAG Points from a portfolio's total realized PnL. This is the
 * only path that can ever *increase* bagPoints — it is driven by the trading
 * service after a SELL, never by a value the client hands in directly.
 * Idempotent: calling it twice with the same totalRealizedPnL is a no-op
 * (delta is 0), so replays can't double-award points.
 */
export function syncPointsFromRealizedPnL(
  userId: string,
  seasonId: string,
  totalRealizedPnL: number,
  referenceId?: string
): { userPoints: UserPoints; pointsAwarded: number } {
  const all = readAllPoints();
  const idx = all.findIndex((p) => p.userId === userId && p.seasonId === seasonId);
  const current = idx >= 0 ? all[idx] : defaultUserPoints(userId, seasonId);

  const newBagPoints = realizedPnLToPoints(totalRealizedPnL);
  const delta = newBagPoints - current.bagPoints;

  const updated: UserPoints = {
    ...current,
    totalRealizedPnL,
    bagPoints: newBagPoints,
    pointsAvailable: newBagPoints - current.pointsSpent,
  };

  if (idx >= 0) all[idx] = updated;
  else all.push(updated);
  writeAllPoints(all);

  if (delta > 0) {
    appendTransaction({
      id: genId('ptx'),
      userId,
      seasonId,
      type: 'TRADE_PROFIT',
      amount: delta,
      referenceId,
      createdAt: nowIso(),
    });
  }

  return { userPoints: updated, pointsAwarded: Math.max(delta, 0) };
}

export interface SpendPointsResult {
  ok: boolean;
  error?: string;
  userPoints?: UserPoints;
}

/**
 * Spends BAG Points (e.g. to buy a box). Validates the user actually has
 * enough available points server-side — the client only ever requests an
 * amount, it never supplies the resulting balance.
 */
export function spendPoints(
  userId: string,
  seasonId: string,
  amount: number,
  type: Extract<PointTransactionType, 'BOX_PURCHASE' | 'ADMIN_ADJUSTMENT'>,
  referenceId?: string
): SpendPointsResult {
  if (amount <= 0) return { ok: false, error: 'Invalid amount.' };

  const all = readAllPoints();
  const idx = all.findIndex((p) => p.userId === userId && p.seasonId === seasonId);
  const current = idx >= 0 ? all[idx] : defaultUserPoints(userId, seasonId);

  if (current.pointsAvailable < amount) {
    return { ok: false, error: 'Not enough BAG Points.' };
  }

  const updated: UserPoints = {
    ...current,
    pointsSpent: current.pointsSpent + amount,
    pointsAvailable: current.pointsAvailable - amount,
  };

  if (idx >= 0) all[idx] = updated;
  else all.push(updated);
  writeAllPoints(all);

  appendTransaction({
    id: genId('ptx'),
    userId,
    seasonId,
    type,
    amount: -amount,
    referenceId,
    createdAt: nowIso(),
  });

  return { ok: true, userPoints: updated };
}

export const POINTS_DB_COLLECTIONS = { POINTS_COLLECTION, TRANSACTIONS_COLLECTION };
