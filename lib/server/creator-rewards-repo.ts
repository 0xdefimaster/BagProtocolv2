import { SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Phase 22 (follow-up) — the FIRST read path for the `activities` rows
// apply_purchase_execution()'s fork-royalty branch and
// apply_redeem_execution()'s performance-fee branch write (supabase/
// migrations/0013_add_creator_rewards.sql). Before this file, those rows
// were real and auditable in the database but invisible everywhere in the
// product — a creator had no way to see they'd earned anything.
//
// `activities.action` is a plain text column, written as
// `'FORK_ROYALTY_EARNED:<amount>:<bagId>'` / `'PERFORMANCE_FEE_EARNED:<amount>:<bagId>'`
// by the two RPCs — parsed back out here rather than adding a structured
// column, since `activities` is a shared, append-only audit log used by
// several unrelated features (PURCHASE_EXECUTED, REDEEM_EXECUTED, box
// opens, etc.) with the same "colon-joined string" convention throughout;
// changing that convention here would be a much bigger, unrelated
// migration for a display-only feature.
// -----------------------------------------------------------------------------

export type CreatorRewardType = 'FORK_ROYALTY' | 'PERFORMANCE_FEE';

export interface CreatorRewardActivity {
  id: string;
  type: CreatorRewardType;
  /** Quote-currency amount credited, as a decimal string (parsed straight from the activity row — never re-derived, so this can never drift from what was actually recorded in `creator_reward_settlements`; since migration 0018 this no longer touches `portfolios.cash_balance` at all). */
  amountQuote: string;
  bagId: string;
  createdAt: string;
}

interface ActivityRow {
  id: string;
  action: string;
  created_at: string;
}

const PREFIXES: Record<CreatorRewardType, string> = {
  FORK_ROYALTY: 'FORK_ROYALTY_EARNED:',
  PERFORMANCE_FEE: 'PERFORMANCE_FEE_EARNED:',
};

function parseRewardActivity(row: ActivityRow): CreatorRewardActivity | null {
  for (const [type, prefix] of Object.entries(PREFIXES) as [CreatorRewardType, string][]) {
    if (!row.action.startsWith(prefix)) continue;
    const rest = row.action.slice(prefix.length);
    const separatorIndex = rest.indexOf(':');
    if (separatorIndex === -1) return null; // Malformed row — skip rather than guess.
    return {
      id: row.id,
      type,
      amountQuote: rest.slice(0, separatorIndex),
      bagId: rest.slice(separatorIndex + 1),
      createdAt: row.created_at,
    };
  }
  return null;
}

/** Every fork-royalty / performance-fee credit THIS user has ever earned as a creator, newest first. Never another user's — always filtered by `user_id` at the query level, same boundary as every other *-repo.ts read in this codebase. */
export async function getCreatorRewardActivities(admin: SupabaseClient, userId: string): Promise<CreatorRewardActivity[]> {
  const { data, error } = await admin
    .from('activities')
    .select('id, action, created_at')
    .eq('user_id', userId)
    .or(`action.like.${PREFIXES.FORK_ROYALTY}%,action.like.${PREFIXES.PERFORMANCE_FEE}%`)
    .order('created_at', { ascending: false })
    .returns<ActivityRow[]>();

  if (error) throw new Error(error.message);
  return (data ?? []).map(parseRewardActivity).filter((r): r is CreatorRewardActivity => r !== null);
}
