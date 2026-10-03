import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { ValidateBagInputError, parseValidateBagRequest, validateBag } from '@/lib/server/validate-bag';

// POST /api/bags/validate — validate_bag: checks a proposed composition and
// policy against BAG's rules and returns machine-readable findings
// (lib/server/validate-bag.ts). Read-only; no session needed. Becomes the MCP
// validate_bag tool.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 30 };
// Only well-formed addresses reach the registry query (it is built into a PostgREST filter);
// anything else is reported by the validators as INVALID_ADDRESS.
const QUERYABLE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  let request;
  try {
    request = parseValidateBagRequest(await req.json());
  } catch (err) {
    const message = err instanceof ValidateBagInputError ? err.message : 'Body must be valid JSON.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `bag-validate:ip:${getClientIp(req)}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    const chain = request.chain ?? 'robinhood';
    const identities = request.assets
      .map((a) => ({ chain: a.chain ?? chain, address: a.address }))
      .filter((i) => QUERYABLE_ADDRESS.test(i.address));
    const registry = await getAssetsByIdentities(admin, identities);
    return NextResponse.json(validateBag(request, registry));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
