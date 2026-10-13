// -----------------------------------------------------------------------------
// Phase 22 — Creator Rewards config. Flat, protocol-wide rates rather than
// per-bag configurable fields for the royalty (unlike performanceFeeBps,
// which IS creator-configurable — see types/basket-protocol.ts): keeps the
// "does forking cost the new depositor extra" question simple to reason
// about and audit across the whole product, not per-bag.
// -----------------------------------------------------------------------------

/**
 * Fork royalty: the share of a fork's performance fee paid to the ROOT creator of its lineage, on-chain, in the same
 * transaction as the sale (RedeemSettlement.FORK_ROYALTY_SHARE_BPS, a contract constant; this mirrors it for display).
 * The investor pays nothing extra: the fork's creator receives the rest of the fee. A fork with a 0% fee pays no
 * royalty. Replaces the earlier 1.5%-of-deposit credit, which was recorded but never paid out.
 */
export const FORK_ROYALTY_FEE_SHARE_BPS = 2000;
