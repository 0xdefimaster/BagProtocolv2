# Fork royalty proof plan

Procedures: `docs/LIVE_PROOF_FEES_ROYALTIES.md`. Not executed.

| Test | What it proves | Can run now? | Why |
|---|---|---|---|
| Test 3, royalty at sale | 20% of the fee (`FORK_ROYALTY_SHARE_BPS` = 2000, read on-chain 2026-11-14) goes to the root creator in the sale transaction | **After** the positive-fee proof | needs only RedeemSettlement v2; run it second so a failure is not confused with the plain fee path |
| Test 2, purchase royalty via vault + withdrawal | 1.5% purchase royalty credited in `CreatorRewardsVault` and withdrawn | **BLOCKED** | no `CreatorRewardsVault` (nor `RedeemFeeRouter`) deployment is recorded for V2; the settler approval to the vault is not automated |

## Gates for Test 3

All gates of `POSITIVE_FEE_LIVE_PROOF_PLAN.md`, plus: three distinct wallets (root creator C, forker F, investor I),
F's Bag B with a fee above 0, and the approval record extended with B's id and the expected split
(fee × 20% to C, the rest to F).

## Success criteria

`Settled` + `RoyaltyPaid` for the redemption; `scripts/verify-money-flows.ts --sale=<tx> --creator=F` shows
`ROYALTY_IS_THE_FORK_SHARE` and `ROYALTY_PAID_TO_ROOT_CREATOR_IN_USDG` as PASS; ledger rows match.
