import { NextResponse } from 'next/server';
import { PurchaseExecutionError } from '@/lib/server/purchase-execution';

// -----------------------------------------------------------------------------
// Phase 17 — one place every purchase-intent route maps a typed
// `PurchaseExecutionError` (lib/server/purchase-execution.ts) to an HTTP
// status + JSON body, so the mapping can't drift between routes (spec
// Aşama 16: "Error handling raw LI.FI/provider errorlarını client'a
// sızdırmayacak" — every message here is already a human-safe string by
// the time it reaches this file; nothing here ever forwards a raw
// error/stack trace).
// -----------------------------------------------------------------------------

export function purchaseExecutionErrorResponse(error: PurchaseExecutionError): NextResponse {
  switch (error.kind) {
    case 'BAG_NOT_FOUND':
      return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    case 'NO_PUBLISHED_RECIPE':
      return NextResponse.json({ error: 'This Bag has no published recipe yet.' }, { status: 409 });
    case 'REGISTRY_INVALID':
      return NextResponse.json(
        { error: 'This Bag references one or more assets that are no longer verified in the registry.', details: error.details },
        { status: 409 }
      );
    case 'UNKNOWN_INPUT_ASSET':
      return NextResponse.json({ error: 'Unknown or unverified input asset.' }, { status: 400 });
    case 'PREVIEW_ERROR':
      return NextResponse.json({ error: error.message }, { status: 422 });
    case 'PRICE_UNAVAILABLE':
      return NextResponse.json(
        { error: 'Live pricing is temporarily unavailable. Please try again shortly.' },
        { status: 503 }
      );
    case 'STOCK_REGISTRY_UNAVAILABLE':
      return NextResponse.json(
        { error: "Robinhood's Stock Token registry can't be reached right now, so this Bag's stock tokens can't be re-checked. Please try again shortly.", code: 'STOCK_REGISTRY_UNAVAILABLE' },
        { status: 503 }
      );
    case 'VALUATION_UNAVAILABLE':
      return NextResponse.json(
        {
          error: `Your shares can't be priced right now: this Bag holds ${error.labels.join(', ')}, which this purchase doesn't buy and which has no usable price right now. Nothing was sent. Please try again later.`,
          code: 'VALUATION_UNAVAILABLE',
          assets: error.assets,
        },
        { status: 503 }
      );
    case 'QUOTE_FAILED':
      return NextResponse.json(
        { error: error.message, failureCode: error.failureCode, ...(error.composerFallback ? { composerFallback: error.composerFallback } : {}) },
        { status: 422 }
      );
    case 'PURCHASE_IN_PROGRESS':
      return NextResponse.json(
        {
          error: 'Your previous purchase of this Bag is still being confirmed on-chain. Try again in a few minutes.',
          intentId: error.intentId,
        },
        { status: 409 }
      );
    case 'REDEEM_IN_PROGRESS':
      return NextResponse.json(
        {
          error: 'You have a sale of this Bag in progress. Finish or cancel it, then buy again.',
          code: 'REDEEM_IN_PROGRESS',
          intentId: error.intentId,
        },
        { status: 409 }
      );
    case 'PROVIDER_SELECTION_UNAVAILABLE':
      return NextResponse.json(
        { error: 'Selecting a specific execution route is not available on this deployment.', code: 'PROVIDER_SELECTION_UNAVAILABLE' },
        { status: 409 }
      );
    case 'NOT_FOUND':
      return NextResponse.json({ error: 'Purchase intent not found.' }, { status: 404 });
    case 'FORBIDDEN':
      return NextResponse.json({ error: 'This purchase intent does not belong to you.' }, { status: 403 });
    case 'EXPIRED':
      return NextResponse.json({ error: 'This purchase quote has expired. Start a new purchase.' }, { status: 409 });
    case 'ROUTE_CHANGED':
      return NextResponse.json(
        { error: "This Bag's composition changed since this purchase was quoted. Start a new purchase." },
        { status: 409 }
      );
    case 'INVALID_STATE':
      return NextResponse.json({ error: `This purchase is not in a state that allows this action (${error.status}).` }, { status: 409 });
    case 'BAG_NOT_LIVE':
      return NextResponse.json(
        { error: 'This Bag is not live yet — it must be deployed on-chain before it can take investments.', status: error.status },
        { status: 409 }
      );
    case 'INVALID_TX_HASH':
      return NextResponse.json({ error: 'txHash must be a 0x-prefixed 32-byte transaction hash.' }, { status: 400 });
    case 'ASSETS_UNROUTABLE':
      return NextResponse.json(
        {
          error:
            error.reason === 'TOO_MUCH_UNROUTABLE'
              ? `Too much of this Bag has no swap route right now (${error.symbols.join(', ')}). Try again later.`
              : `No swap route right now for ${error.symbols.join(', ')}. This Bag can't be bought until liquidity exists.`,
          symbols: error.symbols,
          reason: error.reason,
        },
        { status: 422 }
      );
    case 'TX_ALREADY_USED':
      return NextResponse.json({ error: 'This transaction has already been used for another purchase or redemption.' }, { status: 409 });
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
