import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { validateDisplayName } from '@/lib/profile/validate';
import { getUserProfile, updateUserProfile } from '@/lib/server/user-profile-repo';

// The signed-in user's own profile. The user id only ever comes from the
// session cookie, never from the request.
//
//   GET   /api/profile                      -> { profile }
//   PATCH /api/profile { displayName }      -> { profile }  (null clears it)

export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  const profile = await getUserProfile(supabaseAdmin(), auth.session.userId);
  if (!profile) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  return NextResponse.json({ profile });
}

export async function PATCH(req: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as { displayName?: unknown } | null;
  if (!body || !('displayName' in body)) return NextResponse.json({ error: 'Expected { displayName }.' }, { status: 400 });

  let displayName: string | null = null;
  if (body.displayName !== null) {
    const result = validateDisplayName(body.displayName);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    displayName = result.name;
  }

  try {
    const profile = await updateUserProfile(supabaseAdmin(), auth.session.userId, { displayName });
    return NextResponse.json({ profile });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not save profile.' }, { status: 502 });
  }
}
