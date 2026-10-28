'use client';

import { useCallback, useState } from 'react';
import { getBrowserWalletClientForChain } from '@/lib/blockchain/lifi-wallet-client';
import { describeWalletError } from '@/lib/blockchain/wallet-error';

// -----------------------------------------------------------------------------
// StrategyRegistry registration from the creator's own wallet
// (lib/server/strategy-registration.ts). Loop: prepare (server builds the
// calldata) → the wallet signs and sends → confirm (server verifies the receipt
// and records it), until the server says there is nothing left to register.
// The server never signs; nothing is recorded until the receipt verifies.
// -----------------------------------------------------------------------------

export type RegistrationPhase = 'idle' | 'preparing' | 'awaiting_signature' | 'confirming' | 'completed' | 'failed';

/**
 * What `register` ended with. `skipped`: nothing this wallet can register right now that is not an error of the flow
 * itself (no registry on this deployment, or a fork whose parent is not registered) — a flow that registers as a
 * follow-up step (after deploy or a new version) carries on; the Passport tab still offers it later.
 */
export type RegistrationOutcome = 'completed' | 'skipped' | 'rejected' | 'failed';
const NOT_BLOCKING = new Set(['REGISTRY_NOT_CONFIGURED', 'FORK_PARENT_VERSION_UNKNOWN', 'PARENT_NOT_REGISTERED']);

interface PrepareResponse {
  transaction?: { to: string; data: string; chainId: number };
  kind?: 'REGISTER' | 'REGISTER_FORK' | 'PUBLISH_VERSIONS' | 'PUBLISH_COMPOSITION';
  covers?: { version: number }[];
  error?: string;
  code?: string;
}

async function post<T>(url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

export function useStrategyRegistration(bagId: string) {
  const [phase, setPhase] = useState<RegistrationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);

  const confirm = useCallback(
    async (txHash: string): Promise<boolean> => {
      const delays = [1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000];
      for (let i = 0; i <= delays.length; i++) {
        const { status, json } = await post<{ error?: string }>(`/api/bags/${bagId}/registry/confirm`, { txHash });
        if (status === 200) return true;
        if (status === 202 && i < delays.length) {
          await new Promise((r) => setTimeout(r, delays[i]));
          continue;
        }
        setError(json.error ?? 'Could not verify the registration transaction.');
        return false;
      }
      return false;
    },
    [bagId]
  );

  const register = useCallback(
    async (connectedWallet: string): Promise<RegistrationOutcome> => {
      setError(null);
      for (let round = 0; round < 4; round++) {
        setPhase('preparing');
        const { status, json } = await post<PrepareResponse>(`/api/bags/${bagId}/registry/prepare`);
        if (status === 409 && json.code === 'NOTHING_TO_REGISTER') {
          setPhase('completed');
          return 'completed';
        }
        if (status !== 200 || !json.transaction) {
          setError(json.error ?? 'Could not prepare the registration.');
          setPhase('failed');
          return json.code && NOT_BLOCKING.has(json.code) ? 'skipped' : 'failed';
        }
        const versions = (json.covers ?? []).map((c) => `v${c.version}`).join(', ');
        setStep(
          json.kind === 'PUBLISH_COMPOSITION'
            ? `Publishing ${versions} weights`
            : json.kind === 'PUBLISH_VERSIONS'
              ? `Publishing ${versions}`
              : json.kind === 'REGISTER_FORK'
                ? 'Registering the fork (v1)'
                : 'Registering v1'
        );
        let txHash: string;
        try {
          setPhase('awaiting_signature');
          const client = await getBrowserWalletClientForChain(connectedWallet, json.transaction.chainId);
          if (!client.chain) throw new Error(`Your wallet is on an unsupported network. Switch to chain id ${json.transaction.chainId} and try again.`);
          txHash = await client.sendTransaction({
            account: connectedWallet as `0x${string}`,
            chain: client.chain,
            to: json.transaction.to as `0x${string}`,
            data: json.transaction.data as `0x${string}`,
          });
        } catch (err) {
          const d = describeWalletError(err);
          setError(d.rejected ? 'Signature request was rejected.' : d.message);
          setPhase('failed');
          return d.rejected ? 'rejected' : 'failed';
        }
        setPhase('confirming');
        if (!(await confirm(txHash))) {
          setPhase('failed');
          return 'failed';
        }
      }
      setPhase('completed');
      return 'completed';
    },
    [bagId, confirm]
  );

  return { phase, error, step, register };
}
