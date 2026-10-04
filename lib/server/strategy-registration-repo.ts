import { SupabaseClient } from '@supabase/supabase-js';

// strategy_registrations (0052): what BAG verified from creator-signed StrategyRegistry transactions, one row per
// registered version. Written only by lib/server/strategy-registration.ts after receipt verification.

export interface RegistrationRow {
  bag_id: string;
  version: number;
  chain: string;
  registry_address: string;
  registry_strategy_id: string;
  definition_hash: string;
  creator_wallet: string;
  fork_of_registry_strategy_id: string | null;
  fork_of_version: number | null;
  tx_hash: string;
  block_number: number;
  log_index: number;
  verified_at?: string;
}

/** Recorded registrations of one Bag, by version. A database without 0052 has none. */
export async function loadRegistrations(admin: SupabaseClient, bagId: string): Promise<RegistrationRow[]> {
  const { data, error } = await admin.from('strategy_registrations').select('*').eq('bag_id', bagId).order('version', { ascending: true });
  if (error) {
    if (error.code === '42P01' || /strategy_registrations/.test(error.message ?? '')) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as RegistrationRow[];
}
