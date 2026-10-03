# Creator Rewards — On-Chain Settlement Architecture

Referenced by `supabase/migrations/0014_add_creator_reward_settlements.sql`.
Describes how a creator reward goes from "an off-chain event happened" to
"the creator can withdraw real USDG from `CreatorRewardsVault` on Robinhood
Chain." For the earlier, off-chain-only accounting this replaces, see
`durum-raporu-v2.md`.

## Why this exists

Before this migration, `activities` rows (`FORK_ROYALTY_EARNED` /
`PERFORMANCE_FEE_EARNED`) were the only record of a creator reward — a
database row, never backed by any real token sitting anywhere. This doc
and the `creator_reward_settlements` table it describes exist so that
**a claimable balance in `CreatorRewardsVault.balanceOf` is always backed
by real USDG already in the vault** — never the reverse.

## Chain & token

Single production chain: Robinhood Chain mainnet, chain id `4663`. Single
reward token: USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6
decimals — see `lib/config/robinhood-chain.ts` for the verification notes
and for why decimals is hardcoded there instead of guessed).

## Two settlement paths

### 1. Fork royalty — settled after the fact, by a backend worker

Fork royalty is resolved during the *purchase* flow, which is a
cross-chain LI.FI swap (`lib/blockchain/lifi-purchase-quote.ts`) — the
user's deposit asset and Robinhood Chain are not necessarily the same
chain, so the royalty cannot be settled in the same transaction as the
user's own deposit. Flow:

```
apply_purchase_execution() (unchanged, 0013)
        ↓ writes activities row + credits portfolios.cash_balance (paper)
creator_reward_settlements row inserted, status=EARNED
        ↓ (async, separate process)
lib/server/creator-rewards-settlement.ts: runSettlementBatch()
        ↓ claims EARNED/RETRYABLE rows, converts gross_amount_quote -> raw USDG
        ↓ calls CreatorRewardsVault.settleReward(creator, amountRaw, refId) as a settler
status → SUBMITTED → CONFIRMED (or FAILED/RETRYABLE on error)
```

Not single-signature, not atomic with the user's purchase — documented
as a known, deliberate limitation (cross-chain settlement can't be made
atomic without a bridge, which section 2 of the production brief
explicitly rules out for the production Bag execution path). Idempotent:
`refId` is a deterministic hash of the settlement row's own `id`
(`deterministicRefId()`), so a retried worker run can never double-pay —
enforced twice, once by `creator_reward_settlements` claim-locking, once
independently by `CreatorRewardsVault.refUsed` on-chain.

### 2. Performance fee — settled atomically, by `RedeemFeeRouter`

Redemption happens entirely on Robinhood Chain (the user already holds
the basket assets there), so the fee CAN be enforced at the swap
boundary, in the same transaction and the same signature as the user's
own redeem swap. Flow:

```
User calls RedeemFeeRouter.redeem(...) — ONE signature
        ↓ pulls basket asset, swaps to USDG via allowlisted DEX target
        ↓ verifies backend's EIP-712 fee attestation
        ↓ CreatorRewardsVault.settleReward(creator, feeAmount, redemptionId) — SAME tx
        ↓ pays user the net proceeds — SAME tx
route handler observes the Redeemed event, inserts a
creator_reward_settlements row ALREADY status=CONFIRMED
```

See `contracts/RedeemFeeRouter.sol`'s NatSpec for the full design
rationale (why an EIP-712 attestation rather than a naive frontend-
supplied `feeAmount`, why this doesn't require custody of the user's
whole Bag).

## Status lifecycle

`EARNED → PENDING_SETTLEMENT → SUBMITTED → CONFIRMED`, with `FAILED` /
`RETRYABLE` / `CANCELLED` as exits. See the migration's `check` constraint
for the exact allowed set. `RETRYABLE` vs `FAILED` distinction:
`lib/server/creator-rewards-settlement.ts` treats a timeout/RPC error as
`RETRYABLE`, a `RefAlreadyUsed` revert (worker crashed AFTER the tx
actually landed, retried) as `CONFIRMED` (never re-marked as a failure or
resubmitted), and any other on-chain revert (e.g. insufficient settler
allowance) as `FAILED` (non-retryable — a config problem, not a transient
one).

## Historical / legacy rewards (0013-era, pre-settlement)

Rewards recorded ONLY in `activities` before this migration are **not**
retroactively considered settled or claimable on-chain. No automatic
backfill is performed by this migration or by the settlement worker.
Migrating them requires an explicit, one-time, idempotent process (not
yet built — flagged here rather than silently assumed done):

1. Enumerate historical `FORK_ROYALTY_EARNED` / `PERFORMANCE_FEE_EARNED`
   activity rows not already covered by a `creator_reward_settlements`
   row.
2. For each, create a `creator_reward_settlements` row with
   `source_activity_id` set, status `EARNED`, and a `settlement_ref_id`
   derived the same deterministic way so the vault's own `refUsed`
   protects against a double-migration even if this script is run twice.
3. Confirm the vault will actually hold enough USDG to cover the backfill
   BEFORE running the settlement worker over these rows — the source of
   those funds must be identified and deposited by the settlement wallet
   (via its existing ERC-20 approval) exactly like any other settlement;
   this migration does not manufacture funds, it only unblocks the
   accounting path.

## Historical rewards backfill (done this pass)

`supabase/migrations/0015_backfill_legacy_creator_rewards.sql` implements
the idempotent backfill described above, as two Postgres functions:

- `backfill_legacy_fork_royalty_rewards()` — unambiguous (the activity
  row's own id is `source_activity_id`), auto-invoked once by the
  migration itself.
- `backfill_legacy_performance_fee_rewards()` — correlates each legacy
  `PERFORMANCE_FEE_EARNED` row to its `redeem_intents.id` via the
  companion `REDEEM_EXECUTED` activity row `apply_redeem_execution()`
  always writes in the SAME transaction (same bag, byte-for-byte
  identical `created_at` — Postgres's `now()` is transaction-stable).
  Deliberately NOT auto-invoked — call manually and review its
  `unmatched_count`/`malformed_count` output first.

Both were verified end-to-end against a real local Postgres 16 instance
in this sandbox (not just read for syntax): fixtures covering a clean
fork-royalty row, a correctly-correlated performance-fee row, a
performance-fee row with no companion redeem (correctly left unmatched),
and a malformed row (correctly skipped, never guessed) — all confirmed
idempotent by re-running both functions and observing zero new inserts.

## Reconciliation job (done this pass)

`lib/server/creator-rewards-reconciliation.ts` — `runReconciliation()`,
same dependency-injected shape as the settlement worker. Detects, as a
read-only report (NEVER auto-corrects, per section 34):

- **Case A** `CONFIRMED_BUT_NOT_ONCHAIN` — DB says CONFIRMED, but
  `CreatorRewardsVault.refUsed(refId)` says false.
- **Case B** `ONCHAIN_BUT_NOT_CONFIRMED_IN_DB` — refUsed is true, but the
  DB row isn't CONFIRMED yet (self-heals if the settlement worker is
  re-run, since it treats `RefAlreadyUsed` as confirmation).
- **Case C** `STALE_PENDING` — a row stuck SUBMITTED/PENDING_SETTLEMENT
  past a configurable staleness threshold with nothing on-chain to
  explain it.
- **Case D** `VAULT_UNDERFUNDED` — `totalOutstanding` exceeds the vault's
  actual reward-token balance (should be impossible given
  `settleReward`'s atomic design; checked first, independent of any DB
  row). Covered by `lib/server/__tests__/creator-rewards-reconciliation.test.ts`
  (10 tests).

**Not yet done for either of the above:** the real Supabase-backed
`ReconciliationRepo`/`RewardSettlementRepo` implementations and the real
viem-backed `VaultReadClient`/`VaultChainClient` implementations are still
just interfaces + in-memory test fakes — nothing in `app/api/` or a cron
config actually invokes `runSettlementBatch()` or `runReconciliation()`
against live Supabase/RPC yet. Same for `apply_purchase_execution()`
itself: it still only writes the legacy `activities`/`cash_balance` path
and does not yet insert a `creator_reward_settlements` row for new
(post-0014) fork royalties — only the migration 0015 backfill covers
rows that existed before 0014 shipped.

## What is NOT yet built (honest gap list)

- The migration script in the "Historical / legacy rewards" section above
  — done this pass, see below.
- Reconciliation job (section 34 of the production brief) — done this
  pass, see below.
- Real deployment: `scripts/deploy-creator-rewards.ts` exists and
  typechecks but has never been broadcast — this sandbox has no network
  route to Robinhood Chain's RPC.
- **`[SUPERSEDED — see docs/V11_HARDENING_REPORT.md]`** `ROBINHOOD_UNISWAP_SWAP_TARGET_ADDRESS` — no canonical Uniswap
  deployment address for Robinhood Chain has been independently verified
  yet (see `lib/config/robinhood-chain.ts`'s module doc). `RedeemFeeRouter`
  cannot allowlist a real swap target until this is resolved.
  (Correction, added later: verified in the V11 pass against
  `developers.uniswap.org`'s Robinhood Chain deployments page,
  cross-checked against an independent source. The remaining gap is
  purely that nothing has been deployed/allowlisted on a real chain yet —
  not that the address itself is unknown.)
- The single-chain-only UI/execution cleanup (production brief sections
  36–37: removing Ethereum/Base/Arbitrum/Solana as selectable networks for
  the production Bag flow) has not been touched — this is a large,
  separate refactor across the asset registry, bag creation UI, and
  execution-plan code, not part of this pass.
- **`[SUPERSEDED — see docs/V11_HARDENING_REPORT.md]` `RedeemFeeRouter` is not wired into the actual redeem flow.**
  `lib/server/redeem-execution.ts` still calls the legacy
  `apply_redeem_execution()` paper-ledger RPC exclusively. No EIP-712
  fee-attestation signing endpoint exists, and no client-side hook drives
  `RedeemFeeRouter.redeem()`. The contract that closes the fee-escape gap
  is fully built and tested in isolation but not yet in the critical path.
  **(Correction, added later: this was fixed by the V11 hardening pass —
  `signFeeAttestation()`/`/api/redeem-intent/:id/attest-fee` exist and
  `hooks/use-redeem-execution.ts` now drives `RedeemFeeRouter.redeem()`
  whenever the router is configured. `lib/server/redeem-execution.ts`
  itself is unchanged and intentionally still legacy-only — see V11's own
  architecture diagram, the router path is a parallel client-driven flow,
  not a change to this file. What's still genuinely open, per V11's own
  remaining-blockers list: nothing is deployed to a real chain yet, and
  the redeem-side swap legs have no live slippage protection
  (`minUserProceeds` hardcoded to 0).)**
- No real (Supabase/viem-backed) implementations of the settlement
  worker's or reconciliation job's repo/chain interfaces, and nothing
  triggers either of them on a schedule yet (see above).

## Dashboard claim UI (done this pass)

`hooks/useCreatorRewards.ts` now reads the real on-chain claimable balance
via `lib/blockchain/creator-rewards-vault-client.ts` (`balanceOf`) and
exposes `claim()` (`withdrawAll`), wired into `app/dashboard/profile/page.tsx`'s
"Claimable on-chain (Robinhood Chain)" block. Key invariant carried through
from the vault itself: a read failure or "no wallet connected" state
returns `claimableDisplay = null` ("—" in the UI), never a false `"0"` —
only a genuine `balanceOf() === 0n` displays as `"0"`. Covered by
`hooks/__tests__/useCreatorRewards.test.ts` (8 tests, vault client mocked —
proves the hook's own state machine, not a real chain).
