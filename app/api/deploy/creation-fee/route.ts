import { NextRequest, NextResponse } from 'next/server';
import { readFactoryCreationFee } from '@/lib/blockchain/evm/adapter';
import { ChainId, SUPPORTED_CHAINS } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// GET /api/deploy/creation-fee?chain=robinhood
//   -> { amountWei, symbol: 'ETH', decimals: 18 }
//
// The protocol fee BagFactory.createBag charges (native ETH, sent as the
// transaction's value), read live from the factory so the deploy panel can
// show it before the creator signs anything. Display only: the prepared
// transaction carries the fee read at prepare time, and the factory requires
// that exact amount.
// -----------------------------------------------------------------------------

function isChainId(value: string | null): value is ChainId {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

export async function GET(req: NextRequest) {
  const chain = new URL(req.url).searchParams.get('chain');
  if (!isChainId(chain)) return NextResponse.json({ error: 'valid chain is required' }, { status: 400 });
  try {
    const fee = await readFactoryCreationFee(chain);
    return NextResponse.json({ amountWei: fee.amountWei, symbol: 'ETH', decimals: 18 }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Creation fee unavailable.' }, { status: 503 });
  }
}
