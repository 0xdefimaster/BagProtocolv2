import { createClient, SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Service-role Supabase client. Server-only — importing this from a 'use
// client' component or a browser-executed module is a bug, not a config
// option, since the service-role key bypasses Row Level Security entirely.
//
// Every write to a client-non-forgeable table (portfolios, positions, trades,
// user_points, point_transactions) must go through an API route that uses
// this client, never through NEXT_PUBLIC_SUPABASE_ANON_KEY from the browser.
// -----------------------------------------------------------------------------

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY (see .env.example).'
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** True once real env vars are present — lets API routes fail with a clear 503 instead of a stack trace when the project hasn't been wired up yet. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
