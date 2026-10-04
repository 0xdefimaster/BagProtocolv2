import { NextResponse } from 'next/server';
import { RedeemExecutionError } from '@/lib/server/redeem-execution';

// -----------------------------------------------------------------------------
// Phase 21 — redeem-side counterpart to purchase-intent-http.ts. Same role:
// one place every redeem route maps a typed `RedeemExecutionError` to an
// HTTP status + JSON body, so raw provider/DB errors never reach the
// client and the mapping can't drift between routes.
// -----------------------------------------------------------------------------

export function redeemExecutionErrorResponse(error: RedeemExecutionError): NextResponse {
  switch (error.kind) {
    case 'BAG_NOT_FOUND':
      return NextResponse.json({ error: 'Bag not found.' }, { status: 404 });
    case 'UNKNOWN_OUTPUT_ASSET':
      return NextResponse.json({ error: 'Unknown or unverified output asset.' }, { status: 400 });
    case 'PRICE_UNAVAILABLE':
      return NextResponse.json({ error: 'Live pricing is temporarily unavailable. Please try again shortly.' }, { status: 503 });
    case 'NO_POSITION':
      return NextResponse.json({ error: 'You have no position in this Bag to redeem.' }, { status: 409 });
    case 'INSUFFICIENT_POSITION':
      return NextResponse.json(
        { error: `Cannot redeem ${error.requestedRaw} — you only hold ${error.ownedRaw}.` },
        { status: 422 }
      );
    case 'ZERO_SUPPLY':
      return NextResponse.json({ error: 'This Bag has no outstanding shares to redeem.' }, { status: 409 });
    case 'QUOTE_FAILED':
      return NextResponse.json({ error: error.message, failureCode: error.failureCode }, { status: 422 });
    case 'REDEEM_IN_PROGRESS':
      return NextResponse.json({ error: 'A redemption is already in progress for this Bag.', intentId: error.intentId }, { status: 409 });
    case 'NOT_FOUND':
      return NextResponse.json({ error: 'Redeem intent not found.' }, { status: 404 });
    case 'FORBIDDEN':
      return NextResponse.json({ error: 'This redeem intent does not belong to you.' }, { status: 403 });
    case 'EXPIRED':
      return NextResponse.json({ error: 'This redemption quote has expired. Start a new redemption.' }, { status: 409 });
    case 'ROUTE_CHANGED':
      return NextResponse.json(
        { error: 'Your position or wallet balance changed since this sale was quoted. Start a new sale.' },
        { status: 409 }
      );
    case 'INVALID_STATE':
      return NextResponse.json({ error: `This redemption is not in a state that allows this action (${error.status}).` }, { status: 409 });
    case 'INVALID_TX_HASH':
      return NextResponse.json({ error: 'txHash must be a 0x-prefixed 32-byte transaction hash.' }, { status: 400 });
    case 'TX_ALREADY_USED':
      return NextResponse.json({ error: 'This transaction has already been used for another purchase or redemption.' }, { status: 409 });
    case 'FEE_ROUTER_REQUIRED':
      return NextResponse.json(
        { error: 'This Bag charges a performance fee, so it can only be redeemed through the on-chain fee router.' },
        { status: 409 }
      );
    case 'INVALID_FRACTION':
      return NextResponse.json({ error: 'Choose how much of the position to sell (between 0.01% and 100%).' }, { status: 400 });
    case 'NOTHING_TO_SELL':
      return NextResponse.json({ error: 'Your wallet holds nothing of this position that can be sold.' }, { status: 409 });
    case 'BALANCE_UNAVAILABLE':
      return NextResponse.json({ error: 'Your wallet balances could not be read right now. Please try again shortly.' }, { status: 503 });
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
