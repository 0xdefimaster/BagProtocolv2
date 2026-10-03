import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { assembleBagNftForUser, SlotSelection } from '@/lib/server/nft-repo';
import { getAccessoryById } from '@/data/mock-accessories';
import { computeNftRarity } from '@/lib/domain/nft/rarity-engine';
import { getLeaderboard } from '@/lib/server/leaderboard-repo';
import { getCurrentSeason } from '@/lib/server/season-repo';
import { LEADERBOARD_TOP_N } from '@/lib/config/season';
import { checkRateLimit, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { ACCESSORY_SLOTS, Accessory, AccessorySlot } from '@/types/domain';

// Production-hardening P1-10 — per user.
const RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 };

// -----------------------------------------------------------------------------
// Phase 19 — server-enforced NFT assembly. Replaces
// lib/services/nft-service.ts's assembleBagNFT() (localStorage) — see
// lib/server/nft-repo.ts's doc and supabase/migrations/0010_add_assemble_bag_nft.sql
// for why consuming accessories and minting the NFT happen as one atomic
// call. genesisRank is computed here the same way the old client code did
// (lib/services/leaderboard-service.ts's board.self.rank), just against the
// real Postgres-backed leaderboard instead of the seeded-fake one.
// -----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `nfts-assemble:${auth.session.userId}`, RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const selection: SlotSelection = body && typeof body.selection === 'object' && body.selection !== null ? body.selection : {};

  const missing = ACCESSORY_SLOTS.filter((slot) => typeof selection[slot] !== 'string');
  if (missing.length > 0) {
    return NextResponse.json(
      { ok: false, error: `Missing accessories for: ${missing.join(', ')}` },
      { status: 400 }
    );
  }

  const resolved = {} as Record<AccessorySlot, Accessory>;
  for (const slot of ACCESSORY_SLOTS) {
    const accessory = getAccessoryById(selection[slot]!);
    if (!accessory) {
      return NextResponse.json({ ok: false, error: `Unknown accessory for ${slot}.` }, { status: 400 });
    }
    resolved[slot] = accessory;
  }
  const rarity = computeNftRarity(resolved);

  // Production-hardening P0-6 — assembling a Genesis NFT is inherently
  // season-scoped (genesisRank only means something relative to a real
  // season's leaderboard); without one currently active, this is rejected
  // explicitly rather than silently computed against a stale season id.
  const season = await getCurrentSeason(admin);
  if (!season) {
    return NextResponse.json({ ok: false, error: 'No active season right now.' }, { status: 400 });
  }
  const board = await getLeaderboard(admin, season.id, auth.session.userId, LEADERBOARD_TOP_N);
  const genesisRank = board.self && board.self.rank <= board.topN ? board.self.rank : undefined;

  const outcome = await assembleBagNftForUser(admin, auth.session.userId, season.id, selection, rarity, genesisRank);

  if (!outcome.ok) {
    const message = outcome.error.startsWith('INSUFFICIENT_ACCESSORIES')
      ? "You don't own one of the selected accessories anymore — refresh your inventory and try again."
      : outcome.error;
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, nft: outcome.nft });
}
