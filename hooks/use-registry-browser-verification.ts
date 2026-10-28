'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, http } from 'viem';
import { BAG_CHAINS, isBagChain } from '@/lib/config/chains';
import { verifyRegistrationsInBrowser, type BrowserVerifyResult } from '@/lib/blockchain/registry-browser-verify';
import type { RegistryClient } from '@/packages/bag-sdk/src';

// Runs lib/blockchain/registry-browser-verify.ts once per registered-version set, reading the chain through the
// chain operator's public RPC from the viewer's browser (no BAG server in the read).

export function useRegistryBrowserVerification(input: {
  bagId: string;
  chain: string | null;
  creatorWallet: string | null;
  serverRegistryAddress: string | null;
  versions: number[];
}): { result: BrowserVerifyResult | null; checking: boolean } {
  const [result, setResult] = useState<BrowserVerifyResult | null>(null);
  const [checking, setChecking] = useState(false);
  const key = input.versions.join(',');

  useEffect(() => {
    const { bagId, chain, creatorWallet, serverRegistryAddress } = input;
    const versions = key ? key.split(',').map(Number) : [];
    if (!chain || !creatorWallet || versions.length === 0 || !isBagChain(chain)) {
      setResult(null);
      return;
    }
    const rpc = BAG_CHAINS[chain].publicRpcUrls[0];
    if (!rpc) {
      setResult({ registry: null, registryMismatch: false, checks: versions.map((version) => ({ version, state: 'UNAVAILABLE', detail: `No public RPC for ${chain}.` })) });
      return;
    }
    let cancelled = false;
    setChecking(true);
    const client = createPublicClient({ chain: BAG_CHAINS[chain].viemChain, transport: http(rpc) }) as unknown as RegistryClient;
    verifyRegistrationsInBrowser({ bagId, chain, creatorWallet, serverRegistryAddress, versions, client })
      .then((r) => !cancelled && setResult(r))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.bagId, input.chain, input.creatorWallet, input.serverRegistryAddress, key]);

  return { result, checking };
}
