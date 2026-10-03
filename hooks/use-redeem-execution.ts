'use client';

import { useCallback, useRef, useState } from 'react';
import { executeRoute, convertQuoteToRoute, LiFiStep, RouteExtended, ExecutionAction } from '@lifi/sdk';
import { RedeemIntent, RedeemIntentFailureCode, RedeemIntentStepRecord } from '@/types/redeem-intent';
import { getBrowserLiFiClient } from '@/lib/blockchain/lifi-wallet-client';
import { ensureRouterAllowance, sendRedeemTransaction, collectRequiredApprovals } from '@/lib/blockchain/redeem-fee-router-client';
import type { FeeAttestation } from '@/lib/server/redeem-fee-attestation';

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
// -----------------------------------------------------------------------------

function getConfiguredRedeemFeeRouterAddress(): `0x${string}` | null {
  const raw = process.env.NEXT_PUBLIC_REDEEM_FEE_ROUTER_ADDRESS;
  return raw ? (raw as `0x${string}`) : null;
}

export type RedeemExecutionPhase = 'idle' | 'creating' | 'preparing' | 'awaiting_signature' | 'confirming' | 'completed' | 'failed';

export interface RedeemExecutionState {
  phase: RedeemExecutionPhase;
  intent: RedeemIntent | null;
  activeStepIndex: number | null;
  error: string | null;
  failureCode: RedeemIntentFailureCode | null;
}

const INITIAL_STATE: RedeemExecutionState = {
  phase: 'idle',
  intent: null,
  activeStepIndex: null,
  error: null,
  failureCode: null,
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
    throw new RedeemExecutionHttpError(data?.error ?? `Request failed (${res.status})`, data?.failureCode ?? null);
  }
  return data as T;
}

class RedeemExecutionHttpError extends Error {
  constructor(
    message: string,
    public readonly failureCode: RedeemIntentFailureCode | null
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

  const fail = useCallback((error: string, failureCode: RedeemIntentFailureCode | null = null) => {
    setState((s) => ({ ...s, phase: 'failed', error, failureCode }));
  }, []);

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

  const start = useCallback(
    async (bagId: string, sharesToRedeemRaw: string, outputAssetId: string, walletAddress: string): Promise<void> => {
      reset();
      setState((s) => ({ ...s, phase: 'creating' }));

      let createdIntentId: string | null = null;
      const routerAddress = getConfiguredRedeemFeeRouterAddress();

      try {
        const { intent: created } = await postJson<{ intent: RedeemIntent }>(`/api/bags/${bagId}/redeem-intent`, {
          sharesToRedeemRaw,
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
        const { intent: prepared } = await postJson<{ intent: RedeemIntent }>(`/api/redeem-intent/${created.id}/execute`);
        setState((s) => ({ ...s, intent: prepared }));

        const swapSteps = prepared.steps.filter((s) => s.action === 'SWAP');
        for (const step of swapSteps) {
          await executeOneStep(prepared.id, step, walletAddress);
        }
      } catch (err) {
        if (createdIntentId === null || err instanceof RedeemExecutionHttpError) {
          if (err instanceof RedeemExecutionHttpError) fail(err.message, err.failureCode);
          else fail(err instanceof Error ? err.message : 'Redemption failed.');
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

      setState((s) => ({ ...s, phase: 'confirming' }));

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const verified = await verifyIntent(createdIntentId);
          setState((s) => ({ ...s, intent: verified }));
          if (verified.status === 'COMPLETED') {
            setState((s) => ({ ...s, phase: 'completed' }));
            return;
          }
          if (verified.status === 'FAILED' || verified.status === 'EXPIRED' || verified.status === 'CANCELLED') {
            fail('The redemption could not be completed.', verified.failureCode);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
      } catch (err) {
        if (err instanceof RedeemExecutionHttpError) {
          fail(err.message, err.failureCode);
        } else {
          fail(err instanceof Error ? err.message : 'Redemption failed.');
        }
      }
    },
    [executeOneStep, runRouterFlow, fail, reset]
  );

  return { state, start, reset };
}
