'use client';

import { useCallback, useRef, useState } from 'react';
import { executeRoute, convertQuoteToRoute, LiFiStep, RouteExtended, ExecutionAction } from '@lifi/sdk';
import { ComposerFallbackNotice, PurchaseIntent, PurchaseIntentFailureCode, PurchaseIntentStepRecord } from '@/types/purchase-intent';
import {
  ensureErc20AllowanceOnChain,
  getBrowserLiFiClient,
  getBrowserWalletClientForChain,
  simulateTransactionOnChain,
} from '@/lib/blockchain/lifi-wallet-client';
import { ensureBagRouterAllowance, sendBagRouterTransaction } from '@/lib/blockchain/bag-router-client';
import { describeWalletError } from '@/lib/blockchain/wallet-error';

// -----------------------------------------------------------------------------
// Phase 17 — spec Aşama 6: drives the "Purchase" button's entire lifecycle
// from `PurchasePreviewModal`. Every network call that CREATES or ADVANCES
// server state goes through the typed `/api/.../purchase-intent*` routes
// (lib/server/purchase-execution.ts) — this hook never talks to Supabase or
// LI.FI's quote endpoints directly, only `@lifi/sdk`'s `executeRoute()` for
// the one thing that must run in-browser: turning an already-quoted,
// already-authorized LI.FI step into a signed, sent transaction via the
// user's own wallet (lib/blockchain/lifi-wallet-client.ts).
//
// SEQUENTIAL, not parallel, in the fallback case: a Bag purchase can have
// several SWAP steps (one per target asset); when `intent.composerTransaction`
// is null (Composer wasn't eligible/configured for this purchase — see
// lib/blockchain/lifi-purchase-quote.ts's `tryBuildComposerSteps()`), this
// hook executes them ONE AT A TIME so the wallet only ever shows one
// signature prompt at once and a rejection on step 2 doesn't leave step 1's
// tx racing an abandoned step 3.
//
// Phase 22 — when `intent.composerTransaction` IS set, every SWAP step was
// built as ONE shared LI.FI Composer transaction instead, and this hook
// sends that ONE transaction (`executeComposerTransaction()` below) rather
// than looping — genuinely one signature for every target asset, not N.
//
// Bag Router execution hardening (item 3) — `intent.bagRouterTransaction`
// is checked BEFORE `intent.composerTransaction` and routed to its OWN
// `executeBagRouterTransaction()` below, NEVER to
// `executeComposerTransaction()`: the BAG Router pulls its input via
// `transferFrom` and therefore needs an ERC-20 allowance check/request
// Composer's flow does not (lib/blockchain/bag-router-client.ts). The two
// fields are mutually exclusive by construction (purchase-intent-bridge.ts
// sets at most one, keyed off the compiled result's explicit `providerId`
// — never both, and never based on `mode` alone, since `mode` cannot tell
// the two providers apart), but the check order here is still a
// deliberate, defensive "BAG Router never reinterpreted as Composer" —
// exactly the invariant this hardening pass exists to protect.
// -----------------------------------------------------------------------------

export type PurchaseExecutionPhase =
  | 'idle'
  | 'creating'
  | 'preparing'
  /** LI.FI Composer refused the single-transaction route over price impact; waiting for the buyer to accept it (see `priceImpactNotice`). Nothing was signed. */
  | 'awaiting_price_impact_confirmation'
  | 'awaiting_signature'
  | 'confirming'
  | 'completed'
  | 'failed';

export interface PurchaseExecutionState {
  phase: PurchaseExecutionPhase;
  intent: PurchaseIntent | null;
  /** Index of the SWAP step currently prompting the wallet — drives "Approve Token (2/3)"-style UI. */
  activeStepIndex: number | null;
  error: string | null;
  failureCode: PurchaseIntentFailureCode | null;
  /** Raw wallet/RPC error behind a failure (e.g. a revert reason), shown under the typed message. */
  errorDetail: string | null;
  /** Composer's price-impact refusal while in `awaiting_price_impact_confirmation`. */
  priceImpactNotice: ComposerFallbackNotice | null;
}

const INITIAL_STATE: PurchaseExecutionState = {
  phase: 'idle',
  intent: null,
  activeStepIndex: null,
  error: null,
  failureCode: null,
  errorDetail: null,
  priceImpactNotice: null,
};

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PurchaseExecutionHttpError(data?.error ?? `Request failed (${res.status})`, data?.failureCode ?? null, data?.composerFallback ?? null);
  }
  return data as T;
}

/**
 * The server half of a purchase that needs no wallet: create the intent
 * (quotes + route compile — the slow part) and run the pre-signature checks
 * (`/execute`). The Buy button used to do both only AFTER it was pressed,
 * so the wallet prompt waited on them; the modal now runs this in the
 * background once the amount settles (see use-purchase-prefetch.ts) and
 * Buy goes straight to the wallet. Nothing here signs or sends anything.
 */
export async function preparePurchaseIntent(
  bagId: string,
  inputAssetId: string,
  amount: string,
  selectedProviderId?: string
): Promise<PurchaseIntent> {
  const { intent: created } = await postJson<{ intent: PurchaseIntent }>(`/api/bags/${bagId}/purchase-intent`, {
    inputAssetId,
    amount,
    ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
  });
  if (created.status !== 'READY') return created;
  const { intent: prepared } = await postJson<{ intent: PurchaseIntent }>(`/api/purchase-intent/${created.id}/execute`);
  return prepared;
}

/** A prepared intent is only reused while it still has this long before it expires. */
const PREPARED_INTENT_MIN_REMAINING_MS = 60_000;

function isUsablePreparedIntent(intent: PurchaseIntent | null, bagId: string): intent is PurchaseIntent {
  return (
    intent !== null &&
    intent.bagId === bagId &&
    intent.status === 'AWAITING_SIGNATURE' &&
    new Date(intent.expiresAt).getTime() - Date.now() > PREPARED_INTENT_MIN_REMAINING_MS
  );
}

class PurchaseExecutionHttpError extends Error {
  constructor(
    message: string,
    public readonly failureCode: PurchaseIntentFailureCode | null,
    /** Composer's refusal, when the single-transaction route was refused (HTTP 422 from purchase-intent). */
    public readonly composerFallback: ComposerFallbackNotice | null = null
  ) {
    super(message);
    this.name = 'PurchaseExecutionHttpError';
  }
}

async function reportStep(
  intentId: string,
  stepIndex: number,
  event:
    | { type: 'APPROVAL_REQUIRED' | 'APPROVAL_AWAITING_SIGNATURE' | 'APPROVAL_CONFIRMED' | 'AWAITING_SIGNATURE' }
    | { type: 'APPROVAL_SUBMITTED' | 'SUBMITTED'; txHash: string }
    | { type: 'REJECTED' }
    | { type: 'FAILED'; failureCode: PurchaseIntentFailureCode; message?: string }
): Promise<PurchaseIntent> {
  const { intent } = await postJson<{ intent: PurchaseIntent }>(
    `/api/purchase-intent/${intentId}/step/${stepIndex}/report`,
    event
  );
  return intent;
}

/**
 * Reports the same event for several steps ONE AFTER ANOTHER. The server
 * updates an intent's steps with a read-modify-write of the whole list, so
 * parallel reports for the steps of one shared transaction (Composer / BAG
 * Router) overwrote each other: only some steps kept their txHash and the
 * purchase stayed "confirming" forever although the transaction had landed.
 * Never throws — a failed report surfaces on the next verify.
 */
async function reportStepsInOrder(
  intentId: string,
  steps: PurchaseIntentStepRecord[],
  event: Parameters<typeof reportStep>[2]
): Promise<void> {
  for (const step of steps) {
    await reportStep(intentId, step.stepIndex, event).catch(() => {});
  }
}

async function verifyIntent(intentId: string): Promise<PurchaseIntent> {
  const { intent } = await postJson<{ intent: PurchaseIntent }>(`/api/purchase-intent/${intentId}/verify`);
  return intent;
}

/** Flattens every included LI.FI step's `execution.actions` into one ordered list — a single `PurchaseIntentStepRecord` (one asset swap) can involve more than one on-chain action (allowance + swap, or swap + bridge leg), and this app reports ONE approval state + ONE main-tx state per record, not per LI.FI sub-action. */
function flattenActions(route: RouteExtended): ExecutionAction[] {
  return route.steps.flatMap((s) => s.execution?.actions ?? []);
}

const ALLOWANCE_ACTION_TYPES = new Set(['CHECK_ALLOWANCE', 'SET_ALLOWANCE', 'RESET_ALLOWANCE', 'PERMIT', 'NATIVE_PERMIT']);
const MAIN_ACTION_TYPES = new Set(['SWAP', 'CROSS_CHAIN', 'RECEIVING_CHAIN']);

function isUserRejection(action: ExecutionAction): boolean {
  const code = action.error?.code;
  const message = action.error?.message?.toLowerCase() ?? '';
  return code === 4001 || code === '4001' || message.includes('reject') || message.includes('denied') || message.includes('user cancel');
}

/**
 * Maps the latest allowance/main action from a LI.FI route update to a
 * server step-report event. Returns `null` when there's nothing new to
 * report (e.g. `STARTED` with no signature prompt yet) — the caller only
 * calls the report endpoint for a non-null result, and only when it
 * differs from the last-reported event for that step (deduped by the
 * caller via a ref), to avoid spamming the server on every LI.FI progress
 * tick.
 */
function mapActionToEvent(
  action: ExecutionAction,
  kind: 'approval' | 'main'
): Parameters<typeof reportStep>[2] | null {
  switch (action.status) {
    case 'ACTION_REQUIRED':
      return kind === 'approval' ? { type: 'APPROVAL_REQUIRED' } : { type: 'AWAITING_SIGNATURE' };
    case 'PENDING':
      if (action.txHash) {
        return kind === 'approval' ? { type: 'APPROVAL_SUBMITTED', txHash: action.txHash } : { type: 'SUBMITTED', txHash: action.txHash };
      }
      return kind === 'approval' ? { type: 'APPROVAL_AWAITING_SIGNATURE' } : { type: 'AWAITING_SIGNATURE' };
    case 'DONE':
      return kind === 'approval' ? { type: 'APPROVAL_CONFIRMED' } : action.txHash ? { type: 'SUBMITTED', txHash: action.txHash } : null;
    case 'FAILED':
      if (isUserRejection(action)) return { type: 'REJECTED' };
      return {
        type: 'FAILED',
        failureCode: kind === 'approval' ? 'INSUFFICIENT_ALLOWANCE' : 'TRANSACTION_REVERTED',
        message: action.error?.message,
      };
    default:
      return null;
  }
}

export function usePurchaseExecution() {
  const [state, setState] = useState<PurchaseExecutionState>(INITIAL_STATE);
  // Dedupes reportStep() calls across rapid-fire updateRouteHook ticks —
  // keyed by `${stepIndex}:${kind}`, value is the last event `type` sent.
  const lastReportedRef = useRef<Map<string, string>>(new Map());

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    lastReportedRef.current.clear();
  }, []);

  const fail = useCallback((error: string, failureCode: PurchaseIntentFailureCode | null = null) => {
    setState((s) => ({ ...s, phase: 'failed', error, failureCode }));
  }, []);

  /**
   * Single-signature path (Phase 22): `intent.composerTransaction` is set
   * when `lib/blockchain/lifi-purchase-quote.ts`'s `tryBuildComposerSteps()`
   * built every SWAP step as ONE shared LI.FI Composer transaction rather
   * than N independent LI.FI routes. Sends that ONE transaction directly
   * (not via `executeRoute()` — Composer's `transactionRequest` is plain
   * `{to, data, value}` calldata, not a `LiFiStep`/`Route`) and reports the
   * SAME resulting tx hash for EVERY swap step index, since the server's
   * `/verify` endpoint still checks each step's `txHash` independently —
   * this keeps that check meaningful (one real receipt, looked up once per
   * step) without needing a server-side concept of "these N steps share a
   * hash".
   */
  const executeComposerTransaction = useCallback(
    async (
      intentId: string,
      composerTransaction: NonNullable<PurchaseIntent['composerTransaction']>,
      swapSteps: PurchaseIntentStepRecord[],
      walletAddress: string
    ): Promise<void> => {
      setState((s) => ({ ...s, activeStepIndex: swapSteps[0]?.stepIndex ?? null, phase: 'awaiting_signature' }));
      // Not awaited: the wallet prompt shouldn't wait on bookkeeping. Every
      // later report waits for it, so the server still sees them in order.
      const awaitingReported = reportStepsInOrder(intentId, swapSteps, { type: 'AWAITING_SIGNATURE' });

      let txHash: string;
      try {
        // Composer can only pull the input token once the wallet has approved
        // it; without this the transaction reverts on-chain. Usually one
        // approval, and none when an earlier purchase already covered it.
        const approvals = composerTransaction.approvals ?? [];
        for (const approval of approvals) {
          await ensureErc20AllowanceOnChain(walletAddress, composerTransaction.chainId, approval.token, approval.spender, approval.amountRaw);
        }
        // Older intents carry no approval list, and an empty list can't be
        // told apart from "LI.FI omitted it". Composer's entry point is the
        // transaction target (the LI.FI Diamond), so make sure it may pull the
        // purchase's input — a no-op when the allowance already covers it.
        if (approvals.length === 0 && swapSteps.length > 0) {
          const inputToken = swapSteps[0].inputAsset.address;
          const inputTotal = swapSteps.reduce((sum, st) => sum + BigInt(st.inputAmountRaw), BigInt(0));
          await ensureErc20AllowanceOnChain(walletAddress, composerTransaction.chainId, inputToken, composerTransaction.to, inputTotal.toString());
        }
        // Dry-run first: a transaction that would revert is never sent, so a
        // stale route or missing allowance costs no gas.
        await simulateTransactionOnChain(walletAddress, composerTransaction.chainId, composerTransaction);
        const walletClient = await getBrowserWalletClientForChain(walletAddress, composerTransaction.chainId);
        txHash = await walletClient.sendTransaction({
          account: walletAddress as `0x${string}`,
          to: composerTransaction.to as `0x${string}`,
          data: composerTransaction.data as `0x${string}`,
          value: BigInt(composerTransaction.value),
          chain: null,
        });
      } catch (err) {
        const { message, rejected } = describeWalletError(err);
        await awaitingReported;
        await reportStepsInOrder(intentId, swapSteps, rejected ? { type: 'REJECTED' } : { type: 'FAILED', failureCode: 'UNKNOWN_ERROR', message });
        throw err;
      }

      setState((s) => ({ ...s, phase: 'confirming' }));
      await awaitingReported;
      await reportStepsInOrder(intentId, swapSteps, { type: 'SUBMITTED', txHash });
    },
    []
  );

  /**
   * BAG Router path (Bag Router execution hardening, item 3): sends a
   * `bagRouterTransaction`, never through `executeComposerTransaction()`.
   * Unlike Composer, this ALWAYS checks/requests an ERC-20 allowance first
   * — the router pulls `bagRouterTransaction.inputAmountRaw` of
   * `bagRouterTransaction.inputToken` via `transferFrom`
   * (contracts/BagExecutionRouter.sol), so a fresh wallet genuinely needs
   * one approval confirmation before the router's own transaction (item 2:
   * never falsely claim one confirmation for a wallet that hasn't approved
   * yet). `ensureBagRouterAllowance()` itself waits for the approval
   * receipt before returning, so by the time this reports
   * `APPROVAL_SUBMITTED`/`APPROVAL_CONFIRMED` the approval is already
   * final — no separate polling loop needed the way LI.FI's
   * `updateRouteHook` streams intermediate states for `executeOneStep()`.
   */
  const executeBagRouterTransaction = useCallback(
    async (
      intentId: string,
      bagRouterTransaction: NonNullable<PurchaseIntent['bagRouterTransaction']>,
      swapSteps: PurchaseIntentStepRecord[],
      walletAddress: string
    ): Promise<void> => {
      setState((s) => ({ ...s, activeStepIndex: swapSteps[0]?.stepIndex ?? null, phase: 'awaiting_signature' }));
      await reportStepsInOrder(intentId, swapSteps, { type: 'APPROVAL_REQUIRED' });

      let approvalTxHash: `0x${string}` | null;
      try {
        approvalTxHash = await ensureBagRouterAllowance(
          bagRouterTransaction.inputToken as `0x${string}`,
          walletAddress as `0x${string}`,
          bagRouterTransaction.to as `0x${string}`,
          BigInt(bagRouterTransaction.inputAmountRaw)
        );
      } catch (err) {
        const { message, rejected } = describeWalletError(err);
        await reportStepsInOrder(intentId, swapSteps, rejected ? { type: 'REJECTED' } : { type: 'FAILED', failureCode: 'INSUFFICIENT_ALLOWANCE', message });
        throw err;
      }

      if (approvalTxHash) {
        await reportStepsInOrder(intentId, swapSteps, { type: 'APPROVAL_SUBMITTED', txHash: approvalTxHash as string });
      }
      await reportStepsInOrder(intentId, swapSteps, { type: 'APPROVAL_CONFIRMED' });

      setState((s) => ({ ...s, phase: 'awaiting_signature' }));
      await reportStepsInOrder(intentId, swapSteps, { type: 'AWAITING_SIGNATURE' });

      let txHash: string;
      try {
        txHash = await sendBagRouterTransaction(walletAddress as `0x${string}`, bagRouterTransaction);
      } catch (err) {
        const { message, rejected } = describeWalletError(err);
        await reportStepsInOrder(intentId, swapSteps, rejected ? { type: 'REJECTED' } : { type: 'FAILED', failureCode: 'UNKNOWN_ERROR', message });
        throw err;
      }

      setState((s) => ({ ...s, phase: 'confirming' }));
      await reportStepsInOrder(intentId, swapSteps, { type: 'SUBMITTED', txHash });
    },
    []
  );

  const executeOneStep = useCallback(
    async (intentId: string, step: PurchaseIntentStepRecord, walletAddress: string): Promise<void> => {
      if (step.action !== 'SWAP' || !step.lifiStep) return; // KEEP / already-failed steps need nothing
      setState((s) => ({ ...s, activeStepIndex: step.stepIndex, phase: 'awaiting_signature' }));

      const client = getBrowserLiFiClient(walletAddress);
      const route = convertQuoteToRoute(step.lifiStep as LiFiStep);

      const handleUpdate = (updatedRoute: RouteExtended) => {
        const actions = flattenActions(updatedRoute);
        const approvalAction = [...actions].reverse().find((a) => ALLOWANCE_ACTION_TYPES.has(a.type));
        const mainAction = [...actions].reverse().find((a) => MAIN_ACTION_TYPES.has(a.type));

        for (const [kind, action] of [
          ['approval', approvalAction] as const,
          ['main', mainAction] as const,
        ]) {
          if (!action) continue;
          const key = `${step.stepIndex}:${kind}`;
          const dedupeKey = `${action.status}:${action.txHash ?? ''}`;
          if (lastReportedRef.current.get(key) === dedupeKey) continue;
          const event = mapActionToEvent(action, kind);
          if (!event) continue;
          lastReportedRef.current.set(key, dedupeKey);
          // Fire-and-forget from LI.FI's own callback (which isn't async-
          // aware) — errors here surface on the NEXT poll/report, never
          // silently swallowed, since `executeRoute()`'s own resolution/
          // rejection below is still the source of truth for this step.
          reportStep(intentId, step.stepIndex, event).catch(() => {});
          if (event.type === 'SUBMITTED') {
            setState((s) => ({ ...s, phase: 'confirming' }));
          }
        }
      };

      try {
        await executeRoute(client, route, { updateRouteHook: handleUpdate });
      } catch (err) {
        // executeRoute() throwing after a rejection/failure is expected —
        // the LAST updateRouteHook tick already reported the specific
        // REJECTED/FAILED reason above; this catch only guards against a
        // step that failed before ever producing a reportable action tick.
        const key = `${step.stepIndex}:main`;
        if (!lastReportedRef.current.has(key)) {
          const { message } = describeWalletError(err);
          await reportStep(intentId, step.stepIndex, { type: 'FAILED', failureCode: 'UNKNOWN_ERROR', message }).catch(() => {});
        }
        throw err;
      }
    },
    []
  );

  const start = useCallback(
    async (
      bagId: string,
      inputAssetId: string,
      amount: string,
      walletAddress: string,
      selectedProviderId?: string,
      /** A background-prepared intent for exactly these inputs (use-purchase-prefetch.ts); reused when still valid. */
      preparedIntent?: Promise<PurchaseIntent | null>,
      /** `acceptedPriceImpactBps`: the buyer accepted this Composer-reported price impact; the single-transaction route is recompiled with it. */
      options: { acceptedPriceImpactBps?: number } = {}
    ): Promise<void> => {
      reset();
      setState((s) => ({ ...s, phase: 'creating' }));
      const startedAt = Date.now();

      // Tracks whether an intent has actually been created server-side yet.
      // Used below to decide whether a thrown error means "nothing to
      // verify, fail now" (nothing happened) or "something may already be
      // on-chain, ask the server" (a wallet/execution error AFTER an
      // intent existed and at least one step attempted to sign).
      let createdIntentId: string | null = null;
      // The wallet/execution error that sent us to /verify, kept so a FAILED
      // outcome can show WHY instead of only the generic failure code.
      let executionErrorDetail: string | null = null;

      try {
        // Item 11 — `selectedProviderId` (present only after the user
        // compared candidates via `usePurchaseOptions` and picked one) is
        // the ONLY extra thing sent here. The server re-derives and
        // re-compiles everything itself (see purchase-execution.ts's own
        // doc on `selectedProviderId`) — this hook never sends a compiled
        // execution, calldata, a price, or a route.
        const reused = preparedIntent ? await preparedIntent.catch(() => null) : null;
        let prepared: PurchaseIntent;
        // An accepted price impact always means a fresh intent compiled with it.
        const usedPrepared = options.acceptedPriceImpactBps === undefined && isUsablePreparedIntent(reused, bagId);
        if (usedPrepared && reused) {
          prepared = reused;
          createdIntentId = reused.id;
        } else {
          const { intent: created } = await postJson<{ intent: PurchaseIntent }>(`/api/bags/${bagId}/purchase-intent`, {
            inputAssetId,
            amount,
            ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
            ...(options.acceptedPriceImpactBps !== undefined ? { acceptedPriceImpactBps: options.acceptedPriceImpactBps } : {}),
          });
          createdIntentId = created.id;
          setState((s) => ({ ...s, intent: created }));

          setState((s) => ({ ...s, phase: 'preparing' }));
          ({ intent: prepared } = await postJson<{ intent: PurchaseIntent }>(`/api/purchase-intent/${created.id}/execute`));
        }
        setState((s) => ({ ...s, intent: prepared }));
        console.info(`[timing] buy -> wallet ready: ${Date.now() - startedAt}ms (${usedPrepared ? 'prepared in background' : 'prepared on click'})`);

        const swapSteps = prepared.steps.filter((s) => s.action === 'SWAP');

        // Bag Router execution hardening (item 3): checked BEFORE
        // `composerTransaction` and routed to its own path — see this
        // file's module doc for why a BAG Router result must never reach
        // `executeComposerTransaction()`.
        if (prepared.bagRouterTransaction) {
          await executeBagRouterTransaction(prepared.id, prepared.bagRouterTransaction, swapSteps, walletAddress);
        } else if (prepared.composerTransaction) {
          await executeComposerTransaction(prepared.id, prepared.composerTransaction, swapSteps, walletAddress);
        } else {
          for (const step of swapSteps) {
            await executeOneStep(prepared.id, step, walletAddress);
          }
        }
      } catch (err) {
        // Composer refused the single-transaction route over price impact:
        // nothing was signed. Show the buyer the impact and let them accept
        // it (retried as ONE transaction) or cancel. Never one tx per asset.
        if (
          err instanceof PurchaseExecutionHttpError &&
          err.composerFallback?.reason === 'PRICE_IMPACT' &&
          err.composerFallback.priceImpactBps !== null &&
          // Asked again only when the impact is higher than what was accepted.
          (options.acceptedPriceImpactBps === undefined || err.composerFallback.priceImpactBps > options.acceptedPriceImpactBps)
        ) {
          setState((s) => ({ ...s, phase: 'awaiting_price_impact_confirmation', priceImpactNotice: err.composerFallback }));
          return;
        }
        if (createdIntentId === null || err instanceof PurchaseExecutionHttpError) {
          // Nothing was ever signed/sent — either the intent itself never
          // got created, or it failed a purely server-side check (expired,
          // route changed) before any wallet interaction. There is
          // nothing on-chain for /verify to check, so this client-side
          // reason IS the final answer.
          if (err instanceof PurchaseExecutionHttpError) fail(err.message, err.failureCode);
          else fail(err instanceof Error ? err.message : 'Purchase failed.');
          return;
        }
        executionErrorDetail = describeWalletError(err).message;
        console.error('[purchase] wallet/execution error', err);
        // A wallet/execution-layer error (user rejection, revert, an RPC
        // hiccup while broadcasting) AFTER the intent existed and a step
        // was attempted. executeOneStep() already reported the specific
        // REJECTED/FAILED reason to the server before rethrowing here —
        // deliberately fall through to the SAME verify loop the happy
        // path uses below, rather than ending the flow on this client-side
        // guess. The server's own on-chain check is the one thing that
        // actually decides the outcome (spec: never client say-so) — it
        // may confirm this step failed, or (a broadcast hiccup that LOOKED
        // like a rejection but the transaction actually landed) it may
        // not. Falling through here, instead of returning immediately, is
        // what makes that correction possible.
      }

      setState((s) => ({ ...s, phase: 'confirming' }));

      try {
        // Poll verification until the intent reaches a terminal status —
        // this is the ONLY path that can mark the purchase COMPLETED (spec
        // Aşama 10/12/13: server-verified on-chain, never client say-so).
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const verified = await verifyIntent(createdIntentId);
          setState((s) => ({ ...s, intent: verified }));
          if (verified.status === 'COMPLETED') {
            setState((s) => ({ ...s, phase: 'completed' }));
            return;
          }
          if (verified.status === 'FAILED' || verified.status === 'EXPIRED' || verified.status === 'CANCELLED') {
            fail('The purchase could not be completed.', verified.failureCode);
            if (executionErrorDetail) setState((s) => ({ ...s, errorDetail: executionErrorDetail }));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
      } catch (err) {
        if (err instanceof PurchaseExecutionHttpError) {
          fail(err.message, err.failureCode);
        } else {
          fail(err instanceof Error ? err.message : 'Purchase failed.');
        }
      }
    },
    [executeOneStep, executeComposerTransaction, executeBagRouterTransaction, fail, reset]
  );

  return { state, start, reset };
}
