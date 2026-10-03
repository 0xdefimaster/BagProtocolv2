import { NextRequest, NextResponse } from 'next/server';
import { loadStrategyObject } from '@/lib/server/strategy-api';
import { resolveStrategy } from '@/lib/server/strategy-http';

// GET /api/strategies/:id — the Strategy object (types/strategy.ts): bag.json of
// the current version (definition), current state, policy view and lineage.
// Same visibility as the Passport. Becomes the MCP get_strategy() tool.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await resolveStrategy((await params).id);
  if (!access.ok) return access.response;
  try {
    return NextResponse.json(await loadStrategyObject(access.admin, access.bag, access.viewerUserId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
