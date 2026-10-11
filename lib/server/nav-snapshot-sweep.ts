import { SupabaseClient } from '@supabase/supabase-js';
import { getNavSummaries, recordNavSnapshot, type SnapshotOutcome } from '@/lib/server/bag-nav-snapshots';

// -----------------------------------------------------------------------------
// The scheduled NAV pass (every 5 minutes, /api/cron/snapshot-bag-navs): one
// snapshot per ACTIVE Bag whose latest one is older than `minIntervalMs`, so TVL,
// returns and the leaderboard follow prices even for a Bag nobody opens. A Bag
// that a purchase, sale or page view snapshotted moments ago is skipped.
//
// Stalest first (never-snapshotted Bags lead), a few in parallel, and no new Bag
// is started once `budgetMs` has passed: a run never outlives the function's
// time limit, and whatever it did not reach leads the next run.
// -----------------------------------------------------------------------------

export const SWEEP_MIN_INTERVAL_MS = 4 * 60 * 1000;
export const SWEEP_BUDGET_MS = 8_000;
export const SWEEP_CONCURRENCY = 4;

export interface SweepResult {
  bags: number;
  attempted: number;
  outcomes: Partial<Record<SnapshotOutcome | 'error', number>>;
}

export async function snapshotActiveBags(
  admin: SupabaseClient,
  options: { minIntervalMs?: number; budgetMs?: number; concurrency?: number; now?: () => number } = {}
): Promise<SweepResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? SWEEP_BUDGET_MS;
  const minIntervalMs = options.minIntervalMs ?? SWEEP_MIN_INTERVAL_MS;

  const { data, error } = await admin.from('bags').select('id').eq('status', 'ACTIVE');
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as { id: string }[]).map((b) => b.id);
  const latest = await getNavSummaries(admin, ids).catch(() => new Map<string, { latestAt: string }>());
  const lastAt = (id: string) => {
    const at = latest.get(id)?.latestAt;
    return at ? Date.parse(at) : 0;
  };
  // Due Bags only, stalest first; a Bag never snapshotted (0) leads.
  const due = ids.filter((id) => started - lastAt(id) >= minIntervalMs).sort((a, b) => lastAt(a) - lastAt(b));

  const outcomes: SweepResult['outcomes'] = {};
  let next = 0;
  let attempted = 0;
  const worker = async () => {
    while (next < due.length && now() - started < budget) {
      const id = due[next++];
      attempted++;
      let outcome: SnapshotOutcome | 'error';
      try {
        outcome = await recordNavSnapshot(admin, id, { minIntervalMs });
      } catch {
        outcome = 'error';
      }
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? SWEEP_CONCURRENCY) }, worker));
  return { bags: ids.length, attempted, outcomes };
}
