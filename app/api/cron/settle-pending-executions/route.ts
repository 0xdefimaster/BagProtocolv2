import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/server/require-cron-secret';
import { reconcilePendingExecutions } from '@/lib/server/execution-reconciler';

// -----------------------------------------------------------------------------
// GET|POST /api/cron/settle-pending-executions — settles purchases and
// redemptions whose transaction is on chain but were never verified because
// the user left before confirmation (lib/server/execution-reconciler.ts).
// Scheduled by netlify/functions/settle-pending-executions.mts; same
// CRON_SECRET auth as the other cron routes (fails closed when unset).
// -----------------------------------------------------------------------------

async function handle(req: NextRequest) {
  const authError = requireCronSecret(req);
  if (authError) return authError;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  try {
    return NextResponse.json(await reconcilePendingExecutions(supabaseAdmin()));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
