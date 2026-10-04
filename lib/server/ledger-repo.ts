import { SupabaseClient } from '@supabase/supabase-js';
import type { LedgerEvent, LedgerEventKind, LedgerPage } from '@/types/ledger';

// Read side of the Accounting V2 ledger (0048). Writes happen only inside the
// accounting RPCs (ledger_append), never from application code.

interface LedgerEventRow {
  seq: string | number;
  bag_id: string;
  kind: LedgerEventKind;
  legs: LedgerEvent['legs'];
  quote: Record<string, unknown>;
  source: Record<string, unknown>;
  strategy_version: number | null;
  created_at: string;
}

export const MAX_LEDGER_PAGE = 100;

/** One user's events, newest first (by seq), optionally for one Bag, keyset-paginated by `before` (exclusive). */
export async function listLedgerEventsForUser(
  admin: SupabaseClient,
  userId: string,
  opts: { bagId?: string; before?: string; limit?: number } = {}
): Promise<LedgerPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LEDGER_PAGE);
  let query = admin
    .from('ledger_events')
    .select('seq, bag_id, kind, legs, quote, source, strategy_version, created_at')
    .eq('user_id', userId)
    .order('seq', { ascending: false })
    .limit(limit + 1);
  if (opts.bagId) query = query.eq('bag_id', opts.bagId);
  if (opts.before) query = query.lt('seq', opts.before);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as LedgerEventRow[];
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({
      seq: String(r.seq),
      bagId: r.bag_id,
      kind: r.kind,
      legs: r.legs,
      quote: r.quote,
      source: r.source,
      strategyVersion: r.strategy_version,
      createdAt: r.created_at,
    })),
    nextBefore: rows.length > limit ? String(page[page.length - 1].seq) : null,
  };
}

export interface LedgerMismatch {
  scope: 'HOLDING' | 'SHARES' | 'COST_BASIS';
  userId: string;
  bagId: string;
  chain: string | null;
  address: string | null;
  ledgerValue: string;
  storedValue: string;
}

/** Every difference between the investor tables and what the ledger rebuilds. Empty means the books agree. */
export async function findLedgerMismatches(admin: SupabaseClient): Promise<LedgerMismatch[]> {
  const { data, error } = await admin.rpc('ledger_projection_mismatches');
  if (error) throw new Error(error.message);
  return ((data ?? []) as { scope: LedgerMismatch['scope']; user_id: string; bag_id: string; chain: string | null; address: string | null; ledger_value: string | number; stored_value: string | number }[]).map(
    (r) => ({
      scope: r.scope,
      userId: r.user_id,
      bagId: r.bag_id,
      chain: r.chain,
      address: r.address,
      ledgerValue: String(r.ledger_value),
      storedValue: String(r.stored_value),
    })
  );
}
