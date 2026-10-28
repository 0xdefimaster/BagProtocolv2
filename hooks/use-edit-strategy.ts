'use client';

import { useCallback, useRef, useState } from 'react';
import { getBrowserWalletClientForChain } from '@/lib/blockchain/lifi-wallet-client';
import { describeWalletError } from '@/lib/blockchain/wallet-error';

// -----------------------------------------------------------------------------
// Client side of "Edit strategy" for a deployed, MUTABLE Bag (same shape as hooks/use-deploy-bag.ts):
//
//   prepare (POST /api/bags/[id]/versions/prepare, { composition, reason })
//     -> the connected wallet must be the signed-in wallet (checked before any prompt)
//     -> the creator's own wallet signs and sends BagFactory.recordBagVersion (no value)
//     -> confirm (POST …/versions/confirm, same body + txHash), retried while PENDING
//
// Only the assets and weights are sent; the server keeps the rest of the recipe and verifies the transaction on
// chain before recording the version. The server never signs. The sent transaction (and what it recorded) is kept
// in localStorage until confirmed, so a refresh resumes confirming instead of asking for another signature.
// Without it (another browser, cleared storage, or a failed database write), `checkStatus` shows that the chain is
// ahead and `recover` has the server record the change it saved at prepare (migration 0059).
// -----------------------------------------------------------------------------

export interface CompositionEntry {
  address: string;
  weightBps: number;
}

export type EditStrategyPhase = 'idle' | 'preparing' | 'awaiting_signature' | 'confirming' | 'completed' | 'failed';

export interface EditStrategyState {
  phase: EditStrategyPhase;
  error: string | null;
  pending: boolean;
  newVersion: number | null;
}

const INITIAL: EditStrategyState = { phase: 'idle', error: null, pending: false, newVersion: null };

const pendingKey = (bagId: string) => `bag-version-pending:${bagId}`;
interface PendingEdit {
  txHash: string;
  composition: CompositionEntry[];
  reason: string;
}

function readPending(bagId: string): PendingEdit | null {
  try {
    const raw = localStorage.getItem(pendingKey(bagId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingEdit;
    return typeof parsed?.txHash === 'string' && Array.isArray(parsed.composition) ? parsed : null;
  } catch {
    return null;
  }
}
function writePending(bagId: string, value: PendingEdit | null) {
  try {
    if (value) localStorage.setItem(pendingKey(bagId), JSON.stringify(value));
    else localStorage.removeItem(pendingKey(bagId));
  } catch {
    // Storage unavailable: confirming still works in this tab, it just won't survive a refresh.
  }
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

interface FailureBody {
  error?: string;
  code?: string;
  message?: string;
  expected?: string;
  issues?: { message: string; severity: string }[];
  version?: number;
  txHash?: string | null;
  fields?: string[];
}

/** GET /api/bags/[id]/versions/status (lib/server/bag-version-recovery.ts). */
export interface VersionSync {
  recordedVersion: number;
  chainVersion: number;
  inSync: boolean;
  pendingProposals: number;
}

export type SyncState =
  | { kind: 'unknown' }
  | { kind: 'checking' }
  | { kind: 'ready'; sync: VersionSync }
  | { kind: 'recovering' }
  | { kind: 'error'; message: string };

/** The server's failure codes (app/api/bags/[id]/versions/_shared.ts) as something the creator can act on. */
export function describeVersionFailure(body: FailureBody): string {
  switch (body.code) {
    case 'NO_CHANGE':
      return 'Nothing changed: the assets and weights are the same as the current version.';
    case 'VALIDATION_FAILED': {
      const errors = (body.issues ?? []).filter((i) => i.severity === 'ERROR').map((i) => i.message);
      return errors.length > 0 ? errors.join(' ') : 'The new strategy did not pass validation.';
    }
    case 'WRONG_WALLET':
      return `Only the wallet that deployed this Bag can edit it${body.expected?.startsWith('0x') ? ` (${body.expected})` : ''}.`;
    case 'IMMUTABLE_BAG':
      return 'This Bag was created as immutable; its strategy cannot change. Fork it to make your own version.';
    case 'NOT_DEPLOYED':
      return 'Deploy the Bag first.';
    case 'OUT_OF_SYNC':
      return 'The chain already has a newer version than this page. Use "Complete update" below.';
    case 'STALE_VERSION':
      return 'Another version was recorded meanwhile. Reload the page and try again.';
    case 'PERFORMANCE_FEE_LOCKED':
      return 'The performance fee is locked and cannot change in a new version.';
    case 'FORBIDDEN':
      return 'Only the creator can edit this Bag.';
    case 'NO_WALLET_ON_SESSION':
      return 'Sign in with your wallet first.';
    case 'CHAIN_UNAVAILABLE':
    case 'CHAIN_ERROR':
      return `The network could not be reached${body.message ? `: ${body.message}` : ''}. Try again.`;
    case 'VERIFICATION_FAILED':
      return `The transaction could not be verified${body.message ? `: ${body.message}` : ''}.`;
    case 'IMMUTABLE_FIELD':
      return 'Only the assets and their weights can change in a new version.';
    case 'PROPOSAL_CONFLICT':
      return 'A different saved change for exactly these assets is already waiting for this version. Use "Check status", or change the weights slightly.';
    case 'PROPOSAL_NOT_SAVED':
      return 'The change could not be saved on the server, so nothing was sent to your wallet. Try again.';
    case 'PENDING':
      return 'The transaction is not confirmed on chain yet. Check again in a moment.';
    case 'NOT_FOUND_ON_CHAIN':
      return `The chain reports version ${body.version ?? ''} but its transaction was not found yet. Check again in a moment, or paste the transaction hash from your wallet.`;
    case 'NO_PROPOSAL':
      return `The chain has version ${body.version ?? ''}${body.txHash ? ` (transaction ${body.txHash})` : ''}, but this server has no saved change that matches it, so it cannot be recorded automatically. Contact support with the transaction hash.`;
    case 'CHAIN_BEHIND':
      return 'The chain reports an older version than this server recorded. Nothing was changed; contact support.';
    default:
      return body.message ?? body.error ?? 'Could not save the new strategy.';
  }
}

export function useEditStrategy(bagId: string) {
  const [state, setState] = useState<EditStrategyState>(INITIAL);
  const cancelledRef = useRef(false);

  const [sync, setSync] = useState<SyncState>({ kind: 'unknown' });

  /** Where the server and the chain stand. Read-only. */
  const checkStatus = useCallback(async () => {
    setSync({ kind: 'checking' });
    try {
      const res = await fetch(`/api/bags/${bagId}/versions/status`);
      const json = (await res.json().catch(() => ({}))) as FailureBody & Partial<VersionSync>;
      if (res.ok && typeof json.recordedVersion === 'number' && typeof json.chainVersion === 'number') {
        setSync({ kind: 'ready', sync: json as VersionSync });
      } else {
        setSync({ kind: 'error', message: describeVersionFailure(json) });
      }
    } catch {
      setSync({ kind: 'error', message: 'Could not reach the server.' });
    }
  }, [bagId]);

  const confirmLoop = useCallback(
    async (pending: PendingEdit) => {
      setState((s) => ({ ...s, phase: 'confirming', pending: false, error: null }));
      const delays = [1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000, 8000, 8000];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (cancelledRef.current) return;
        const { status, json } = await postJson<FailureBody & { version?: { version: number } | null }>(`/api/bags/${bagId}/versions/confirm`, pending);
        if (status === 200) {
          writePending(bagId, null);
          setState({ phase: 'completed', error: null, pending: false, newVersion: json.version?.version ?? null });
          return;
        }
        if (status === 202) {
          setState((s) => ({ ...s, pending: true }));
          if (attempt < delays.length) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
            continue;
          }
        }
        // A definitive refusal of this transaction (or a state it can never confirm in): forget it so a fresh edit
        // can start. Anything else keeps it, so `resumePending` retries the same transaction without a new signature.
        if (status === 422 || status === 409 || status === 403) writePending(bagId, null);
        setState({ phase: 'failed', error: describeVersionFailure(json), pending: status === 202, newVersion: null });
        return;
      }
    },
    [bagId]
  );

  /** Picks back up a version transaction that was sent but not confirmed (e.g. across a refresh). */
  const resumePending = useCallback(async () => {
    const pending = readPending(bagId);
    if (!pending) return false;
    cancelledRef.current = false;
    await confirmLoop(pending);
    return true;
  }, [bagId, confirmLoop]);

  const submit = useCallback(
    async (connectedWallet: string, composition: CompositionEntry[], reason: string) => {
      cancelledRef.current = false;
      setState({ ...INITIAL, phase: 'preparing' });
      const { status, json } = await postJson<FailureBody & { transaction?: { to: string; data: string; chainId: number }; wallet?: string }>(
        `/api/bags/${bagId}/versions/prepare`,
        { composition, reason }
      );
      if (status !== 200 || !json.transaction || !json.wallet) {
        setState({ ...INITIAL, phase: 'failed', error: describeVersionFailure(json) });
        // The chain is ahead of the server: show the real state and the way to complete it.
        if (json.code === 'OUT_OF_SYNC') void checkStatus();
        return;
      }
      if (connectedWallet.toLowerCase() !== json.wallet.toLowerCase()) {
        setState({ ...INITIAL, phase: 'failed', error: `Your connected wallet doesn't match your signed-in wallet. Switch to ${json.wallet} and try again.` });
        return;
      }

      let txHash: string;
      try {
        setState((s) => ({ ...s, phase: 'awaiting_signature' }));
        const client = await getBrowserWalletClientForChain(connectedWallet, json.transaction.chainId);
        if (!client.chain) throw new Error(`Your wallet is on an unsupported network. Switch to chain id ${json.transaction.chainId} and try again.`);
        txHash = await client.sendTransaction({
          account: connectedWallet as `0x${string}`,
          chain: client.chain,
          to: json.transaction.to as `0x${string}`,
          data: json.transaction.data as `0x${string}`,
          value: BigInt(0),
        });
      } catch (err) {
        const described = describeWalletError(err);
        setState({ ...INITIAL, phase: 'failed', error: described.rejected ? 'Signature request was rejected.' : described.message });
        return;
      }

      const pending: PendingEdit = { txHash, composition, reason };
      writePending(bagId, pending);
      await confirmLoop(pending);
    },
    [bagId, confirmLoop, checkStatus]
  );

  /**
   * "Complete update": the server finds the version on chain, verifies it and records the change it saved at prepare.
   * Works from any browser; `txHash` is optional and verified like everything else.
   */
  const recover = useCallback(
    async (txHash?: string) => {
      setSync({ kind: 'recovering' });
      const { status, json } = await postJson<FailureBody & Partial<VersionSync> & { recovered?: { version: number }[] }>(
        `/api/bags/${bagId}/versions/recover`,
        txHash ? { txHash } : {}
      );
      if (status === 200 && typeof json.recordedVersion === 'number' && typeof json.chainVersion === 'number') {
        writePending(bagId, null);
        setSync({ kind: 'ready', sync: json as VersionSync });
        const last = json.recovered?.[json.recovered.length - 1];
        if (last) setState({ phase: 'completed', error: null, pending: false, newVersion: last.version });
        return;
      }
      setSync({ kind: 'error', message: describeVersionFailure(json) });
    },
    [bagId]
  );

  const reset = useCallback(() => setState(INITIAL), []);
  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  return { state, submit, resumePending, reset, cancel, sync, checkStatus, recover };
}
