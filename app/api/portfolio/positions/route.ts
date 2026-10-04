import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { getBagById } from '@/lib/server/bag-repo';
import { getDisplayPriceProvider } from '@/lib/server/price-provider';
import { settleUnsettledPurchasesForUser } from '@/lib/server/purchase-execution';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';
import { valueUserPositions } from '@/lib/server/position-valuation';
import { listAllLedgerEventsForPosition } from '@/lib/server/ledger-repo';
import { computePositionPnl } from '@/lib/domain/basket-protocol/accounting/position-pnl';

// -----------------------------------------------------------------------------
// GET /api/portfolio/positions — the signed-in user's Bag positions, valued
// from holdings (Accounting V2 / A4, docs/ACCOUNTING_V2_DESIGN.md §7), not
// shares × NAV:
//
//   strategyExposure   what BAG tracks for the strategy, at verified prices
//   observedWallet     what of it is still in the wallet
//   effectivePosition  the wallet's balance attributed to the strategy (sellable)
//   hasDrift           the wallet holds less than BAG tracks
//
// Cost basis and realized P&L come from the ledger (A3: average cost,
// verified proceeds only). Any number that cannot be known right now — an
// unpriced asset, an unreadable balance — is null, never a guess. Estimated
// sale proceeds are not here: only a route quote can give them.
// -----------------------------------------------------------------------------

const priceProvider = getDisplayPriceProvider();

export interface PortfolioPositionView {
  bagId: string;
  bagName: string;
  bagSymbol: string;
  bagStatus: string;
  strategyExposure: string | null;
  observedWallet: string | null;
  effectivePosition: string | null;
  hasDrift: boolean;
  hasUnreadable: boolean;
  costBasis: string | null;
  realizedPnl: string | null;
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
    const values = await valueUserPositions(admin, getChainPublicClient('robinhood'), priceProvider, auth.session);

    const views = await Promise.all(
      [...values.values()].map(async (v): Promise<PortfolioPositionView | null> => {
        const bag = await getBagById(admin, v.bagId);
        if (!bag) return null;
        const pnl = await listAllLedgerEventsForPosition(admin, auth.session.userId, v.bagId)
          .then((events) => (events.length > 0 ? computePositionPnl(events) : null))
          .catch(() => null);
        return {
          bagId: bag.id,
          bagName: bag.name,
          bagSymbol: bag.symbol,
          bagStatus: bag.status,
          strategyExposure: v.strategyExposureQuote,
          observedWallet: v.observedWalletQuote,
          effectivePosition: v.effectivePositionQuote,
          hasDrift: v.hasDrift,
          hasUnreadable: v.hasUnreadable,
          costBasis: pnl?.costBasisQuote ?? null,
          realizedPnl: pnl?.realizedPnlQuote ?? null,
          quoteCurrency: 'USD',
        };
      })
    );

    return NextResponse.json({ positions: views.filter((v): v is PortfolioPositionView => v !== null) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
