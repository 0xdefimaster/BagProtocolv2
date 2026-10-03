import { SupabaseClient } from '@supabase/supabase-js';

// Fork and holder counts for Bag cards and the detail page, from real rows:
//   forks   = Bags whose parent_bag_id is this Bag (any status)
//   holders = wallets with a non-zero position (bag_investor_positions)
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
    admin.from('bag_investor_positions').select('bag_id').in('bag_id', bagIds).gt('shares_raw', 0),
  ]);
  if (forks.error) throw new Error(forks.error.message);
  if (holders.error) throw new Error(holders.error.message);

  for (const row of (forks.data ?? []) as { parent_bag_id: string }[]) {
    const c = out.get(row.parent_bag_id);
    if (c) c.forks += 1;
  }
  for (const row of (holders.data ?? []) as { bag_id: string }[]) {
    const c = out.get(row.bag_id);
    if (c) c.holders += 1;
  }
  return out;
}
