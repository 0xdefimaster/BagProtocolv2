import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null });
  }

  if (!isSupabaseConfigured()) {
    // Session cookie exists but there's nowhere to look the user up — treat
    // as signed out rather than trusting the cookie's claims blindly.
    return NextResponse.json({ user: null });
  }

  const { data: user } = await supabaseAdmin()
    .from('users')
    .select('*')
    .eq('id', session.userId)
    .maybeSingle();

  if (!user) {
    return NextResponse.json({ user: null });
  }

  return NextResponse.json({
    user: {
      id: user.id,
      walletAddress: user.wallet_address,
      displayName: user.display_name,
      avatarUrl: (user as { avatar_url?: string | null }).avatar_url ?? null,
    },
  });
}
