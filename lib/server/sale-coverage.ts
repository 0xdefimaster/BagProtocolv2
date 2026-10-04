import { SupabaseClient } from '@supabase/supabase-js';
import type { PublicClient } from 'viem';
import { RedeemIntent } from '@/types/redeem-intent';
import { RedeemHoldingInput } from '@/lib/domain/basket-protocol/redeem/allocation';
import { getInvestorPosition } from '@/lib/server/bag-investor-position-repo';
import { observeUserHoldings, sellableHoldingsForBag } from '@/lib/server/position-valuation';
import { getChainPublicClient } from '@/lib/blockchain/rpc/clients';

// -----------------------------------------------------------------------------
// Accounting V2 / A4 hardening — the ONE pre-sign check every sell path runs
// (legacy LI.FI / Composer: prepareRedeemExecution; RedeemFeeRouter:
// signFeeAttestation). Between quote and signature the wallet can change
// (tokens moved out) and so can the books (another fill settled). Right
// before anything is signed, re-read both at one block and require every leg
// to be covered by what BAG tracks AND what the wallet effectively holds for
// this strategy. Never sell — and never attest a fee on — a balance that is
// no longer there.
// -----------------------------------------------------------------------------

export type SaleCoverage = 'COVERED' | 'NOT_COVERED' | 'BALANCE_UNAVAILABLE';

/** Every leg within tracked AND effective quantities, and the legacy share burn within the share balance. Pure. */
export function saleStillCovered(intent: Pick<RedeemIntent, 'steps' | 'sharesRaw'>, sellable: RedeemHoldingInput[], positionSharesRaw: string): boolean {
  if (BigInt(intent.sharesRaw) > BigInt(positionSharesRaw)) return false;
  const byKey = new Map(sellable.map((h) => [`${h.chain}:${h.address.toLowerCase()}`, h]));
  for (const step of intent.steps) {
    const h = byKey.get(`${step.inputAsset.chain}:${step.inputAsset.address.toLowerCase()}`);
    if (!h) return false;
    const need = BigInt(step.inputAmountRaw);
    if (need > BigInt(h.quantityRaw) || need > BigInt(h.sellableRaw)) return false;
  }
  return true;
}

/** Reads the position and the wallet now and checks the intent against them. Unreadable balances are never assumed. */
export async function checkSaleCoverage(
  admin: SupabaseClient,
  user: { userId: string; walletAddress: string },
  intent: Pick<RedeemIntent, 'bagId' | 'steps' | 'sharesRaw'>,
  client: PublicClient = getChainPublicClient('robinhood')
): Promise<SaleCoverage> {
  const [position, observed] = await Promise.all([getInvestorPosition(admin, user.userId, intent.bagId), observeUserHoldings(admin, client, user)]);
  const sellable = sellableHoldingsForBag(observed, intent.bagId);
  if (!sellable) return 'BALANCE_UNAVAILABLE';
  return saleStillCovered(intent, sellable, position.sharesRaw) ? 'COVERED' : 'NOT_COVERED';
}
