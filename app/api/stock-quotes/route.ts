import { NextRequest, NextResponse } from 'next/server';
import { getRobinhoodStockApi } from '@/lib/server/price-provider';
import { isFractionallyTradable } from '@/lib/domain/basket-protocol/pricing/robinhood-stock-api';
import { ROBINHOOD_CHAIN_ID } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// Display quotes for Robinhood Stock Tokens, from Robinhood's own
// /rhj/prices API (docs.robinhood.com/chain/stock-token-apis).
//
//   GET /api/stock-quotes?symbols=AAPL,TSLA
//
// Each symbol is resolved through the canonical /rhj/assets registry first; a
// symbol the registry does not list as an ACTIVE Robinhood Chain Stock Token
// is reported as NOT_A_STOCK_TOKEN, never looked up by ticker alone.
//
// bid/ask/mid are PER TOKEN (raw underlying bid/ask × currentMultiplier);
// rawBid/rawAsk are the API's underlying-equity values. This route is for
// display. NAV and purchase quotes go through getPriceProvider(), which adds
// staleness, spread, halt and cross-source checks.
//
// Server-side (not browser → api.robinhood.com) so every viewer shares one
// 15 s cache and the process-wide 60 req/s limiter.
// -----------------------------------------------------------------------------

const MAX_SYMBOLS = 25;
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,16}$/;

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('symbols') ?? '';
  const symbols = Array.from(new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)));
  if (symbols.length === 0) return NextResponse.json({ error: 'symbols is required' }, { status: 400 });
  if (symbols.length > MAX_SYMBOLS) return NextResponse.json({ error: `at most ${MAX_SYMBOLS} symbols` }, { status: 400 });
  if (!symbols.every((s) => SYMBOL_RE.test(s))) return NextResponse.json({ error: 'invalid symbol' }, { status: 400 });

  const api = getRobinhoodStockApi();
  const quotes: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const token = await api.tokenBySymbol(symbol);
        if (!token) {
          errors[symbol] = 'NOT_A_STOCK_TOKEN';
          return;
        }
        const q = await api.quote(token);
        quotes[symbol] = {
          symbol: token.symbol,
          name: token.name,
          chainId: ROBINHOOD_CHAIN_ID,
          address: token.address,
          assetType: 'STOCK_TOKEN',
          priceUSD: q.mid,
          priceSource: 'ROBINHOOD_STOCK_API',
          priceKind: 'INDICATIVE',
          logoURI: token.logoUrl,
          currency: q.currency,
          bid: q.bid,
          ask: q.ask,
          mid: q.mid,
          rawBid: q.rawBid,
          rawAsk: q.rawAsk,
          currentMultiplier: token.currentMultiplier,
          pendingMultiplier: token.pendingMultiplier,
          pendingMultiplierEffectiveTime: token.pendingMultiplierEffectiveTime,
          fractionallyTradable: isFractionallyTradable(token),
          spreadBps: Number.isFinite(q.spreadBps) ? q.spreadBps : null,
          dailyTradingVolume: q.dailyTradingVolume,
          isTradingHalt: q.isTradingHalt,
          generatedAt: q.generatedAt,
        };
      } catch {
        errors[symbol] = 'UNAVAILABLE';
      }
    })
  );

  return NextResponse.json(
    { quotes, errors, source: 'robinhood-api' },
    { status: 200, headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=15' } }
  );
}
