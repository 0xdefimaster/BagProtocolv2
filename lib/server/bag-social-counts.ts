import { SupabaseClient } from '@supabase/supabase-js';

// Fork and holder counts for Bag cards and the detail page, from real rows:
//   forks   = Bags whose parent_bag_id is this Bag (any status)
//   holders = wallets that still hold some of the Bag's assets in BAG's ledger
//             (bag_investor_holdings > 0). Wallet reconciliation books tokens
//             that left a wallet outside BAG, so a wallet that moved everything
//             out stops counting; legacy shares alone do not count.
// Two queries for any number of Bags.

export interface BagSocialCounts {
  forks: number;
  holders: number;
}

export async function getBagSocialCounts(admin: SupabaseClient, bagIds: string[]): Promise<Map<string, BagSocialCounts>> {
  const out = new Map<string, BagSocialCounts>(bagIds.map((id) => [id, { forks: 0, holders: 0 }]));
  if (bagIds.length === 0) return out;

  const [forks, holders] = await Promise.all([
    admin.from('bags').select('parent_bag_id').in('parent_bag_id', bagIds),
    admin.from('bag_investor_holdings').select('bag_id,user_id,quantity_raw').in('bag_id', bagIds),
  ]);
  if (forks.error) throw new Error(forks.error.message);
  if (holders.error) throw new Error(holders.error.message);

  for (const row of (forks.data ?? []) as { parent_bag_id: string }[]) {
    const c = out.get(row.parent_bag_id);
    if (c) c.forks += 1;
  }
  // quantity_raw is a text column: compared as an integer here, one count per wallet per Bag.
  const holding = new Set<string>();
  for (const row of (holders.data ?? []) as { bag_id: string; user_id: string; quantity_raw: string }[]) {
    if (/^\d+$/.test(row.quantity_raw) && BigInt(row.quantity_raw) > BigInt(0)) holding.add(`${row.bag_id}:${row.user_id}`);
  }
  for (const key of holding) {
    const c = out.get(key.slice(0, key.indexOf(':')));
    if (c) c.holders += 1;
  }
  return out;
}
