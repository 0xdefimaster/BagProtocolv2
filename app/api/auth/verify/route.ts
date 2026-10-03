import { NextRequest, NextResponse } from 'next/server';
import { verifyMessage } from 'viem';
import { consumeNonce } from '@/lib/auth/nonce';
import { createSessionToken, setSessionCookie } from '@/lib/auth/session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { STARTING_DEMO_BALANCE } from '@/lib/config/market';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';

const VERIFY_RATE_LIMIT = { windowSeconds: 60, maxRequests: 20 };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]+$/;

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase is not configured on this deployment yet.' },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => null);
  const walletAddress = typeof body?.walletAddress === 'string' ? body.walletAddress : null;
  const signature = typeof body?.signature === 'string' ? body.signature : null;
  const nonce = typeof body?.nonce === 'string' ? body.nonce : null;

  if (!walletAddress || !ADDRESS_RE.test(walletAddress) || !signature || !SIGNATURE_RE.test(signature) || !nonce) {
    return NextResponse.json(
      { error: 'walletAddress, signature and nonce are all required.' },
      { status: 400 }
    );
  }

  const ip = getClientIp(req);
  const limit = await checkRateLimit(supabaseAdmin(), `verify:ip:${ip}`, VERIFY_RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  // One-time-use nonce lookup — returns the exact message that was signed,
  // or null if it's missing, mismatched, or expired (already deleted either way).
  let message: string | null;
  try {
    message = await consumeNonce(walletAddress, nonce);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
  if (!message) {
    return NextResponse.json(
      { error: 'Sign-in request expired or was already used. Request a new one and try again.' },
      { status: 401 }
    );
  }

  const isValidSignature = await verifyMessage({
    address: walletAddress as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  }).catch(() => false);

  if (!isValidSignature) {
    return NextResponse.json({ error: 'Signature does not match this wallet.' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const normalizedAddress = walletAddress.toLowerCase();

  // Production-hardening P1-9 — atomic get-or-create (supabase/migrations/
  // 0032_add_get_or_create_wallet_user_rpc.sql), replacing the old
  // select-then-insert-user-then-insert-portfolio sequence. Two concurrent
  // first logins for the same wallet used to race: both could see "no
  // existing user" and both attempt the `users` insert, with the second
  // hitting a raw unique-violation 500 instead of just succeeding with the
  // (now-existing) row. This RPC folds both inserts into one
  // concurrency-safe upsert — see the migration's own doc for exactly how.
  const { data, error: rpcError } = await admin.rpc('get_or_create_wallet_user', {
    p_wallet_address: normalizedAddress,
    p_starting_cash_balance: STARTING_DEMO_BALANCE,
  });

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; wallet_address: string; display_name: string | null }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: 'Could not create or find a user for this wallet.' }, { status: 500 });
  }

  const user = { id: row.id, wallet_address: row.wallet_address, display_name: row.display_name };

  try {
    const token = await createSessionToken({ userId: user.id, walletAddress: user.wallet_address });
    await setSessionCookie(token);
  } catch (err) {
    // e.g. SESSION_SECRET missing or too short — a JSON error the client can
    // show, instead of an HTML 500 page it cannot parse.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({
    user: { id: user.id, walletAddress: user.wallet_address, displayName: user.display_name },
  });
}
