import { NextRequest, NextResponse } from 'next/server';
import { GET as bagExecutions } from '@/app/api/bags/[id]/executions/route';
import { isStrategyId } from '@/lib/server/strategy-api';

// GET /api/users/me/strategies/:id/executions — the signed-in user's own
// execution receipts in this strategy (receipt v2, types/execution-receipt.ts).
// Same handler, auth, visibility and pagination as GET /api/bags/:id/executions;
// this is its path in the Strategy API. Aggregate strategy-level provenance
// will live at /api/strategies/:id/executions (not built yet). Becomes the MCP
// get_my_executions() tool.

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // A malformed id never reaches the database (it would surface a Postgres error).
  if (!isStrategyId(id)) return NextResponse.json({ error: 'Strategy not found.' }, { status: 404 });
  return bagExecutions(req, { params: Promise.resolve({ id: id.toLowerCase() }) });
}
