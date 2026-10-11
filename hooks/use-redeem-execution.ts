'use client';

import { useCallback, useRef, useState } from 'react';
import { executeRoute, convertQuoteToRoute, LiFiStep, RouteExtended, ExecutionAction } from '@lifi/sdk';
import { RedeemIntent, RedeemIntentFailureCode, RedeemIntentStepRecord } from '@/types/redeem-intent';
import { getBrowserLiFiClient } from '@/lib/blockchain/lifi-wallet-client';
import { ensureRouterAllowance, sendRedeemTransaction, collectRequiredApprovals } from '@/lib/blockchain/redeem-fee-router-client';
import type { FeeAttestation } from '@/lib/server/redeem-fee-attestation';
import { executeWalletSweep } from '@/lib/blockchain/wallet-sweep-client';
import { describeWalletError } from '@/lib/blockchain/wallet-error';

// -----------------------------------------------------------------------------
// Phase 21 — exit-side counterpart to hooks/use-purchase-execution.ts.
// Structurally identical (same sequential-not-parallel reasoning, same
// "never talks to Supabase/LI.FI quote endpoints directly, only
// executeRoute() for the one thing that must run in-browser" boundary) —
// see that file's module doc, which applies here unchanged. Only the
// endpoints and types differ (redeem-intent instead of purchase-intent).
//
// V11 — `start()` now prefers the RedeemFeeRouter execution path (server-
// attested fee, one atomic on-chain redeem() call, real enforced creator
// fee) whenever NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS is configured. Per
// the V11 brief's explicit P0 requirement ("LI.FI redemption başarılı ama
// Vault fee settlement yok — imkânsız olmalı"): once the router is
// configured, the legacy LI.FI path (`runLegacyLiFiFlow`) is NEVER reached
// for a real redemption — it exists only as the pre-router fallback for a
// deployment that hasn't configured the router/vault yet.
//
// Within that fallback, an intent built as ONE Composer transaction
// (`intent.composerTransaction`, lib/server/redeem-composer.ts) is signed
// once (`executeComposerSale`; approvals batched into the same confirmation
// when the wallet supports EIP-5792) instead of one LI.FI route per asset.
//
// A Bag with a performance fee is refused by `/execute` (FEE_ROUTER_REQUIRED):
// when RedeemSettlement is configured (NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS),
// the sale goes through the two-phase settlement attestation instead
// (settlement-quote → settlement-attest), and the wallet signs the ONE
// Composer transaction it returns — swaps, push to RedeemSettlement,
// settleFlat — which pays the fee to the creator on-chain. Verification then
// trusts the contract's Settled event, not this hook.
// -----------------------------------------------------------------------------

function getConfiguredRedeemFeeRouterAddress(): `0x${string}` | null {
  const raw = process.env.NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS;
  return raw ? (raw as `0x${string}`) : null;
}

function isRedeemSettlementConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_REDEEM_SETTLEMENT_ADDRESS);
}

/** `partial`: some legs sold and some failed (A4) — never reported as a completed sale. */
export type RedeemExecutionPhase = 'idle' | 'creating' | 'preparing' | 'awaiting_signature' | 'confirming' | 'completed' | 'partial' | 'failed';

/**
 * A fee-paying sale whose wallet signature was declined while its settlement attestation is still valid on-chain.
 * Declining is not final for such a sale: the same signed transaction can be signed again until `deadline`, and a
 * DIFFERENT sale of the position stays locked until then (the lock protects the creator's fee, fee-redemption-lock.ts).
 */
export interface ResumableSale {
  intentId: string;
  composerTransaction: NonNullable<RedeemIntent['composerTransaction']>;
  swapSteps: RedeemIntentStepRecord[];
  walletAddress: string;
  /** Unix seconds: RedeemSettlement refuses the transaction after it. */
  deadline: number;
}

export interface RedeemExecutionState {
  phase: RedeemExecutionPhase;
  intent: RedeemIntent | null;
  activeStepIndex: number | null;
  error: string | null;
  failureCode: RedeemIntentFailureCode | null;
  /** Machine-readable reason for `error`, e.g. SESSION_EXPIRED. */
  errorCode: string | null;
  resumable: ResumableSale | null;
  /** An earlier open sale of this position that blocks a new one and cannot be re-signed: it can be closed. */
  blocking: { intentId: string; status: string; createdAt: string } | null;
}

const INITIAL_STATE: RedeemExecutionState = {
  phase: 'idle',
  intent: null,
  activeStepIndex: null,
  error: null,
  failureCode: null,
  errorCode: null,
  resumable: null,
  blocking: null,
};

/** A pending sale is offered for re-signing only with at least this much time left before its deadline. */
const RESUME_MARGIN_MS = 15_000;

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw new RedeemExecutionHttpError('Your session has expired. Sign in again to continue.', null, 'SESSION_EXPIRED');
    throw new RedeemExecutionHttpError(data?.error ?? `Request failed (${res.status})`, data?.failureCode ?? null, data?.code ?? null, data?.intentId ?? null);
  }
  return data as T;
}

/** Best effort: a failed read only means no "Sign again" offer, never a failed sale. */
async function getIntent(intentId: string): Promise<RedeemIntent | null> {
  try {
    const res = await fetch(`/api/redeem-intent/${intentId}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { intent?: RedeemIntent } | null;
    return data?.intent ?? null;
  } catch {
    return null;
  }
}

/** The pending fee-paying sale `intent` can still be signed as is: awaiting signature, nothing sent, deadline ahead. */
function resumableSaleOf(intent: RedeemIntent | null, walletAddress: string): ResumableSale | null {
  const deadline = intent?.settlementPlan?.deadline;
  if (!intent || intent.status !== 'AWAITING_SIGNATURE' || !intent.composerTransaction || typeof deadline !== 'number') return null;
  if (deadline * 1000 - Date.now() <= RESUME_MARGIN_MS) return null;
  if (intent.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) return null;
  const swapSteps = intent.steps.filter((s) => s.action === 'SWAP');
  if (swapSteps.some((s) => s.txHash !== null)) return null;
  return { intentId: intent.id, composerTransaction: intent.composerTransaction, swapSteps, walletAddress, deadline };
}

/** Thrown by executeComposerSale when the wallet declined a sale that can still be signed again (see ResumableSale). */
class ResumableRejectionError extends Error {
  constructor(public readonly sale: ResumableSale) {
    super('You declined the signature in your wallet.');
    this.name = 'ResumableRejectionError';
  }
}

class RedeemExecutionHttpError extends Error {
  constructor(
    message: string,
    public readonly failureCode: RedeemIntentFailureCode | null,
    public readonly code: string | null = null,
    public readonly intentId: string | null = null
  ) {
    super(message);
    this.name = 'RedeemExecutionHttpError';
  }
}

async function reportStep(
  intentId: string,
  stepIndex: number,
  event:
    | { type: 'APPROVAL_REQUIRED' | 'APPROVAL_AWAITING_SIGNATURE' | 'APPROVAL_CONFIRMED' | 'AWAITING_SIGNATURE' }
    | { type: 'APPROVAL_SUBMITTED' | 'SUBMITTED'; txHash: string }
    | { type: 'REJECTED' }
    | { type: 'FAILED'; failureCode: RedeemIntentFailureCode; message?: string }
): Promise<RedeemIntent> {
  const { intent } = await postJson<{ intent: RedeemIntent }>(`/api/redeem-intent/${intentId}/step/${stepIndex}/report`, event);
  return intent;
}

/** One report per step, in order: concurrent reports for the same intent would overwrite each other's step updates. */
async function reportStepsInOrder(intentId: string, steps: RedeemIntentStepRecord[], event: Parameters<typeof reportStep>[2]): Promise<void> {
  for (const step of steps) {
    await reportStep(intentId, step.stepIndex, event).catch(() => {});
  }
}

async function verifyIntent(intentId: string): Promise<RedeemIntent> {
  const { intent } = await postJson<{ intent: RedeemIntent }>(`/api/redeem-intent/${intentId}/verify`);
  return intent;
}

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

function mapActionToEvent(action: ExecutionAction, kind: 'approval' | 'main'): Parameters<typeof reportStep>[2] | null {
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

export function useRedeemExecution() {
  const [state, setState] = useState<RedeemExecutionState>(INITIAL_STATE);
  const lastReportedRef = useRef<Map<string, string>>(new Map());

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    lastReportedRef.current.clear();
  }, []);

  const fail = useCallback((error: string, failureCode: RedeemIntentFailureCode | null = null, errorCode: string | null = null) => {
    setState((s) => ({ ...s, phase: 'failed', error, failureCode, errorCode }));
  }, []);

  const offerResume = useCallback((sale: ResumableSale, error: string) => {
    setState((s) => ({ ...s, phase: 'failed', error, failureCode: null, errorCode: 'SIGNATURE_DECLINED', resumable: sale }));
  }, []);

  const lastStartRef = useRef<{ bagId: string; fractionBps: number; outputAssetId: string; walletAddress: string } | null>(null);

  const executeOneStep = useCallback(async (intentId: string, step: RedeemIntentStepRecord, walletAddress: string): Promise<void> => {
    if (step.action !== 'SWAP' || !step.lifiStep) return;

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
        reportStep(intentId, step.stepIndex, event).catch(() => {});
        if (event.type === 'SUBMITTED') {
          setState((s) => ({ ...s, phase: 'confirming' }));
        }
      }
    };

    try {
      await executeRoute(client, route, { updateRouteHook: handleUpdate });
    } catch (err) {
      const key = `${step.stepIndex}:main`;
      if (!lastReportedRef.current.has(key)) {
        const message = err instanceof Error ? err.message : 'Wallet execution failed.';
        await reportStep(intentId, step.stepIndex, { type: 'FAILED', failureCode: 'UNKNOWN_ERROR', message }).catch(() => {});
      }
      throw err;
    }
  }, []);

  /**
   * One-transaction sale (`intent.composerTransaction`, lib/server/redeem-composer.ts): the exact-amount approvals
   * and the Composer transaction, in ONE wallet confirmation when the wallet supports atomic batching (EIP-5792),
   * otherwise approvals first and then the one sale. The same hash is reported for every SWAP step; the server
   * verifies it against exactly the transaction it built.
   */
  const executeComposerSale = useCallback(
    async (
      intentId: string,
      composerTransaction: NonNullable<RedeemIntent['composerTransaction']>,
      swapSteps: RedeemIntentStepRecord[],
      walletAddress: string,
      /** Settlement attestation deadline (unix seconds) of a fee-paying sale; undefined for a free sale. */
      deadline?: number
    ) => {
      setState((s) => ({ ...s, activeStepIndex: null, phase: 'awaiting_signature' }));
      const awaitingReported = reportStepsInOrder(intentId, swapSteps, { type: 'AWAITING_SIGNATURE' });
      let reportedSubmitted = false;
      try {
        await executeWalletSweep(
          walletAddress,
          { transaction: composerTransaction, approvals: composerTransaction.approvals },
          (step) => {
            if (step === 'confirming') setState((s) => ({ ...s, phase: 'confirming' }));
          },
          {
            onSubmitted: async (txHash) => {
              reportedSubmitted = true;
              await awaitingReported;
              await reportStepsInOrder(intentId, swapSteps, { type: 'SUBMITTED', txHash });
            },
          }
        );
      } catch (err) {
        if (!reportedSubmitted) {
          const { message, rejected } = describeWalletError(err);
          await awaitingReported;
          if (rejected && typeof deadline === 'number' && deadline * 1000 - Date.now() > RESUME_MARGIN_MS) {
            // Not reported as REJECTED: the attestation is still valid on-chain, so the same transaction may be
            // signed again until its deadline. Left unsigned, the server releases the intent at that deadline.
            throw new ResumableRejectionError({ intentId, composerTransaction, swapSteps, walletAddress, deadline });
          }
          await reportStepsInOrder(intentId, swapSteps, rejected ? { type: 'REJECTED' } : { type: 'FAILED', failureCode: 'UNKNOWN_ERROR', message });
        }
        throw err;
      }
    },
    []
  );

  const runRouterFlow = useCallback(async (intentId: string, walletAddress: string, routerAddress: `0x${string}`): Promise<void> => {
    // V11 — the enforced-fee path. Everything from here to the tx receipt
    // is one server-attested, one-atomic-transaction flow: the server
    // computed feeAmount/creator/legs (signFeeAttestation, never trusting
    // this client), the wallet signs exactly one `redeem()` call covering
    // every leg, and `confirm-router-tx` independently re-verifies the
    // on-chain result before any DB accounting is finalized — see that
    // route's own doc. There is no path here that can report "redeemed"
    // without CreatorRewardsVault actually having received the fee.
    setState((s) => ({ ...s, phase: 'awaiting_signature' }));
    const { attestation } = await postJson<{ attestation: FeeAttestation }>(`/api/redeem-intent/${intentId}/attest-fee`);

    for (const { token, amount } of collectRequiredApprovals(attestation)) {
      await ensureRouterAllowance(token, walletAddress as `0x${string}`, routerAddress, amount);
    }

    const { txHash, confirmed } = await sendRedeemTransaction(routerAddress, walletAddress as `0x${string}`, attestation);
    if (!confirmed) {
      throw new Error('The redemption transaction reverted on-chain.');
    }

    setState((s) => ({ ...s, phase: 'confirming' }));
    // Deliberately awaited, not fire-and-forget: `verifyAndIndexRouterRedemption()`
    // is what turns a real on-chain receipt into the redeem intent's
    // COMPLETED status and the creator's indexed settlement row — the
    // redemption is not "done" from this hook's perspective until this
    // call itself succeeds, matching the legacy path's own verify-before-
    // completed discipline below.
    await postJson(`/api/redeem-intent/${intentId}/confirm-router-tx`, { txHash });
  }, []);

  /** Polls the server's own on-chain verification until the intent reaches a final state. */
  const runVerifyLoop = useCallback(
    async (intentId: string): Promise<void> => {
      setState((s) => ({ ...s, phase: 'confirming' }));
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const verified = await verifyIntent(intentId);
          setState((s) => ({ ...s, intent: verified }));
          if (verified.status === 'COMPLETED') {
            setState((s) => ({ ...s, phase: 'completed' }));
            return;
          }
          if (verified.status === 'PARTIAL_SUCCESS' || verified.status === 'RECONCILIATION_REQUIRED') {
            setState((s) => ({ ...s, phase: 'partial' }));
            return;
          }
          if (verified.status === 'FAILED' || verified.status === 'EXPIRED' || verified.status === 'CANCELLED') {
            fail('The redemption could not be completed.', verified.failureCode);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
      } catch (err) {
        if (err instanceof RedeemExecutionHttpError) fail(err.message, err.failureCode, err.code);
        else fail(err instanceof Error ? err.message : 'Redemption failed.');
      }
    },
    [fail]
  );

  const declinedMessage = (sale: ResumableSale) =>
    `You declined the signature. This sale stays valid until ${new Date(sale.deadline * 1000).toLocaleTimeString()}: sign it again now, or start a different one after that.`;

  const start = useCallback(
    async (bagId: string, fractionBps: number, outputAssetId: string, walletAddress: string): Promise<void> => {
      reset();
      lastStartRef.current = { bagId, fractionBps, outputAssetId, walletAddress };
      setState((s) => ({ ...s, phase: 'creating' }));

      let createdIntentId: string | null = null;
      // Routing invariant (lib/server/fee-redemption-path.ts): with RedeemSettlement configured, the older router is
      // never used; a fee-paying sale takes the settlement path below, a free one the existing path.
      const routerAddress = isRedeemSettlementConfigured() ? null : getConfiguredRedeemFeeRouterAddress();

      try {
        const { intent: created } = await postJson<{ intent: RedeemIntent }>(`/api/bags/${bagId}/redeem-intent`, {
          fractionBps,
          outputAssetId,
        });
        createdIntentId = created.id;
        setState((s) => ({ ...s, intent: created }));

        if (routerAddress) {
          await runRouterFlow(created.id, walletAddress, routerAddress);
          setState((s) => ({ ...s, phase: 'completed' }));
          return;
        }

        // Legacy fallback — see this file's module doc: only reached when
        // the router/vault haven't been deployed/configured yet, never for
        // a deployment that has them set.
        setState((s) => ({ ...s, phase: 'preparing' }));
        let prepared: RedeemIntent;
        let deadline: number | undefined;
        try {
          ({ intent: prepared } = await postJson<{ intent: RedeemIntent }>(`/api/redeem-intent/${created.id}/execute`));
        } catch (err) {
          if (!(err instanceof RedeemExecutionHttpError && err.code === 'FEE_ROUTER_REQUIRED' && isRedeemSettlementConfigured())) throw err;
          // A fee-paying sale: phase 1 quotes and plans (signs nothing), phase 2 re-checks, signs and compiles the
          // final settlement transaction. Either refusing is a server answer, reported as is.
          await postJson(`/api/redeem-intent/${created.id}/settlement-quote`);
          const { composerTransaction } = await postJson<{ composerTransaction: NonNullable<RedeemIntent['composerTransaction']> }>(
            `/api/redeem-intent/${created.id}/settlement-attest`
          );
          prepared = { ...created, composerTransaction };
          // The attestation's deadline: until then a declined signature can be given again (ResumableSale).
          deadline = (await getIntent(created.id))?.settlementPlan?.deadline;
        }
        setState((s) => ({ ...s, intent: prepared }));

        const swapSteps = prepared.steps.filter((s) => s.action === 'SWAP');
        if (prepared.composerTransaction) {
          await executeComposerSale(prepared.id, prepared.composerTransaction, swapSteps, walletAddress, deadline);
        } else {
          for (const step of swapSteps) {
            await executeOneStep(prepared.id, step, walletAddress);
          }
        }
      } catch (err) {
        if (err instanceof ResumableRejectionError) {
          offerResume(err.sale, declinedMessage(err.sale));
          return;
        }
        if (createdIntentId === null || err instanceof RedeemExecutionHttpError) {
          if (err instanceof RedeemExecutionHttpError) {
            // Blocked by a pending sale of this position that can still be signed: offer exactly that one.
            const blocker = err.intentId ? await getIntent(err.intentId) : null;
            const pending = resumableSaleOf(blocker, walletAddress);
            if (pending) {
              offerResume(pending, `A signed sale of this position is still waiting for your signature until ${new Date(pending.deadline * 1000).toLocaleTimeString()}. Sign it now, or start a different one after that.`);
              return;
            }
            if (blocker && err.intentId) {
              // Any other open sale: say which one, and let the user close it (the server checks the chain first).
              setState((s) => ({
                ...s,
                phase: 'failed',
                error: `An earlier sale of this Bag${Number.isFinite(new Date(blocker.createdAt).getTime()) ? `, started ${new Date(blocker.createdAt).toLocaleString()},` : ''} is still open (${blocker.status}). Close it to sell again: BAG first checks on-chain that it was never sent.`,
                failureCode: null,
                errorCode: 'BLOCKED_BY_OPEN_SALE',
                blocking: { intentId: blocker.id, status: blocker.status, createdAt: blocker.createdAt },
              }));
              return;
            }
            fail(err.message, err.failureCode, err.code);
          } else fail(err instanceof Error ? err.message : 'Redemption failed.');
          return;
        }
        if (routerAddress) {
          // The router path has no per-step server state machine to fall
          // through to (unlike the legacy LI.FI path below it) — a
          // mid-flow error here (rejected signature, reverted tx, a failed
          // confirm-router-tx call) is the final outcome, not something a
          // polling loop can still resolve.
          fail(err instanceof Error ? err.message : 'Redemption failed.');
          return;
        }
        // Same fall-through-to-verify reasoning as usePurchaseExecution's
        // start() — a wallet/execution error after a step was attempted
        // still needs the server's own on-chain check to decide the real
        // outcome, never this client-side guess.
      }

      await runVerifyLoop(createdIntentId);
    },
    [executeOneStep, executeComposerSale, runRouterFlow, runVerifyLoop, offerResume, fail, reset]
  );

  /** Signs the pending sale in `state.resumable` again: the same transaction, before its deadline. */
  const resume = useCallback(async (): Promise<void> => {
    const sale = state.resumable;
    if (!sale) return;
    if (sale.deadline * 1000 - Date.now() <= RESUME_MARGIN_MS) {
      fail('This sale has expired. Start a new one.');
      setState((s) => ({ ...s, resumable: null }));
      return;
    }
    setState((s) => ({ ...s, phase: 'awaiting_signature', error: null, errorCode: null, resumable: null }));
    try {
      await executeComposerSale(sale.intentId, sale.composerTransaction, sale.swapSteps, sale.walletAddress, sale.deadline);
    } catch (err) {
      if (err instanceof ResumableRejectionError) {
        offerResume(err.sale, declinedMessage(err.sale));
        return;
      }
      if (err instanceof RedeemExecutionHttpError) {
        fail(err.message, err.failureCode, err.code);
        return;
      }
      // A wallet error after the attempt: the server's on-chain check decides, as in start().
    }
    await runVerifyLoop(sale.intentId);
  }, [state.resumable, executeComposerSale, runVerifyLoop, offerResume, fail]);

  /** Closes the blocking sale (POST …/cancel, chain-checked on the server), then starts the sale the user asked for. */
  const closeBlockingAndRetry = useCallback(async (): Promise<void> => {
    const blocking = state.blocking;
    const last = lastStartRef.current;
    if (!blocking || !last) return;
    setState((s) => ({ ...s, phase: 'creating', error: null, errorCode: null }));
    try {
      const out = await postJson<{ result: 'CLOSED' | 'BOOKED' | 'ALREADY_FINAL' | 'REFUSED'; status: string; reason?: string }>(`/api/redeem-intent/${blocking.intentId}/cancel`);
      if (out.result === 'REFUSED') {
        setState((s) => ({ ...s, phase: 'failed', error: out.reason ?? 'The earlier sale could not be closed yet.', errorCode: 'BLOCKED_BY_OPEN_SALE' }));
        return;
      }
    } catch (err) {
      if (err instanceof RedeemExecutionHttpError) fail(err.message, err.failureCode, err.code);
      else fail(err instanceof Error ? err.message : 'The earlier sale could not be closed.');
      return;
    }
    await start(last.bagId, last.fractionBps, last.outputAssetId, last.walletAddress);
  }, [state.blocking, start, fail]);

  return { state, start, resume, closeBlockingAndRetry, reset };
}
