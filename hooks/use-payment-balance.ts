'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, erc20Abi, http, type PublicClient } from 'viem';
import { BAG_CHAINS, isBagChain, type BagChain } from '@/lib/config/chains';
import { isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';
import type { ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// The buyer's balance of the payment asset selected in the purchase modal,
// read from the asset's OWN chain through a public client — not through the
// wallet provider — so the Robinhood Chain balance is right even while the
// wallet is pointed at another network.
//
// Display and a pre-check only. The execution flow still checks the real
// balance on chain (INSUFFICIENT_BALANCE), so an unknown balance (loading,
// error) never blocks a purchase: it only means we can't help up front.
//
// A balance is never guessed: on any RPC error it is `null` with status
// 'error', never a made-up 0n.
// -----------------------------------------------------------------------------

export type PaymentBalanceStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PaymentBalanceAsset {
  chain: string;
  address: string;
  decimals: number;
}

export interface PaymentBalance {
  balanceRaw: bigint | null;
  status: PaymentBalanceStatus;
  refetch(): void;
}

// One public client per chain for the whole page (module level), on the
// chain's own config (lib/config/chains.ts): no chain id or RPC is typed here.
const clients = new Map<BagChain, PublicClient>();
export function publicClientFor(chain: BagChain): PublicClient {
  let client = clients.get(chain);
  if (!client) {
    client = createPublicClient({ chain: BAG_CHAINS[chain].viemChain, transport: http() }) as PublicClient;
    clients.set(chain, client);
  }
  return client;
}

/** True for the chain's native asset (NATIVE_ASSET_ADDRESS), by the same identity rule as the rest of the protocol. */
export function isNativePaymentAsset(asset: Pick<PaymentBalanceAsset, 'chain' | 'address'>): boolean {
  return isNativeAssetIdentity({ chain: asset.chain as ChainId, address: asset.address });
}

export async function readPaymentBalance(asset: PaymentBalanceAsset, walletAddress: string): Promise<bigint> {
  if (!isBagChain(asset.chain)) throw new Error(`No EVM client for chain "${asset.chain}".`);
  const client = publicClientFor(asset.chain);
  const owner = walletAddress as `0x${string}`;
  if (isNativePaymentAsset(asset)) return client.getBalance({ address: owner });
  return client.readContract({ address: asset.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

interface Stored {
  key: string;
  balanceRaw: bigint | null;
  status: 'ready' | 'error';
}

export function usePaymentBalance(asset: PaymentBalanceAsset | null, walletAddress: string | null): PaymentBalance {
  const [stored, setStored] = useState<Stored | null>(null);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  // The request this render is about. A result is only ever shown for the
  // key it was read for: switching asset or wallet makes the previous
  // result invisible in the very same render (no stale figure, not even for
  // one frame), and a slow answer for the old key can never land on the new one.
  const key = asset && walletAddress ? `${asset.chain}:${asset.address.toLowerCase()}:${walletAddress.toLowerCase()}#${nonce}` : null;

  useEffect(() => {
    if (!key || !asset || !walletAddress) return;
    let cancelled = false;
    readPaymentBalance(asset, walletAddress)
      .then((balanceRaw) => {
        if (!cancelled) setStored({ key, balanceRaw, status: 'ready' });
      })
      .catch(() => {
        if (!cancelled) setStored({ key, balanceRaw: null, status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `key` covers chain, address, wallet and refetch; decimals do not change what is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return { balanceRaw: null, status: 'idle', refetch };
  if (!stored || stored.key !== key) return { balanceRaw: null, status: 'loading', refetch };
  return { balanceRaw: stored.balanceRaw, status: stored.status, refetch };
}

// ----------------------------- Native gas reserve -----------------------------
//
// Paying with the chain's native token, the purchase transaction's own gas is
// paid from the same balance, so "MAX" and the insufficient-balance check
// leave a reserve:
//
//   reserve = gasPrice × PURCHASE_GAS_LIMIT × GAS_RESERVE_MULTIPLIER
//
// - PURCHASE_GAS_LIMIT 3,000,000: a multi-leg LI.FI Composer purchase is one
//   transaction with several swaps. On an Arbitrum Orbit chain such as
//   Robinhood Chain the gas units also carry the L1 data cost, so a basket
//   purchase can use well over 1M units; 3M covers a large basket with room.
// - GAS_RESERVE_MULTIPLIER 2: the gas price can rise between this read and
//   the transaction.
// - FALLBACK_GAS_RESERVE_WEI 0.001 ETH: used when the gas price cannot be
//   read. At typical L2 prices the formula gives well under this, so the
//   fallback errs on the side of leaving more ETH, never less.
// These are a convenience for MAX, not a guarantee: the wallet still shows
// the real fee, and the chain refuses a transaction it cannot pay for.

export const PURCHASE_GAS_LIMIT = BigInt(3_000_000);
export const GAS_RESERVE_MULTIPLIER = BigInt(2);
export const FALLBACK_GAS_RESERVE_WEI = BigInt(10) ** BigInt(15); // 0.001 ETH

/** Gas reserve for a native-token purchase. Never throws: a failed gas-price read gives the fixed fallback. */
export async function estimateGasReserveRaw(client: Pick<PublicClient, 'getGasPrice'>): Promise<bigint> {
  try {
    const gasPrice = await client.getGasPrice();
    return gasPrice * PURCHASE_GAS_LIMIT * GAS_RESERVE_MULTIPLIER;
  } catch {
    return FALLBACK_GAS_RESERVE_WEI;
  }
}

/** What can be spent: the whole balance for an ERC-20; for the native token, the balance minus the gas reserve, never below 0. */
export function usableBalanceRaw(balanceRaw: bigint, isNative: boolean, gasReserveRaw: bigint): bigint {
  if (!isNative) return balanceRaw;
  return balanceRaw > gasReserveRaw ? balanceRaw - gasReserveRaw : BigInt(0);
}

/** The gas reserve for `chain` while `enabled` (paying with the native token); null until it is known. */
export function useNativeGasReserve(chain: string | null, enabled: boolean): bigint | null {
  const [reserve, setReserve] = useState<{ chain: string; raw: bigint } | null>(null);
  useEffect(() => {
    if (!enabled || !chain || !isBagChain(chain)) return;
    let cancelled = false;
    void estimateGasReserveRaw(publicClientFor(chain)).then((raw) => {
      if (!cancelled) setReserve({ chain, raw });
    });
    return () => {
      cancelled = true;
    };
  }, [chain, enabled]);
  return enabled && reserve && reserve.chain === chain ? reserve.raw : null;
}
