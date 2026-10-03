// -----------------------------------------------------------------------------
// Phase 22 — Creator Rewards config. Flat, protocol-wide rates rather than
// per-bag configurable fields for the royalty (unlike performanceFeeBps,
// which IS creator-configurable — see types/basket-protocol.ts): keeps the
// "does forking cost the new depositor extra" question simple to reason
// about and audit across the whole product, not per-bag.
// -----------------------------------------------------------------------------

/** Basis points of a deposit's value routed to a forked bag's ROOT creator, credited via a `creator_reward_settlements` row at deposit time (NOT `portfolios.cash_balance` — migration 0018 moved this off the paper-trading ledger onto the single on-chain-bound settlement path CreatorRewardsVault ultimately pays out). 150 bps = 1.5%. */
export const FORK_ROYALTY_BPS = 150;
