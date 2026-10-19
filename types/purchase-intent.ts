import { AssetIdentity, ChainId } from './basket-protocol';
// Type-only import: `ExecutionMode` is defined once, in the execution
// layer that produces it (lib/execution/types.ts), and referenced here
// rather than redeclared — two copies of this union drifting apart is
// exactly how a UI ends up describing a mode the compiler no longer emits.
// Erased at compile time, so this adds no runtime dependency from `types/`
// onto `lib/`.
import type { ExecutionMode } from '@/lib/execution/types';

// -----------------------------------------------------------------------------
// Phase 17 — Real Wallet + LI.FI Execution.
//
// A `PurchaseIntent` is the server-side canonical record that sits BETWEEN a
// computed `ExecutionPlan` (Phase 10, quote-only, no wallet) and a real,
// user-signed on-chain execution. Nothing about `ExecutionPlan`,
// `ExecutionAdapter`, or the Purchase Preview pipeline (lib/server/
// purchase-preview.ts) changes — this is a NEW layer that consumes their
// output.
//
// Critical invariants this type exists to make structurally checkable:
//   - `walletAddress` is always the SESSION's wallet address (lib/auth/
//     session.ts), never a client-supplied field on the create request.
//   - `steps[].inputAsset`/`outputAsset` always come from the registry-
//     validated `ExecutionPlan` this intent was built from — never
//     re-entered by the client at execute time.
//   - No field on this type ever holds a private key, seed phrase, or raw
//     wallet signature. `steps[].lifiStep` is a LI.FI quote/route payload
//     (public route data — token addresses, calldata targets, amounts),
//     not a credential.
// -----------------------------------------------------------------------------

export const PURCHASE_INTENT_STATUSES = [
  'DRAFT',
  'QUOTED',
  'READY',
  'AWAITING_SIGNATURE',
  'SUBMITTED',
  'CONFIRMING',
  'COMPLETED',
  // Phase 18 — spec 18.3: a multi-step on-chain execution is NOT atomic. A
  // transaction that already landed on-chain cannot be rolled back because
  // a LATER, independent step failed — so a mixed outcome (some SWAP steps
  // verified COMPLETED, some verified FAILED, none still in flight) is its
  // own state, never collapsed into plain FAILED (which would silently
  // discard the assets the succeeding steps actually received) or into
  // COMPLETED (which would mint the FULL quoted share amount against a
  // partially-fulfilled deposit).
  'PARTIAL_SUCCESS',
  // Reached once `reconcilePartialExecution()` has idempotently credited
  // `bag_holdings` for exactly the verified-COMPLETED steps of a
  // PARTIAL_SUCCESS intent (see purchase-execution.ts). Deliberately
  // terminal: computing a correct PARTIAL share-mint for the shortfall is
  // a real pricing decision this phase does not invent (spec 18.3: "Do
  // NOT invent a generic refund mechanism unless the existing protocol
  // actually supports one") — this state exists so the verified on-chain
  // result is preserved and visible for a follow-up/support process,
  // instead of being misreported as a plain failure.
  'RECONCILIATION_REQUIRED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type PurchaseIntentStatus = (typeof PURCHASE_INTENT_STATUSES)[number];

/** Terminal statuses — once reached, no further transition is ever valid (see state-machine.ts). `PARTIAL_SUCCESS` is deliberately NOT terminal: it always advances to `RECONCILIATION_REQUIRED` (possibly after a retried reconciliation call), so a status query never reports it as a dead end mid-reconciliation. */
export const TERMINAL_PURCHASE_INTENT_STATUSES: ReadonlySet<PurchaseIntentStatus> = new Set([
  'COMPLETED',
  'RECONCILIATION_REQUIRED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
]);

/** Typed failure taxonomy (spec Aşama 7) — the UI and any caller only ever sees one of these, never a raw provider error string. */
export const PURCHASE_INTENT_FAILURE_CODES = [
  'USER_REJECTED',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_ALLOWANCE',
  'SLIPPAGE_EXCEEDED',
  'ROUTE_EXPIRED',
  'TRANSACTION_REVERTED',
  'EXECUTION_TIMEOUT',
  'UNSUPPORTED_ROUTE',
  'PROVIDER_ERROR',
  'VERIFICATION_FAILED',
  'UNKNOWN_ERROR',
] as const;
export type PurchaseIntentFailureCode = (typeof PURCHASE_INTENT_FAILURE_CODES)[number];

export const PURCHASE_INTENT_STEP_STATUSES = [
  /** KEEP step, or a SWAP step not yet touched. */
  'PENDING',
  /** KEEP step — never routed, trivially "done" the moment the intent is created. */
  'NOT_NEEDED',
  'APPROVAL_REQUIRED',
  'APPROVAL_AWAITING_SIGNATURE',
  'APPROVAL_SUBMITTED',
  'APPROVAL_CONFIRMED',
  'AWAITING_SIGNATURE',
  'SUBMITTED',
  'CONFIRMING',
  'COMPLETED',
  'FAILED',
] as const;
export type PurchaseIntentStepStatus = (typeof PURCHASE_INTENT_STEP_STATUSES)[number];

/**
 * One step's execution record. Mirrors `ExecutionStep`/`ExecutionStepQuote`
 * (lib/blockchain/execution-adapter.ts) but adds the fields real execution
 * needs: a real (non-placeholder) LI.FI quote (`lifiStep`, opaque to the
 * server — it is only ever replayed back to LI.FI's own SDK client-side,
 * never inspected/mutated for business logic beyond what's typed below),
 * and per-step transaction tracking.
 */
export interface PurchaseIntentStepRecord {
  stepIndex: number;
  action: 'KEEP' | 'SWAP';
  targetSymbol: string;
  inputAsset: AssetIdentity;
  outputAsset: AssetIdentity;
  sourceChain: ChainId;
  destinationChain: ChainId;
  inputAmountRaw: string;
  targetValueRaw: string;

  /** Null for a KEEP step (never quoted) or a SWAP step whose real quote failed. */
  outputAmountRaw: string | null;
  outputDecimals: number | null;
  /** BAG's own minimum-output / verification floor for this step (the one `verifyExecution` checks). */
  minOutputRaw: string | null;
  /**
   * The minimum the execution PROVIDER enforces on chain at its own swap
   * boundary — today only Composer steps, from the same compile response
   * (`producedResources["swap_<i>.amountOut"].simulated.amountOutMin`).
   * `verifyExecution` uses it as a Composer leg's floor when `minOutputRaw`
   * is unset: the purchase flow sweeps the whole swap output from the proxy
   * to the wallet and takes no fee from it (an integrator fee comes off the
   * input), so a transaction that delivered less did not run the call BAG
   * built (F-01). A transfer-fee token would also land below it and fail
   * verification. Accounting never reads it. Absent or null on every other
   * path and on intents stored before it existed. Label it
   * "provider-enforced minimum", never "guaranteed minimum".
   */
  providerEnforcedMinOutputRaw?: string | null;
  route: string | null;

  /**
   * Opaque LI.FI `LiFiStep` JSON for a SWAP step, quoted against the REAL
   * connected wallet address (never `PLACEHOLDER_ADDRESS` — see
   * lib/blockchain/lifi-purchase-quote.ts). This is what the client passes
   * to `@lifi/sdk`'s `convertQuoteToRoute()`/`executeRoute()`. Null for a
   * KEEP step or a step whose quote failed.
   */
  lifiStep: unknown | null;

  status: PurchaseIntentStepStatus;
  approvalTxHash: string | null;
  txHash: string | null;
  /** LI.FI's own substatus/tool name once execution starts reporting one (spec Aşama 10's "destination execution pending/completed" distinction) — display/debugging only. */
  providerSubstatus: string | null;
  failureCode: PurchaseIntentFailureCode | null;
  /**
   * Redemptions: USD per whole unit of the sale's output token, fixed when the sale was quoted. Turns what arrived
   * into the USD proceeds the ledger books. Absent on sales into the settlement stablecoin (counted 1:1) and on
   * purchases.
   */
  outputUsdPrice?: string;
}

export interface PurchaseIntent {
  id: string;
  userId: string;
  walletAddress: string;
  bagId: string;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  /** BAG shares this deposit will mint, locked in at quote time — the exact `DepositQuote.sharesRaw` the Purchase Preview already showed the user (types/basket-protocol.ts). Minted verbatim on completion, never recomputed against NAV at execution time (that would let a moved market price silently change how many shares a signed-for purchase mints). */
  sharesRaw: string;
  shareDecimals: number;
  /** sha256 of the ExecutionPlan this intent was built from — see fingerprint.ts. Re-derived fresh at execute time and compared; a mismatch means the Bag's recipe/allocation moved since this intent was created and the intent must not execute (spec Aşama 3/9). */
  routeFingerprint: string;
  /** The Bag's `bag_versions.version` number this intent was quoted against (types/basket-protocol.ts's `BagVersionRecord`). Phase 18: locked alongside `compositionHash`/`routeFingerprint` so a re-published (even textually-identical-content-but-new-row) version is still detectable in an audit trail, independent of whether the hash actually changed. */
  recipeVersion: number;
  /** `BagVersionRecord.compositionHash` for the recipe this intent was quoted against — re-derived from the CURRENT recipe and compared at execute time (`prepareExecution`). Redundant with `routeFingerprint` in the common case (a changed recipe almost always changes both), but cheaper to compare and gives a distinct, more specific failure signal ("the Bag's composition itself changed" vs "the resulting execution plan changed", which can also happen from allocation-math changes alone). */
  compositionHash: string;
  /** The Bag's gross NAV this intent was quoted against — audit/reconciliation snapshot only (Phase 18 spec: "NAV snapshot ... intent'e kilitlensin"). Never re-read to recompute `sharesRaw` at execute time; see that field's doc for why. */
  navSnapshot: { grossNav: string; quoteCurrency: string; asOf: string };
  /** `DepositQuote.sharePrice` this intent was quoted against, or `null` for a bootstrap (zero-share-supply) deposit where no share price yet exists — same audit/reconciliation purpose as `navSnapshot`. */
  sharePriceAtQuote: string | null;
  /** Phase 20 — `DepositQuote.depositAmount` locked at quote time: the human decimal quote-currency amount this deposit is worth. Threaded into `apply_purchase_execution()` as this depositor's `bag_investor_positions.cost_basis_quote` delta on completion — deliberately NOT derived from `sharePriceAtQuote * sharesRaw`, since that's undefined for every bootstrap deposit (see that field's own doc, and `bag_investor_positions`'s migration). */
  depositAmount: string;
  steps: PurchaseIntentStepRecord[];
  /**
   * Non-null iff this intent's SWAP steps were built as ONE shared
   * Composer transaction (lib/blockchain/lifi-composer-adapter.ts,
   * lib/blockchain/lifi-purchase-quote.ts's `tryBuildComposerSteps`)
   * rather than N independent LI.FI routes. When set, the client signs
   * and submits THIS ONE transaction (not each step's `lifiStep`, which
   * is null for every step in that case) and the resulting single tx hash
   * gets reported for every SWAP step index — see
   * hooks/use-purchase-execution.ts. Deposit-only; always null for a
   * redemption (redeem-execution.ts never requests a Composer attempt —
   * see `ComposerAttemptOptions`'s own doc for why).
   */
  composerTransaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    userProxy: string;
    /** ERC-20 approvals (input token only) the wallet must send before this transaction; absent on older rows. */
    approvals?: { token: string; spender: string; amountRaw: string }[];
  } | null;
  /**
   * Non-null iff this intent's SWAP steps were built as ONE
   * `BagExecutionRouter.execute()` transaction (`lib/execution/providers/
   * bag-router-provider.ts`). Deliberately its OWN field, never folded into
   * `composerTransaction` — the two are shaped similarly ({to, data,
   * value, chainId}) but are NOT interchangeable: the BAG router pulls its
   * input via `transferFrom` and therefore needs a prior ERC-20 approval
   * the client must check/request (`inputToken`/`inputAmountRaw` below are
   * exactly what that approval needs), which Composer's flow does not.
   * `hooks/use-purchase-execution.ts` MUST check this field before
   * `composerTransaction` and route to its own BAG-router-specific
   * execution path — never `executeComposerTransaction()` — so a BAG
   * Router result can never be silently treated as a Composer one. Same
   * "one shared tx hash reported for every SWAP step index" convention as
   * `composerTransaction` — see that field's own doc. Always null for a
   * redemption and for any deposit whose selected provider wasn't
   * `bag-router`.
   */
  bagRouterTransaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    /** ERC-20 the router will pull via `transferFrom` — the approval target the client must check/request allowance for before sending `to`/`data`/`value`. */
    inputToken: string;
    /** Exact raw amount the router will pull — the approval floor; also the amount `verifyExecution()` re-checks the on-chain `ExecutionCompleted` event against. */
    inputAmountRaw: string;
    /** The on-chain bytes32 `bagId` (`BagFactory`/`Bag` identity encoding — `computeOnChainBagId()`) the signed plan was compiled for, so `verifyExecution()` can confirm the emitted `ExecutionCompleted` event attests to THIS bag, not merely to `to === routerAddress`. */
    bagOnChainId: string;
  } | null;
  /**
   * Which provider (`BagExecutionProvider.identify()` name — `'bag-router'
   * | 'lifi-composer' | 'lifi-sequential'`) actually compiled this intent's
   * execution, when the compiler layer produced one. Explicit, persisted
   * provider identity — never re-derived from `executionMode` (`SINGLE_TX`
   * is true for BOTH `bag-router` and `lifi-composer`, so mode alone
   * cannot tell them apart; the bridge that builds `steps`/
   * `composerTransaction`/`bagRouterTransaction` from a `CompiledExecution`
   * branches on this same field on the raw `CompiledExecution.providerId`,
   * never on `mode`). `null` for a legacy (flag-off) intent, which never
   * had a compiler-determined provider.
   */
  providerId: string | null;
  /**
   * sha256 fingerprint of the `BagExecutionGraph` (lib/execution/types.ts)
   * this intent's steps were compiled from — set only when created via
   * `compileBagExecution()` (`BAG_EXECUTION_COMPILER_ENABLED`, see
   * lib/config/execution.ts), `null` for every intent created via the
   * legacy `buildPurchaseIntentSteps()` path. `prepareExecution()`
   * re-derives and compares this at execute time, same role
   * `routeFingerprint` already plays for the pre-compiler `ExecutionPlan`
   * shape — see supabase/migrations/0022_add_execution_plan_hash.sql.
   */
  executionPlanHash: string | null;
  /**
   * What the compiled execution ACTUALLY requires from the wallet, as
   * determined by `compileBagExecution()` (`CompiledExecution.mode`,
   * lib/execution/types.ts) — persisted so the purchase UI can state the
   * real signature/transaction expectation instead of assuming one
   * transaction for every purchase. `null` for every legacy (flag-off)
   * intent, which never had a compiler-determined mode; the UI treats
   * null as "unknown" and describes the expectation from the intent's own
   * steps rather than asserting a count it cannot know. See
   * `lib/execution/signing-expectation.ts` and
   * supabase/migrations/0023_add_execution_mode.sql.
   */
  executionMode: ExecutionMode | null;
  /**
   * The creator's unroutable-asset policy as applied to THIS purchase, or
   * `null` when every asset was routable. prepareExecution() re-derives the
   * effective recipe from it (lib/domain/basket-protocol/deposit/unroutable.ts).
   * See supabase/migrations/0041_purchase_intent_fallback.sql.
   */
  fallback?: PurchaseIntentFallback | null;
  status: PurchaseIntentStatus;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  /** Non-null once accounting (bag_holdings + bag_share_state) has been applied for this intent — the idempotency guard for spec Aşama 11 ("aynı execution accounting'i ikinci kez yazılmamalı"). Only ever set for a fully-COMPLETED intent; a PARTIAL_SUCCESS/RECONCILIATION_REQUIRED intent uses `reconciliationAppliedAt` instead — see that field's doc for why the two are never conflated. */
  accountingAppliedAt: string | null;
  /** Phase 18 — non-null once `reconcilePartialExecution()` has credited `bag_holdings` for a PARTIAL_SUCCESS intent's verified-COMPLETED steps ONLY (never shares — see `RECONCILIATION_REQUIRED`'s doc on `PURCHASE_INTENT_STATUSES`). Idempotency guard for repeated/racing reconciliation, same pattern as `accountingAppliedAt` for the full-success path — the two fields are deliberately separate columns/guards so a fully-COMPLETED intent and a partially-reconciled one can never be confused for each other in an audit query. */
  reconciliationAppliedAt: string | null;
  failureCode: PurchaseIntentFailureCode | null;
}

/** How long a freshly created intent's real LI.FI quotes stay usable before requiring a new intent — LI.FI quotes are short-lived; this is deliberately tight. */
export const PURCHASE_INTENT_TTL_MS = 3 * 60 * 1000;

export interface PurchaseIntentFallback {
  policy: 'HOLD_INPUT' | 'REFUND';
  /** The recipe assets that were held in the payment token (HOLD_INPUT) or left out (REFUND). */
  assets: Array<{ chain: import('./basket-protocol').ChainId; address: string; symbol: string }>;
  unroutableWeightBps: number;
  /** Share of the requested amount actually spent (10000 = all; REFUND spends less). */
  amountScaleBps: number;
  /** What the buyer asked to spend, raw; `inputAmountRaw` is what is actually spent. */
  requestedAmountRaw: string;
  inputSymbol: string;
  inputDecimals: number;
}

/** Why LI.FI Composer refused the single-transaction route — figures parsed from its own message, never estimated. Returned with a failed purchase-intent request (HTTP 422). */
export interface ComposerFallbackNotice {
  reason: 'PRICE_IMPACT' | 'UNAVAILABLE';
  /** Composer's message, verbatim. */
  message: string;
  priceImpactBps: number | null;
  maxPriceImpactBps: number | null;
  /** USD values Composer reported for the whole purchase (decimal strings, no "$"). */
  inputUsd: string | null;
  outputUsd: string | null;
  /** Composer's typed error kind (e.g. `preparation_error`, `simulation_revert`, `sdk_outdated`), when it threw one. */
  kind?: string | null;
}

/** Hard ceiling on a price impact a buyer may accept for the single-transaction route (15%). Above it the purchase is refused outright. */
export const MAX_ACCEPTABLE_PRICE_IMPACT_BPS = 1500;
/** Added to an accepted price impact so a small price move between the warning and the retry does not trigger the warning again. */
export const PRICE_IMPACT_ACCEPT_BUFFER_BPS = 100;
