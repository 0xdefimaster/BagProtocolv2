import { NextRequest, NextResponse } from 'next/server';
import { issueNonce, siteFromRequest } from '@/lib/auth/nonce';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Per-IP: bounds how many nonces one caller can request (spam/enumeration).
// Per (IP, wallet): bounds retries for one wallet from one caller. Keyed by
// IP too on purpose — a wallet-only bucket let anyone exhaust a victim's
// limit and lock them out of signing in.
const IP_RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };
const WALLET_RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase is not configured on this deployment yet.' },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => null);
  const walletAddress = typeof body?.walletAddress === 'string' ? body.walletAddress : null;

  if (!walletAddress || !ADDRESS_RE.test(walletAddress)) {
    return NextResponse.json({ error: 'A valid walletAddress is required.' }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const ip = getClientIp(req);
  const [ipLimit, walletLimit] = await Promise.all([
    checkRateLimit(admin, `nonce:ip:${ip}`, IP_RATE_LIMIT),
    checkRateLimit(admin, `nonce:wallet:${ip}:${walletAddress.toLowerCase()}`, WALLET_RATE_LIMIT),
  ]);
  const tightest = !ipLimit.allowed ? ipLimit : !walletLimit.allowed ? walletLimit : ipLimit;
  if (!tightest.allowed) {
    return NextResponse.json(rateLimitedResponseBody(tightest.retryAfterSeconds), { status: 429 });
  }

  try {
    const { nonce, message } = await issueNonce(walletAddress, siteFromRequest(req));
    return NextResponse.json({ nonce, message });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
