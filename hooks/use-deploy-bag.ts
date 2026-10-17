'use client';

import { useCallback, useRef, useState } from 'react';
import { getBrowserWalletClientForChain } from '@/lib/blockchain/lifi-wallet-client';
import { describeWalletError } from '@/lib/blockchain/wallet-error';

// -----------------------------------------------------------------------------
// Client-side orchestrator for the user-signed Bag deployment flow:
//
//   prepare (POST …/deploy/prepare)
//     -> verify the CONNECTED wallet matches the session wallet the server
//        will require (fail fast, before prompting a signature for nothing)
//     -> the person's own wallet signs + sends `createBag`, with the protocol
//        creation fee (native ETH) as the transaction value — one signature
//     -> confirm (POST …/deploy/confirm), retried while PENDING
//
// Same shape as hooks/use-purchase-execution.ts: no LI.FI SDK here (this is a
// single plain calldata transaction, not a route), but the same wallet-client
// helper (lib/blockchain/lifi-wallet-client.ts's `getBrowserWalletClientForChain`)
// is reused rather than talking to `window.ethereum` directly a second way.
//
// SURVIVES A REFRESH: the pending txHash (between "sent" and "confirmed") is
// persisted to localStorage keyed by bagId, so a reload/close-tab during that
// window does not strand the person — reopening the panel resumes confirming
// automatically instead of re-prompting prepare.
// -----------------------------------------------------------------------------

export type DeployBagPhase = 'idle' | 'preparing' | 'awaiting_signature' | 'confirming' | 'completed' | 'failed';

export interface DeployBagState {
  phase: DeployBagPhase;
  error: string | null;
  /** Set once confirm returns PENDING — not a failure; `retry()` re-runs confirm for the same tx. */
  pending: boolean;
  deployment: { txHash: string; contractAddress: string; onChainBagId: string } | null;
  bagStatus: string | null;
}

const INITIAL_STATE: DeployBagState = { phase: 'idle', error: null, pending: false, deployment: null, bagStatus: null };

const pendingTxKey = (bagId: string) => `bag-deploy-pending-tx:${bagId}`;

async function postJson<T>(url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

interface PrepareResponse {
  transaction: { to: string; data: string; chainId: number; value?: string };
  wallet: string;
  error?: string;
  code?: string;
  /** Set with code ALREADY_CREATED_ON_CHAIN when the server found the earlier creation transaction. */
  txHash?: string;
}
interface ConfirmResponse {
  deployment?: { txHash: string; contractAddress: string; onChainBagId: string };
  bag?: { status: string };
  error?: string;
  code?: string;
  message?: string;
}

export function useDeployBag(bagId: string) {
  const [state, setState] = useState<DeployBagState>(INITIAL_STATE);
  const cancelledRef = useRef(false);

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  const confirmLoop = useCallback(
    async (txHash: string) => {
      setState((s) => ({ ...s, phase: 'confirming', pending: false }));
      // Bounded retries with backoff — the server's own wait (BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS)
      // is itself bounded, so a 202 PENDING here means "ask again shortly", not "wait forever".
      const delays = [1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000, 8000, 8000];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (cancelledRef.current) return;
        const { status, json } = await postJson<ConfirmResponse>(`/api/bags/${bagId}/deploy/confirm`, { txHash });
        if (status === 200 && json.deployment && json.bag) {
          localStorage.removeItem(pendingTxKey(bagId));
          setState({ phase: 'completed', error: null, pending: false, deployment: json.deployment, bagStatus: json.bag.status });
          return;
        }
        if (status === 202) {
          setState((s) => ({ ...s, pending: true }));
          if (attempt < delays.length) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
            continue;
          }
        }
        // 422 = the server definitively refused THIS transaction (wrong factory, wrong sender, reverted):
        // it can never confirm, so forget it — otherwise every reopen of the panel would resume the same
        // dead hash and the person could never start a fresh deployment.
        if (status === 422) localStorage.removeItem(pendingTxKey(bagId));
        // Any other failure (or we've stopped retrying a still-pending tx): stop, but keep the
        // pending hash around — `retry()` picks the SAME transaction back up rather than re-signing.
        setState({
          phase: 'failed',
          error: json.error ?? 'Could not confirm the deployment.',
          pending: status === 202,
          deployment: null,
          bagStatus: null,
        });
        return;
      }
    },
    [bagId]
  );

  /** Resumes confirming a transaction that was already sent (e.g. left pending across a refresh). */
  const resumePending = useCallback(async () => {
    const txHash = localStorage.getItem(pendingTxKey(bagId));
    if (!txHash) return false;
    await confirmLoop(txHash);
    return true;
  }, [bagId, confirmLoop]);

  const deploy = useCallback(
    async (connectedWallet: string) => {
      cancelledRef.current = false;
      setState({ ...INITIAL_STATE, phase: 'preparing' });

      const { status, json: prepared } = await postJson<PrepareResponse>(`/api/bags/${bagId}/deploy/prepare`);
      // An earlier creation succeeded on-chain but was never confirmed, and the server found its transaction:
      // confirm that one (no new signature, no second fee). Confirm re-verifies it fully server-side.
      if (status === 409 && prepared.code === 'ALREADY_CREATED_ON_CHAIN' && typeof prepared.txHash === 'string') {
        localStorage.setItem(pendingTxKey(bagId), prepared.txHash);
        await confirmLoop(prepared.txHash);
        return;
      }
      if (status !== 200) {
        setState({ ...INITIAL_STATE, phase: 'failed', error: prepared.error ?? 'Could not prepare the deployment.' });
        return;
      }

      // Fail fast, before ever prompting a signature: the server will only ever accept a transaction
      // sent from the SESSION wallet, so a mismatched connected wallet is refused here, not after gas.
      if (connectedWallet.toLowerCase() !== prepared.wallet.toLowerCase()) {
        setState({
          ...INITIAL_STATE,
          phase: 'failed',
          error: `Your connected wallet doesn't match your signed-in wallet. Switch to ${prepared.wallet} and try again.`,
        });
        return;
      }

      let txHash: string;
      try {
        setState((s) => ({ ...s, phase: 'awaiting_signature' }));
        const client = await getBrowserWalletClientForChain(connectedWallet, prepared.transaction.chainId);
        if (!client.chain) throw new Error(`Your wallet is on an unsupported network. Switch to chain id ${prepared.transaction.chainId} and try again.`);
        txHash = await client.sendTransaction({
          account: connectedWallet as `0x${string}`,
          chain: client.chain,
          to: prepared.transaction.to as `0x${string}`,
          data: prepared.transaction.data as `0x${string}`,
          // The creation fee, exactly as the factory requires it.
          value: BigInt(prepared.transaction.value ?? '0'),
        });
      } catch (err) {
        // Rejection or a send-time failure: nothing was ever written server-side (prepare is
        // stateless), so there is nothing to roll back — the person can just try again.
        const described = describeWalletError(err);
        const message = described.rejected ? 'Signature request was rejected.' : described.message;
        setState({ ...INITIAL_STATE, phase: 'failed', error: message });
        return;
      }

      localStorage.setItem(pendingTxKey(bagId), txHash);
      await confirmLoop(txHash);
    },
    [bagId, confirmLoop]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  return { state, deploy, retry: resumePending, resumePending, reset, cancel };
}
