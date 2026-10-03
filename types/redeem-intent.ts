import { AssetIdentity } from './basket-protocol';
import {
  PurchaseIntentFailureCode,
  PurchaseIntentStatus,
  PurchaseIntentStepRecord,
  PURCHASE_INTENT_FAILURE_CODES,
  PURCHASE_INTENT_STATUSES,
  TERMINAL_PURCHASE_INTENT_STATUSES,
} from './purchase-intent';

// -----------------------------------------------------------------------------
// Phase 21 — Real Redemption (the exit-side counterpart to Phase 17/18's
// PurchaseIntent). Deliberately reuses PurchaseIntent's status vocabulary,
// step-record shape, and failure taxonomy rather than re-declaring parallel
// copies: a redemption's lifecycle (quote → wallet signature → on-chain
// confirm → accounting) is the SAME state machine run in reverse, not a
// different one — see lib/domain/basket-protocol/purchase-intent/
// state-machine.ts, which this file's statuses/step-statuses are directly
// compatible with (no redeem-specific state-machine file exists; the
// purchase one is imported and used as-is by redeem-execution.ts).
//
// What's genuinely different from a PurchaseIntent, and why this is its
// own type rather than a variant of that one:
//   - No single `inputAsset`/`inputAmountRaw` — a redemption's SOURCE is
//     however many distinct assets this depositor's OWN
//     `bag_investor_holdings` rows hold (see allocation.ts), sold into
//     ONE chosen `outputAsset`. `steps[].inputAsset` already carries each
//     leg's own source asset, so nothing top-level is lost by omitting it.
//   - `sharesRaw` here means "shares being REDEEMED (burned)", the
//     opposite direction of a PurchaseIntent's `sharesRaw` ("shares being
//     MINTED").
//   - `redeemValueQuote` mirrors `PurchaseIntent.depositAmount` (the
//     locked, quote-time human-decimal value in `outputAsset`'s
//     quote-currency terms) — same reason: needed as an honest, already-
//     computed value for `bag_investor_positions.cost_basis_quote`'s
//     REMOVAL, not re-derived from a share-price figure that may not
//     exist cleanly at redemption edges the way it doesn't at bootstrap.
// -----------------------------------------------------------------------------

export const REDEEM_INTENT_STATUSES = PURCHASE_INTENT_STATUSES;
export type RedeemIntentStatus = PurchaseIntentStatus;
export const TERMINAL_REDEEM_INTENT_STATUSES = TERMINAL_PURCHASE_INTENT_STATUSES;

export const REDEEM_INTENT_FAILURE_CODES = PURCHASE_INTENT_FAILURE_CODES;
export type RedeemIntentFailureCode = PurchaseIntentFailureCode;

/** Same per-step record shape a PurchaseIntent uses — see this file's module doc for why. */
export type RedeemIntentStepRecord = PurchaseIntentStepRecord;

export interface RedeemIntent {
  id: string;
  userId: string;
  walletAddress: string;
  bagId: string;
  /** Shares being redeemed (burned) by this intent — always `<=` the depositor's own `bag_investor_positions.sharesRaw` at creation time; re-checked again, inside a row lock, by `apply_redeem_execution()` at accounting time (see that function's doc — a burn can never be trusted from a stale snapshot the way a mint can). */
  sharesRaw: string;
  shareDecimals: number;
  outputAsset: AssetIdentity;
  outputDecimals: number;
  /** `computeRedeemFingerprint()`'s output at quote time — re-derived and compared at execute time (`prepareRedeemExecution()`) exactly like `PurchaseIntent.routeFingerprint`, just against redeem/fingerprint.ts instead of purchase-intent/fingerprint.ts. */
  routeFingerprint: string;
  /** `RedeemQuote.sharePrice` this intent was priced against (getRedeemQuote, shares.ts) — audit/display only, same role `PurchaseIntent.sharePriceAtQuote` plays; unlike that field, this is never `null` — a redemption is only ever quotable against a non-zero share supply (see `getRedeemQuote`'s own `ZeroShareSupplyError`). */
  sharePriceAtQuote: string;
  /** The locked, human-decimal, quote-currency value of this redemption at quote time (`RedeemQuote.grossValue`) — see module doc. */
  redeemValueQuote: string;
  steps: RedeemIntentStepRecord[];
  status: RedeemIntentStatus;
  failureCode: RedeemIntentFailureCode | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  executedAt: string | null;
  accountingAppliedAt: string | null;
  reconciliationAppliedAt: string | null;
}
