import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { ValidateBagInputError } from '@/lib/server/validate-bag';
import { parseDefinition, validateDefinition } from '@/lib/server/strategy-api';

// POST /api/strategies/validate — validate_bag on a bag.json v1 definition
// (body: { definition } or a whole bag.json). Same engine and rules as
// POST /api/bags/validate; also returns the definition's canonical form and
// definitionHash. Read-only; no session needed. Becomes the MCP validate_bag tool.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 30 };
// Only well-formed addresses reach the registry query (it is built into a PostgREST filter).
const QUERYABLE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  let definition;
  try {
    definition = parseDefinition(await req.json());
  } catch (err) {
    const message = err instanceof ValidateBagInputError ? err.message : 'Body must be valid JSON.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `strategy-validate:ip:${getClientIp(req)}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    const identities = definition.assets.filter((a) => QUERYABLE_ADDRESS.test(a.address)).map((a) => ({ chain: a.chain, address: a.address }));
    const registry = await getAssetsByIdentities(admin, identities);
    return NextResponse.json(validateDefinition(definition, registry));
  } catch (err) {
    if (err instanceof ValidateBagInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
