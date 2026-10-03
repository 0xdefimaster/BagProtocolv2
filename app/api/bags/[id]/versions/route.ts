import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById, getBagVersions } from '@/lib/server/bag-repo';
import { loadCreatorProfiles } from '@/lib/server/user-profile-repo';
import { getNavSnapshots } from '@/lib/server/bag-nav-snapshots';
import { buildVersionTimeline } from '@/lib/server/bag-version-timeline';

// GET /api/bags/:id/versions — the Bag's Version Timeline (newest first): each
// version's reason, author, composition, Strategy Diff from the version before,
// and NAV-per-share change while it was live (recorded snapshots only). Same
// visibility as GET /api/bags/:id: public for ACTIVE Bags, creator-only otherwise.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const admin = supabaseAdmin();
  const bag = await getBagById(admin, id);
  if (!bag) return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
  if (bag.status !== 'ACTIVE') {
    const auth = await requireSession();
    if (!auth.ok || auth.session.userId !== bag.creatorId) {
      return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    }
  }

  try {
    const versions = await getBagVersions(admin, bag.id);
    const [creators, snapshots] = await Promise.all([
      loadCreatorProfiles(admin, Array.from(new Set(versions.map((v) => v.createdBy)))),
      getNavSnapshots(admin, bag.id).catch(() => []),
    ]);
    return NextResponse.json({ versions: buildVersionTimeline(versions, bag.currentVersionId ?? null, snapshots, creators) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
