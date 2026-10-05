import { DEPLOYED_CONTRACTS } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// The ONE place that decides how a sale with a performance fee is executed
// (docs/LIFI_COMPOSER_FEE_SETTLEMENT_FEASIBILITY.md §10, routing invariant):
//
//   fee > 0  →  RedeemSettlement (settlement-quote → settlement-attest) ONLY,
//               once it is configured; the older RedeemFeeRouter can then no
//               longer be signed for, and the legacy LI.FI / Composer paths
//               (/execute) always refuse a fee (FEE_ROUTER_REQUIRED).
//   fee = 0  →  the existing free path (/execute), unchanged.
//
// RedeemFeeRouter is only a path while RedeemSettlement is not configured.
// -----------------------------------------------------------------------------

export type FeeRedemptionPath = 'SETTLEMENT' | 'FEE_ROUTER' | 'NONE';

export function feeRedemptionPath(): FeeRedemptionPath {
  if (DEPLOYED_CONTRACTS.redeemSettlement) return 'SETTLEMENT';
  if (DEPLOYED_CONTRACTS.redeemFeeRouter && DEPLOYED_CONTRACTS.creatorRewardsVault) return 'FEE_ROUTER';
  return 'NONE';
}
