import { NextResponse } from 'next/server';
import {
  AnotherSaleOpenError,
  CreatorFrozenError,
  ExecutorMismatchError,
  NothingToSettleError,
  SettlementNotConfiguredError,
  SettlementPlanMissingError,
  SettlementStateChangedError,
} from '@/lib/server/redeem-settlement-attestation';
import {
  BalanceUnavailableError,
  ExecutionPriceTooLowError,
  FeeBasisUnavailableError,
  PositionBusyError,
  PriceUnavailableForSaleError,
  SaleNoLongerCoveredError,
  SaleQuoteExpiredError,
} from '@/lib/server/redeem-fee-attestation';

/** Maps the settlement attestation's failures to HTTP. Every one of them means nothing was signed. */
export function settlementErrorResponse(err: unknown) {
  const body = (code: string, extra: Record<string, unknown> = {}) => ({ error: (err as Error).message, code, ...extra });
  if (err instanceof SettlementNotConfiguredError) return NextResponse.json(body('SETTLEMENT_NOT_CONFIGURED'), { status: 503 });
  if (err instanceof BalanceUnavailableError) return NextResponse.json(body('BALANCE_UNAVAILABLE'), { status: 503 });
  if (err instanceof SaleNoLongerCoveredError) return NextResponse.json(body('ROUTE_EXPIRED', { failureCode: 'ROUTE_EXPIRED' }), { status: 409 });
  if (err instanceof SaleQuoteExpiredError) return NextResponse.json(body('SALE_QUOTE_EXPIRED'), { status: 409 });
  if (err instanceof SettlementPlanMissingError) return NextResponse.json(body('SETTLEMENT_PLAN_MISSING'), { status: 409 });
  if (err instanceof SettlementStateChangedError) return NextResponse.json(body('SETTLEMENT_STATE_CHANGED'), { status: 409 });
  if (err instanceof ExecutorMismatchError) return NextResponse.json(body('EXECUTOR_MISMATCH'), { status: 409 });
  if (err instanceof AnotherSaleOpenError) return NextResponse.json(body('ANOTHER_SALE_OPEN', { otherIntentId: err.otherIntentId }), { status: 409 });
  if (err instanceof PositionBusyError) return NextResponse.json(body('POSITION_BUSY'), { status: 409 });
  if (err instanceof CreatorFrozenError) return NextResponse.json(body('CREATOR_FROZEN'), { status: 422 });
  if (err instanceof FeeBasisUnavailableError) return NextResponse.json(body('FEE_BASIS_UNAVAILABLE', { reason: err.reason }), { status: 422 });
  if (err instanceof ExecutionPriceTooLowError) {
    return NextResponse.json(body('EXECUTION_PRICE_TOO_LOW', { deviationBps: err.deviationBps, maxDeviationBps: err.maxDeviationBps }), { status: 422 });
  }
  if (err instanceof PriceUnavailableForSaleError) return NextResponse.json(body('PRICE_UNAVAILABLE'), { status: 422 });
  if (err instanceof NothingToSettleError) return NextResponse.json(body('NOTHING_TO_SETTLE'), { status: 422 });
  return NextResponse.json({ error: 'The sale could not be prepared. Nothing was signed.' }, { status: 500 });
}
