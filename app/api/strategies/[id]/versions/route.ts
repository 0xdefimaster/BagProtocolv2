import { NextRequest, NextResponse } from 'next/server';
import { buildStrategyVersions, loadStrategyVersionRows } from '@/lib/server/strategy-api';
import { resolveStrategy } from '@/lib/server/strategy-http';

// GET /api/strategies/:id/versions — every version, newest first, with its
// bag.json definitionHash and on-chain commitment. Becomes get_strategy_history().

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await resolveStrategy((await params).id);
  if (!access.ok) return access.response;
  try {
    return NextResponse.json(buildStrategyVersions(access.bag, await loadStrategyVersionRows(access.admin, access.bag.id)));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
