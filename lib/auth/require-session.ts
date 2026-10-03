import { NextResponse } from 'next/server';
import { getSession, SessionPayload } from './session';

export type RequireSessionResult =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse };

/**
 * Every API route that reads or writes user-owned, client-non-forgeable
 * data (portfolio, trades, points) calls this first. There is no "trust the
 * userId the client sent" path anywhere in these routes — the only userId
 * that's ever used is the one embedded in the signed session cookie.
 */
export async function requireSession(): Promise<RequireSessionResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Not signed in. Connect your wallet and sign the login message first.' },
        { status: 401 }
      ),
    };
  }
  return { ok: true, session };
}
