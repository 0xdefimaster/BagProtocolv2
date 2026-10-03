import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import type { BagRecord } from '@/types/basket-protocol';
import { getBagById } from '@/lib/server/bag-repo';
import { isStrategyId } from '@/lib/server/strategy-api';

// Shared visibility gate for the read-only /api/strategies/:id routes: the same
// rule as the Passport (public for ACTIVE Bags, creator-only otherwise). A
// malformed id, a missing Bag and a hidden Bag all answer the same 404.

export type StrategyAccess =
  | { ok: true; admin: ReturnType<typeof supabaseAdmin>; bag: BagRecord; viewerUserId: string | null }
  | { ok: false; response: NextResponse };

const notFound = () => NextResponse.json({ error: 'Strategy not found.' }, { status: 404 });

export async function resolveStrategy(id: string): Promise<StrategyAccess> {
  if (!isSupabaseConfigured()) {
    return { ok: false, response: NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 }) };
  }
  if (!isStrategyId(id)) return { ok: false, response: notFound() };
  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id.toLowerCase());
  if (!bag) return { ok: false, response: notFound() };
  const session = await getSession();
  const viewerUserId = session?.userId ?? null;
  if (bag.status !== 'ACTIVE' && viewerUserId !== bag.creatorId) return { ok: false, response: notFound() };
  return { ok: true, admin, bag, viewerUserId };
}
