import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

// -----------------------------------------------------------------------------
// Shared-secret auth for scheduler-triggered routes (settlement worker,
// reconciliation job) — these are never called by a signed-in user's
// browser, so `requireSession()` (cookie-based) is the wrong tool here.
// Standard "Authorization: Bearer <CRON_SECRET>" convention (matches
// Vercel Cron's own recommended pattern; works identically for any other
// external scheduler that can set one header).
//
// Fails closed: if `CRON_SECRET` is unset, EVERY call is rejected — never
// silently open. Set `CRON_SECRET` in the deployment's env before wiring
// up a scheduler to call these routes.
//
// Timing-safe comparison (`crypto.timingSafeEqual`), not `!==`/`===`: a
// plain string comparison short-circuits on the first mismatched byte, so
// its running time leaks how many leading bytes of a guess were correct —
// a real (if slow) attack surface for a long-lived, rarely-rotated shared
// secret sent over repeated requests. `timingSafeEqual` requires
// equal-length buffers, so a length check comes first; that length check
// alone leaks only the secret's LENGTH, not any of its content, which is
// an accepted, standard tradeoff for this kind of constant-time compare
// (there is no constant-time way to compare buffers of unknown/different
// lengths without first agreeing a fixed length, e.g. by hashing both
// sides — unnecessary complexity here since the length leak alone gives
// an attacker nothing usable).
// -----------------------------------------------------------------------------

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireCronSecret(req: NextRequest): NextResponse | null {
  const configured = process.env.CRON_SECRET;
  if (!configured) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured on this deployment — refusing all calls.' }, { status: 503 });
  }

  const header = req.headers.get('authorization');
  if (!header || !timingSafeStringEqual(header, `Bearer ${configured}`)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  return null;
}
