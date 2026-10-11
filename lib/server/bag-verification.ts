import { SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// How current a Bag's figures are against the chain:
//   checkedAt        the OLDEST last on-chain check among the wallets that hold
//                    the Bag (wallet reconciliation). Null when a holder was
//                    never checked, or the Bag has no holder.
//   pendingOutflows  holders whose wallet holds less than the ledger and whose
//                    outflow is still being confirmed (open DRIFT naming the Bag).
// A Bag's TVL follows the chain within minutes of a check; these two say how
// many minutes, and whether part of it is about to leave.
// -----------------------------------------------------------------------------

export interface BagVerification {
  checkedAt: string | null;
  pendingOutflows: number;
}

export async function getBagVerification(admin: SupabaseClient, bagIds: string[]): Promise<Map<string, BagVerification>> {
  const out = new Map<string, BagVerification>(bagIds.map((id) => [id, { checkedAt: null, pendingOutflows: 0 }]));
  if (bagIds.length === 0) return out;

  const { data: holdings, error } = await admin.from('bag_investor_holdings').select('bag_id,user_id,quantity_raw').in('bag_id', bagIds);
  if (error) throw new Error(error.message);
  const holders = new Map<string, Set<string>>();
  for (const h of (holdings ?? []) as { bag_id: string; user_id: string; quantity_raw: string }[]) {
    if (!/^\d+$/.test(h.quantity_raw) || BigInt(h.quantity_raw) === BigInt(0)) continue;
    holders.set(h.bag_id, (holders.get(h.bag_id) ?? new Set()).add(h.user_id));
  }
  const userIds = [...new Set([...holders.values()].flatMap((s) => [...s]))];
  if (userIds.length === 0) return out;

  const [{ data: state, error: stateError }, { data: records, error: recordsError }] = await Promise.all([
    admin.from('wallet_reconciliation_state').select('user_id,last_checked_at').in('user_id', userIds),
    admin
      .from('reconciliation_records')
      .select('id,user_id,status,confirms_record_id,allocation')
      .in('user_id', userIds)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
  ]);
  if (stateError) throw new Error(stateError.message);
  if (recordsError) throw new Error(recordsError.message);

  const checked = new Map(((state ?? []) as { user_id: string; last_checked_at: string }[]).map((s) => [s.user_id, s.last_checked_at]));
  const rows = (records ?? []) as { id: string; user_id: string; status: string; confirms_record_id: string | null; allocation: { bagId?: string; allocatedRaw?: string }[] | null }[];
  const closed = new Set(rows.map((r) => r.confirms_record_id).filter((id): id is string => !!id));
  const pending = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.status !== 'DRIFT' || closed.has(r.id)) continue;
    for (const a of r.allocation ?? []) {
      if (a.bagId && /^\d+$/.test(a.allocatedRaw ?? '') && BigInt(a.allocatedRaw!) > BigInt(0)) pending.set(a.bagId, (pending.get(a.bagId) ?? new Set()).add(r.user_id));
    }
  }

  for (const [bagId, users] of holders) {
    let oldest: string | null = null;
    let complete = true;
    for (const u of users) {
      const at = checked.get(u);
      if (!at) {
        complete = false;
        break;
      }
      if (oldest === null || Date.parse(at) < Date.parse(oldest)) oldest = at;
    }
    out.set(bagId, { checkedAt: complete ? oldest : null, pendingOutflows: pending.get(bagId)?.size ?? 0 });
  }
  return out;
}
