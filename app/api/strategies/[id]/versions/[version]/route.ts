import { NextRequest, NextResponse } from 'next/server';
import { buildBagJson, loadStrategyVersionRows } from '@/lib/server/strategy-api';
import { resolveStrategy } from '@/lib/server/strategy-http';

// GET /api/strategies/:id/versions/:version — bag.json v1 of that version
// (types/strategy.ts). Stable: a stored version's document never changes.
// Becomes get_strategy_definition().

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; version: string }> }) {
  const { id, version } = await params;
  const access = await resolveStrategy(id);
  if (!access.ok) return access.response;
  if (!/^[1-9]\d{0,8}$/.test(version)) return NextResponse.json({ error: 'Version not found.' }, { status: 404 });
  try {
    const row = (await loadStrategyVersionRows(access.admin, access.bag.id)).find((r) => r.version === Number(version));
    if (!row) return NextResponse.json({ error: 'Version not found.' }, { status: 404 });
    return NextResponse.json(buildBagJson(access.bag, row));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
