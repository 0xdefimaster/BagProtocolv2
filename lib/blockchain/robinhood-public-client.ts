import type { PublicClient } from 'viem';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';

// Kept for existing call sites (Uniswap quoter, redeem attestation, pricing):
// the Robinhood Chain read client is the resilient multi-provider client from
// lib/blockchain/rpc/clients.ts.
export function getRobinhoodPublicClient(): PublicClient {
  return getChainPublicClient('robinhood');
}
