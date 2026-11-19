import { NextResponse } from 'next/server';
import { NETWORKS } from '@/lib/constants';
import { isEvmChainConfigured } from '@/lib/blockchain/evm/config';
import { performanceFeeEnabledOn } from '@/lib/config/settlement';
import { rebalanceSupportedOn } from '@/lib/server/rebalance-support';
import type { ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Which networks a Bag can be published on from this deployment: a BagFactory
// address and an RPC are configured for it (FACTORY_ADDRESS_<CHAIN>, see
// .env.example). Create offers only these; the rest show as coming soon.
// `performanceFee`: the deployable networks where a creator fee can be settled
// (lib/config/settlement.ts); elsewhere Create keeps the fee at 0%.
// `rebalance`: the deployable networks where holders can rebalance from their wallet.
// Reads configuration only: no RPC call, no address in the response.
//
//   GET /api/deploy/chains -> { deployable: ChainId[], performanceFee: ChainId[], rebalance: ChainId[] }
// -----------------------------------------------------------------------------

export async function GET() {
  const deployable = NETWORKS.map((n) => n.id as ChainId).filter((id) => isEvmChainConfigured(id));
  const performanceFee = deployable.filter((id) => performanceFeeEnabledOn(id));
  const rebalance = deployable.filter((id) => rebalanceSupportedOn(id));
  return NextResponse.json({ deployable, performanceFee, rebalance }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
