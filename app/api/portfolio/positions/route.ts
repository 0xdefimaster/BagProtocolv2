import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { listInvestorPositionsForUser } from '@/lib/server/bag-investor-position-repo';
import { getBagById } from '@/lib/server/bag-repo';
import { getBagNavSafe } from '@/lib/server/bag-nav';
import { getShareSupply } from '@/lib/server/bag-share-state-repo';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { getRedeemQuote } from '@/lib/domain/basket-protocol/shares/shares';
import { settleUnsettledPurchasesForUser } from '@/lib/server/purchase-execution';

// -----------------------------------------------------------------------------
// GET /api/portfolio/positions — the signed-in user's real Bag positions
// (bag_investor_positions), each with its cost basis and, when every holding
// can be priced right now, its current value (shares × NAV per share via the
// same getRedeemQuote the redeem preview uses). A Bag whose prices are
// unavailable is still listed, with `currentValue: null` — never a guessed
// number.
// -----------------------------------------------------------------------------

const priceProvider = getDisplayPriceProvider();

export interface PortfolioPositionView {
  bagId: string;
  bagName: string;
  bagSymbol: string;
  bagStatus: string;
  sharesRaw: string;
  shareDecimals: number;
  costBasis: string;
  currentValue: string | null;
  quoteCurrency: string;
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const admin = supabaseAdmin();
    // A purchase whose window was closed before confirmation is still CONFIRMING: verify it now
    // (on-chain, idempotent, this user's own intents only) so the position below includes it.
    await settleUnsettledPurchasesForUser(admin, auth.session);
    const positions = (await listInvestorPositionsForUser(admin, auth.session.userId)).filter((p) => BigInt(p.sharesRaw) > BigInt(0));

    const views = await Promise.all(
      positions.map(async (p): Promise<PortfolioPositionView | null> => {
        const bag = await getBagById(admin, p.bagId);
        if (!bag) return null;
        let currentValue: string | null = null;
        let quoteCurrency = 'USD';
        const [navOutcome, supply] = await Promise.all([getBagNavSafe(admin, p.bagId, priceProvider), getShareSupply(admin, p.bagId)]);
        if (navOutcome.ok) {
          quoteCurrency = navOutcome.nav.quoteCurrency;
          try {
            currentValue = getRedeemQuote(navOutcome.nav, supply, p.sharesRaw).grossValue;
          } catch {
            currentValue = null;
          }
        }
        return {
          bagId: bag.id,
          bagName: bag.name,
          bagSymbol: bag.symbol,
          bagStatus: bag.status,
          sharesRaw: p.sharesRaw,
          shareDecimals: p.shareDecimals,
          costBasis: p.costBasisQuote,
          currentValue,
          quoteCurrency,
        };
      })
    );

    return NextResponse.json({ positions: views.filter((v): v is PortfolioPositionView => v !== null) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
