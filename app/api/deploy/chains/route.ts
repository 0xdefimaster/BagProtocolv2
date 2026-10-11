import { NextResponse } from 'next/server';
import { NETWORKS } from '@/lib/constants';
import { isEvmChainConfigured } from '@/lib/blockchain/evm/config';
import type { ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Which networks a Bag can be published on from this deployment: a BagFactory
// address and an RPC are configured for it (FACTORY_ADDRESS_<CHAIN>, see
// .env.example). Create offers only these; the rest show as coming soon.
// Reads configuration only: no RPC call, no address in the response.
//
//   GET /api/deploy/chains -> { deployable: ChainId[] }
// -----------------------------------------------------------------------------

export async function GET() {
  const deployable = NETWORKS.map((n) => n.id as ChainId).filter((id) => isEvmChainConfigured(id));
  return NextResponse.json({ deployable }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
