import { isBagChain, type BagChain } from '@/lib/config/chains';
import { PAYMENT_TOKEN_BY_CHAIN } from '@/lib/server/payment-assets';
import { COMPOSER_ELIGIBLE_CHAINS } from '@/lib/blockchain/lifi-composer-adapter';

// -----------------------------------------------------------------------------
// Where a holder can rebalance a position from their wallet (R2/R3: one LI.FI
// Composer transaction, sells → hub stablecoin → buys, verified from the
// receipt). The hub is the chain's settlement/payment stablecoin: USDG on
// Robinhood Chain, Circle USDC on Base.
//
// Listed explicitly rather than "every Composer chain": a chain is added here
// once its rebalance has been run end to end, not because it could compile.
// -----------------------------------------------------------------------------

export const REBALANCE_CHAINS: readonly BagChain[] = ['robinhood', 'base'];

export function rebalanceSupportedOn(chain: string): chain is BagChain {
  return (
    isBagChain(chain) &&
    REBALANCE_CHAINS.includes(chain) &&
    COMPOSER_ELIGIBLE_CHAINS.includes(chain) &&
    PAYMENT_TOKEN_BY_CHAIN[chain] !== undefined
  );
}

/** The stablecoin a rebalance routes through on `chain` (sells land in it, buys are paid from it). */
export function rebalanceHubToken(chain: BagChain): { symbol: string; address: string } {
  const hub = PAYMENT_TOKEN_BY_CHAIN[chain];
  if (!hub) throw new Error(`No rebalance hub token on ${chain}.`);
  return hub;
}
