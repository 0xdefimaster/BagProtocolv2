import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/require-session';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import {
  getPortfolio,
  listTrades,
  commitInvestmentTransaction,
  getTradesByIds,
  CommitLegInput,
} from '@/lib/server/trading-repo';
import { getUserPoints } from '@/lib/server/points-repo';
import { applyTrade, round } from '@/lib/domain/trading/engine';
import { getCurrentSeason } from '@/lib/server/season-repo';
import { Portfolio, TradableSymbol, TRADABLE_SYMBOLS, TradeSide } from '@/types/domain';
import {
  getTradingPriceFeed,
  TradingPriceUnavailableError,
} from '@/lib/server/trading-price-provider';

// -----------------------------------------------------------------------------
// Server-enforced trading. This is the route lib/services/trading-service.ts's
// executeTrade()/investInBag() used to run entirely client-side (localStorage
// read -> mutate -> write). Same domain logic (applyTrade is the exact same
// pure function, unchanged) but now: the client only ever sends symbol/side/
// quantity — it never sends a resulting balance or PnL, and the
// authenticated userId always comes from the session cookie, never the
// request body.
//
// Phase 18.6 — the execution `price` is no longer one of those client-sent
// fields either. `lib/server/trading-price-provider.ts` is the sole trusted
// source; any `price`/`prices` a client sends is ignored entirely.
//
// Phase 18.6 follow-up — INVEST ATOMICITY (planning). `planInvestment()`
// below validates and prices EVERY required leg, and computes the full
// resulting portfolio in memory via the same pure `applyTrade()`, BEFORE any
// write — if any required leg is unpriced/invalid/non-tradable, or the
// sequence doesn't validate, the entire invest is rejected with zero trades
// and zero portfolio changes. This function is pure/in-memory and unchanged
// by Phase 18.7 below.
//
// Phase 18.7 — INVEST ATOMICITY (commit). Phase 18.6's commit loop still
// called persistPortfolio()/insertTrade() as separate Supabase REST calls
// per leg, so a DB failure/timeout/network error between two of those calls
// could leave a partial commit (portfolio updated, a trade missing, or vice
// versa). Both the invest() commit loop AND a single BUY/SELL now go through
// `commitInvestmentTransaction()` (lib/server/trading-repo.ts), which wraps
// ONE atomic Postgres RPC (`commit_investment_transaction` —
// supabase/schema.sql) that applies the portfolio mutation + every trade
// insert + points/related accounting inside a single real DB transaction.
// Any failure there rolls back everything; nothing partial is ever
// persisted. See that RPC's doc comment for the row-locking (concurrency),
// idempotency-key, and stale-plan-detection design.
// -----------------------------------------------------------------------------

function isTradableSymbol(symbol: string): symbol is TradableSymbol {
  return (TRADABLE_SYMBOLS as readonly string[]).includes(symbol);
}

interface InvestLeg {
  symbol: TradableSymbol;
  price: number;
  quantity: number;
  allocatedUsd: number;
}

type PlanInvestmentResult =
  | { ok: true; legs: InvestLeg[]; finalPortfolio: Portfolio }
  | { ok: false; error: string };

interface CompositionEntry {
  symbol: TradableSymbol;
  weight: number;
}

type CompositionValidationResult =
  | { ok: true; entries: CompositionEntry[] }
  | { ok: false; error: string };

// A composition's weights are literal percentages that must sum to exactly
// 100 — NOT basis points, and NOT normalized against whatever the entries
// happen to add up to (see `validateInvestmentComposition` below). This
// epsilon exists ONLY to absorb IEEE-754 addition noise (e.g.
// 33.33 + 33.33 + 33.34 landing a few ULPs off 100) — it is not a tolerance
// for a genuine misallocation like 60 + 30 = 90. Real examples: 60 + 40 = 100
// passes; 50 + 30 = 80 and 70 + 50 = 120 are both rejected outright.
const WEIGHT_SUM_EPSILON = 1e-9;

/**
 * Phase 18.7 final hardening — strict, non-normalizing structural validation
 * of an invest() composition, run BEFORE any price-feed call or planning.
 * All of the following must hold or the WHOLE composition is rejected with
 * zero trades and zero writes (same all-or-nothing contract as the rest of
 * `planInvestment`):
 *   - composition is a non-empty array
 *   - every entry has a string symbol and a numeric weight
 *   - every weight is finite AND strictly > 0 (a 0 or negative weight is a
 *     rejection now, not a silently-dropped leg — see git history for the
 *     prior "weight-0 is skipped" behavior this replaces)
 *   - no symbol appears more than once
 *   - every symbol is TRADABLE
 *   - the weights sum to EXACTLY 100 (within `WEIGHT_SUM_EPSILON` float
 *     slop only) — a composition that sums to anything else is rejected,
 *     never silently rescaled/normalized to 100
 */
function validateInvestmentComposition(composition: unknown): CompositionValidationResult {
  if (!Array.isArray(composition) || composition.length === 0) {
    return { ok: false, error: 'composition must be a non-empty array.' };
  }

  const entries: CompositionEntry[] = [];
  const seenSymbols = new Set<string>();

  for (const entry of composition) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { symbol?: unknown }).symbol !== 'string' ||
      typeof (entry as { weight?: unknown }).weight !== 'number'
    ) {
      return { ok: false, error: 'Each composition entry needs a string symbol and a numeric weight.' };
    }

    const { symbol, weight } = entry as { symbol: string; weight: number };

    if (!Number.isFinite(weight) || weight <= 0) {
      return {
        ok: false,
        error: `"${symbol}" has an invalid weight (${weight}) — every weight must be finite and greater than 0.`,
      };
    }

    if (seenSymbols.has(symbol)) {
      return { ok: false, error: `Duplicate symbol "${symbol}" in composition — each asset may appear at most once.` };
    }
    seenSymbols.add(symbol);

    if (!isTradableSymbol(symbol)) {
      return { ok: false, error: `"${symbol}" is not a tradable asset — investment rejected.` };
    }

    entries.push({ symbol, weight });
  }

  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (Math.abs(total - 100) > WEIGHT_SUM_EPSILON) {
    return { ok: false, error: `Composition weights must sum to exactly 100 — got ${total}.` };
  }

  return { ok: true, entries };
}

/**
 * Validates and prices every leg of an invest() request with NO writes —
 * pure price-feed read + in-memory `applyTrade()` folding. Returns either
 * the full ordered list of legs to execute plus the resulting portfolio, or
 * a single error covering the whole request. Called BEFORE any DB write.
 *
 * Phase 18.7 final hardening — the structural composition checks
 * (non-empty, finite positive weights, no duplicates, all-tradable,
 * weights sum to exactly 100, never normalized) now run FIRST, via
 * `validateInvestmentComposition`, before the trusted price feed is even
 * called. Trusted-price validation, zero-write failure behavior, and the
 * atomic-commit/idempotency/stale-portfolio handling further down are
 * unchanged from Phase 18.6/18.7.
 */
async function planInvestment(
  startingPortfolio: Portfolio,
  amount: number,
  composition: unknown
): Promise<PlanInvestmentResult> {
  const validated = validateInvestmentComposition(composition);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const requiredEntries = validated.entries;

  // Every leg must resolve to a real, trusted price — a client-sent
  // `prices` value is never consulted (see the module doc above). One
  // upstream CoinGecko call, shared by every leg via ServerTradingPriceFeed's
  // own caching.
  const trustedPrices = await getTradingPriceFeed().getPrices();

  for (const { symbol } of requiredEntries) {
    const price = trustedPrices[symbol];
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return { ok: false, error: `No trusted price available for "${symbol}" — investment rejected.` };
    }
  }

  // Fold every leg through the SAME pure engine a single BUY uses,
  // sequentially, entirely in memory — this both computes the exact
  // quantity/allocatedUsd for each leg AND proves the whole sequence is
  // valid (e.g. rounding doesn't push the running total over the cash on
  // hand) before a single row is written.
  let runningPortfolio = startingPortfolio;
  const legs: InvestLeg[] = [];

  for (const { symbol, weight } of requiredEntries) {
    const price = trustedPrices[symbol] as number;
    const allocatedUsd = round((amount * weight) / 100, 2);
    if (allocatedUsd <= 0) continue; // genuinely nothing to trade for this leg, not a price problem

    const quantity = allocatedUsd / price;
    const result = applyTrade({ portfolio: runningPortfolio, symbol, side: 'BUY', quantity, price });
    if (!result.ok || !result.portfolio) {
      return { ok: false, error: result.error ?? `Could not execute the "${symbol}" leg — investment rejected.` };
    }

    runningPortfolio = result.portfolio;
    legs.push({ symbol, price, quantity, allocatedUsd });
  }

  if (legs.length === 0) {
    return { ok: false, error: 'composition resolved to no executable legs.' };
  }

  return { ok: true, legs, finalPortfolio: runningPortfolio };
}

/**
 * A DB-level failure from commit_investment_transaction (a raw Postgres
 * error, connection drop, etc — as opposed to the typed PORTFOLIO_STALE
 * outcome, which gets its own message) is never returned to the client
 * verbatim (spec: no raw DB errors on the wire). The internal detail stays
 * in the server log; the client gets a generic, stable error code plus a
 * correlation id it can quote back for support.
 */
function commitFailureResponse(requestId: string, rawError: string) {
  console.error(`[trades] INVESTMENT_COMMIT_FAILED requestId=${requestId}:`, rawError);
  return NextResponse.json(
    {
      ok: false,
      error: 'We could not complete this investment. Please try again.',
      code: 'INVESTMENT_COMMIT_FAILED',
      requestId,
      trades: [],
    },
    { status: 500 }
  );
}

/**
 * Phase 18.9 — PORTFOLIO_STALE now carries a freshly re-fetched portfolio
 * in the response body, not just an error string. Without this, the only
 * way for a caller to recover was a SEPARATE `GET /api/portfolio` round
 * trip it had to know to make itself; a caller that just retried the same
 * stale plan would immediately hit PORTFOLIO_STALE again. `usePaperPortfolio
 * .invest()` (the one real caller today) uses this to refresh its own state
 * and surface the fresh portfolio to whatever UI eventually re-prompts the
 * user for a new allocation — it deliberately does NOT auto-retry the
 * commit with a silently recomputed plan; see that hook's own doc comment.
 */
async function portfolioStaleResponse(admin: ReturnType<typeof supabaseAdmin>, userId: string) {
  const freshPortfolio = await getPortfolio(admin, userId);
  return NextResponse.json(
    {
      ok: false,
      error: 'PORTFOLIO_STALE',
      message: 'Your portfolio changed since this was priced — refresh and re-plan before retrying.',
      trades: [],
      portfolio: freshPortfolio,
    },
    { status: 409 }
  );
}

/**
 * Phase 18.9 — a client_trade_id collided with a DIFFERENT trade's content
 * (see the 0009 migration's module doc for the full case analysis). This
 * should only ever be reachable via a buggy/adversarial client — a
 * well-behaved one generates a fresh client_trade_id per leg per request —
 * but the RPC treats it as a hard, whole-transaction-rolling-back error
 * rather than a silent skip, so this maps it to a stable typed response
 * rather than falling through to the generic 500 commitFailureResponse
 * above (this isn't a DB-internal failure — the RPC is telling us exactly
 * what's wrong).
 */
function clientTradeIdConflictResponse(requestId: string) {
  console.error(`[trades] CLIENT_TRADE_ID_CONFLICT requestId=${requestId}`);
  return NextResponse.json(
    {
      ok: false,
      error: 'CLIENT_TRADE_ID_CONFLICT',
      message: 'This request conflicts with a previous, different trade. Nothing was changed.',
      code: 'CLIENT_TRADE_ID_CONFLICT',
      requestId,
      trades: [],
    },
    { status: 409 }
  );
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const trades = await listTrades(supabaseAdmin(), auth.session.userId);
  return NextResponse.json({ trades });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }

  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const userId = auth.session.userId;
  const requestId = crypto.randomUUID();

  try {
    if (body.action === 'invest') {
      const bagId = typeof body.bagId === 'string' ? body.bagId : null;
      const amount = Number(body.amount);
      // NOTE: `body.prices`, if the client sends it, is intentionally never
      // read. The execution price for every leg below comes exclusively
      // from the trusted server-side feed.
      //
      // Phase 18.7 — optional client-supplied idempotency key for the WHOLE
      // basket (one key per invest() request, not one per leg). A retried
      // request with the same investmentId (e.g. client retry after a
      // dropped response) returns the FIRST commit's result and writes
      // nothing a second time. If the client doesn't supply one, a fresh
      // uuid is used, so this request behaves exactly as a non-idempotent
      // one-shot commit — same as before this phase.
      const investmentId = typeof body.investmentId === 'string' ? body.investmentId : crypto.randomUUID();

      if (!bagId || !Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: 'bagId, composition and amount are required.' }, { status: 400 });
      }

      const portfolio = await getPortfolio(admin, userId);
      if (amount > portfolio.cashBalance) {
        return NextResponse.json({ ok: false, error: 'Insufficient demo cash balance.', trades: [] });
      }

      // Price + validate the ENTIRE investment before touching the
      // database. Any invalid/unpriced/non-tradable required leg rejects
      // the whole request — no trade, no portfolio change, no points, ever,
      // for a partial basket.
      const plan = await planInvestment(portfolio, amount, body.composition);
      if (!plan.ok) {
        return NextResponse.json({ ok: false, error: plan.error, trades: [] }, { status: 400 });
      }

      // Commit — ONE atomic RPC call for every leg (see module doc above).
      // invest() is BUY-only by construction (planInvestment only ever
      // folds BUY legs), so realizedPnL never changes and no points
      // accounting applies here (seasonId omitted) — matches Phase 18.6's
      // behaviour, where invest() never awarded points either.
      const legs: CommitLegInput[] = plan.legs.map((leg) => ({
        symbol: leg.symbol,
        side: 'BUY' as TradeSide,
        quantity: round(leg.quantity, 8),
        price: leg.price,
        totalValue: round(leg.quantity * leg.price, 2),
        realizedPnL: 0,
        clientTradeId: crypto.randomUUID(),
      }));

      const commit = await commitInvestmentTransaction(admin, {
        userId,
        investmentId,
        bagId,
        expectedPortfolioVersion: portfolio.portfolioVersion,
        finalPortfolio: plan.finalPortfolio,
        legs,
      });

      if (!commit.ok) {
        if (commit.error === 'PORTFOLIO_STALE') return portfolioStaleResponse(admin, userId);
        if (commit.error === 'CLIENT_TRADE_ID_CONFLICT') return clientTradeIdConflictResponse(requestId);
        return commitFailureResponse(requestId, commit.error);
      }

      const trades = await getTradesByIds(admin, commit.tradeIds);
      return NextResponse.json({
        ok: true,
        trades,
        portfolio: { ...plan.finalPortfolio, portfolioVersion: commit.portfolioVersion },
      });
    }

    // Single BUY/SELL
    const symbol = typeof body.symbol === 'string' ? body.symbol : null;
    const side = body.side === 'BUY' || body.side === 'SELL' ? (body.side as TradeSide) : null;
    const quantity = Number(body.quantity);
    const bagId = typeof body.bagId === 'string' ? body.bagId : undefined;
    const clientTradeId = typeof body.clientTradeId === 'string' ? body.clientTradeId : undefined;
    // NOTE: `body.price`, if the client sends it, is intentionally never
    // read — see the Phase 18.6 comment above.

    if (!symbol || !side || !Number.isFinite(quantity)) {
      return NextResponse.json({ error: 'symbol, side and quantity are required.' }, { status: 400 });
    }
    if (!isTradableSymbol(symbol)) {
      return NextResponse.json({ error: `Unsupported trading symbol: ${symbol}` }, { status: 400 });
    }

    let price: number;
    try {
      price = await getTradingPriceFeed().getPrice(symbol);
    } catch (err) {
      if (err instanceof TradingPriceUnavailableError) {
        return NextResponse.json(
          { error: `Live price for ${symbol} is temporarily unavailable. Please try again shortly.` },
          { status: 400 }
        );
      }
      throw err;
    }

    // A single trade is a one-leg "basket" — same atomic commit path as
    // invest() (see module doc above). `clientTradeId`, if the client sends
    // one, doubles as this request's whole-commit idempotency key (it was
    // already the per-trade dedup key before this phase, and a single trade
    // has exactly one leg, so the two keys are the same thing here).
    const investmentId = clientTradeId ?? crypto.randomUUID();

    const portfolio = await getPortfolio(admin, userId);
    const result = applyTrade({ portfolio, symbol, side, quantity, price });
    if (!result.ok || !result.portfolio) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }

    // Points accounting only ever applies on a SELL (a BUY never changes
    // realizedPnL) — same condition Phase 18.6 used before commit was
    // folded into the RPC. Current bagPoints/pointsSpent are read here,
    // outside the transaction, but the per-user portfolio row lock inside
    // commit_investment_transaction still makes this race-free: every
    // points-affecting write for this user goes through that same locked
    // section, so two concurrent SELLs can't both read stale values and
    // both "win".
    //
    // Production-hardening P0-6 — `seasonId` is the REAL current season
    // (date-derived, never the hardcoded GENESIS_SEASON constant), and
    // stays `null` when none is currently active. This treats "no active
    // season" exactly like "not a SELL": the trade itself still executes
    // and settles normally, it just never attaches points to a stale or
    // nonexistent season — the same "yalnızca gerçek current season'a
    // bağlanmalı" rule the points/leaderboard/box/NFT routes apply.
    let seasonId: string | null = null;
    let currentBagPoints = 0;
    let currentPointsSpent = 0;
    if (side === 'SELL') {
      const currentSeason = await getCurrentSeason(admin);
      if (currentSeason) {
        seasonId = currentSeason.id;
        const currentPoints = await getUserPoints(admin, userId, seasonId);
        currentBagPoints = currentPoints.bagPoints;
        currentPointsSpent = currentPoints.pointsSpent;
      }
    }

    const commit = await commitInvestmentTransaction(admin, {
      userId,
      investmentId,
      bagId: bagId ?? null,
      expectedPortfolioVersion: portfolio.portfolioVersion,
      finalPortfolio: result.portfolio,
      legs: [
        {
          symbol,
          side,
          quantity: round(quantity, 8),
          price,
          totalValue: result.totalValue ?? 0,
          realizedPnL: result.realizedPnL ?? 0,
          clientTradeId: clientTradeId ?? investmentId,
        },
      ],
      seasonId,
      currentBagPoints,
      currentPointsSpent,
    });

    if (!commit.ok) {
      if (commit.error === 'PORTFOLIO_STALE') return portfolioStaleResponse(admin, userId);
      if (commit.error === 'CLIENT_TRADE_ID_CONFLICT') return clientTradeIdConflictResponse(requestId);
      return commitFailureResponse(requestId, commit.error);
    }

    const trades = await getTradesByIds(admin, commit.tradeIds);
    return NextResponse.json(
      {
        ok: true,
        trade: trades[0] ?? null,
        portfolio: { ...result.portfolio, portfolioVersion: commit.portfolioVersion },
        pointsAwarded: commit.pointsAwarded,
      },
      { status: 200 }
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
