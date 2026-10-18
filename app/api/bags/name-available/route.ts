import { NextResponse } from 'next/server';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { isBagNameAvailable } from '@/lib/server/bag-repo';
import { validateBagText } from '@/lib/server/bag-text';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';

// GET /api/bags/name-available?name=… — whether a Bag name is still free (migration 0058: names are unique,
// case and spacing ignored). Read-only and a hint for the Create page: creating the Bag checks again.

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };

export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const name = new URL(req.url).searchParams.get('name') ?? '';
  const textIssue = validateBagText({ name });
  if (textIssue) return NextResponse.json({ error: textIssue }, { status: 400 });

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `bag-name:ip:${getClientIp(req)}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  try {
    return NextResponse.json({ available: await isBagNameAvailable(admin, name) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
