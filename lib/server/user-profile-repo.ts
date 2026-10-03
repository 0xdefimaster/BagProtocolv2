import { SupabaseClient } from '@supabase/supabase-js';
import { CreatorProfile } from '@/types';

export interface UserProfile {
  id: string;
  walletAddress: string;
  displayName: string | null;
  /** Absent until 0039_user_profile.sql has run. */
  avatarUrl: string | null;
}

interface UserRow {
  id: string;
  wallet_address: string;
  display_name: string | null;
  avatar_url?: string | null;
}

function fromRow(row: UserRow): UserProfile {
  return { id: row.id, walletAddress: row.wallet_address, displayName: row.display_name, avatarUrl: row.avatar_url ?? null };
}

export function shortWallet(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// `select('*')` rather than naming avatar_url, so these keep working on a
// database where 0039 hasn't run yet.

export async function getUserProfile(admin: SupabaseClient, id: string): Promise<UserProfile | null> {
  const { data, error } = await admin.from('users').select('*').eq('id', id).maybeSingle<UserRow>();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export async function getUserProfiles(admin: SupabaseClient, ids: string[]): Promise<Map<string, UserProfile>> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();
  const { data, error } = await admin.from('users').select('*').in('id', unique);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as UserRow[]).map((row) => [row.id, fromRow(row)]));
}

export async function updateUserProfile(
  admin: SupabaseClient,
  id: string,
  patch: { displayName?: string | null; avatarUrl?: string | null }
): Promise<UserProfile> {
  const update: Record<string, string | null> = {};
  if (patch.displayName !== undefined) update.display_name = patch.displayName;
  if (patch.avatarUrl !== undefined) update.avatar_url = patch.avatarUrl;
  const { data, error } = await admin.from('users').update(update).eq('id', id).select('*').single<UserRow>();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

/**
 * What a Bag page shows for its creator. Never invents a reputation score,
 * follower count or name: the name is the display name or the short wallet.
 */
export function userToCreatorProfile(user: UserProfile): CreatorProfile {
  return {
    id: user.id,
    name: user.displayName ?? shortWallet(user.walletAddress),
    avatar: '👤',
    avatarUrl: user.avatarUrl ?? undefined,
    address: user.walletAddress,
    followers: 0,
    forks: 0,
  };
}

/** Creator profiles for a set of creator ids; display-only, so it never throws. */
export async function loadCreatorProfiles(admin: SupabaseClient, ids: string[]): Promise<Map<string, CreatorProfile>> {
  try {
    const users = await getUserProfiles(admin, ids);
    return new Map(Array.from(users.values()).map((u) => [u.id, userToCreatorProfile(u)]));
  } catch {
    return new Map();
  }
}
