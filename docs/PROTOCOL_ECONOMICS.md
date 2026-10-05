# Protocol economics — invariants and design decisions

This document pins down the economic rules the accounting code must obey, and
the design decisions behind them. Each rule names where it is enforced and
which tests prove it. When code and this document disagree, that is a bug.

## 1. Performance fee is immutable after the first external investment

**Rule.** A Bag's performance fee (`recipe.performanceFeeBps`, 0–3000 bps) can
be set and changed by its creator, through new versions, **until the first
external investor** (any user other than the Bag's creator) holds shares.
From that moment the fee is **locked forever** at the rate then in force.
It can go neither up nor down.

**Why.** Redemptions charge the fee on realized profit. Before this rule, the
redemption RPC used the fee of the Bag's *current* version. So a creator could
raise the fee in a later version and apply it retroactively to investors who
bought under a lower one.

**Why not per-lot fee snapshots.** A lot-by-lot model (each deposit remembers
its own fee) would also fix this. But nothing else in the schema is lot-based:
a position is one aggregate row with proportional cost basis. Adding lots
would change cost-basis consumption, fees and settlement all at once.
"Locked after the first external investment" fits the existing model and is
simple to verify.

**Decisions made explicit:**

| Question | Decision |
|---|---|
| Does the creator buying into their own Bag lock the fee? | No. Only a position whose `user_id` differs from `bags.creator_id` and holds shares > 0. |
| Does the lock lift if every external investor redeems? | No. The lock is permanent, so there is no unlock window to game. |
| Fee 0? | Valid. It locks at 0 like any other rate. |
| Forks? | A fork is a new Bag with its own, initially unlocked, lock state. The fork route also resets the fork's fee to 0, so a forker never silently inherits the parent's fee. The parent's lock is unaffected. |
| Creator's own redemption | Never charged (unchanged). |
| Redemption at a loss | Never charged (unchanged). |

**Enforcement** (migration `0033_lock_performance_fee_after_first_external_investment.sql`).
The database is authoritative, so no API, RPC or script can bypass these rules:

- `bags.performance_fee_locked_at` / `performance_fee_bps_locked` are set once,
  by the trigger `trg_lock_performance_fee_on_external_position` on
  `bag_investor_positions`.
- `trg_guard_performance_fee_on_versions` (on `bag_versions`, before insert or
  update):
  - A locked Bag can never gain a version whose fee differs from the lock.
  - A locked Bag's version fee can never be edited.
  - Any fee must be an integer 0..3000.
- `trg_guard_performance_fee_lock_on_bags` (on `bags`, before update):
  - The lock can never be cleared or altered.
  - `current_version_id` can never be pointed at a version with another fee.
- `apply_redeem_execution()` charges the **locked** rate and ignores a
  different caller-supplied rate.
- The router-settled path's fee attestation (`redeem-fee-attestation.ts`)
  also uses the locked rate, because that amount is paid on-chain.
- `createBagVersion()` returns a typed `PERFORMANCE_FEE_LOCKED` error, both as
  a fast path and when losing a race to the database.
- The Create Bag form states the rule. The form and the API share
  `MAX_PERFORMANCE_FEE_BPS`.

**Tests.** `lib/server/__tests__/integration/performance-fee-lock.integration.test.ts`
runs against a real PostgreSQL:

- a fee change is allowed before the lock
- creator-only activity does not lock
- after the lock, both an increase and a decrease are rejected
- every direct-write bypass is rejected
- redemption uses the locked rate
- no fee on a loss, on a 0 rate, or on the creator's own redemption
- fork behavior

**Schema-drift fix found on the way.** `supabase/schema.sql` (fresh installs,
CI) still carried the pre-0018 bodies of `apply_purchase_execution` and
`apply_redeem_execution`. Those credited creator rewards straight to
`portfolios.cash_balance` instead of the `creator_reward_settlements` ledger.
So a fresh install moved money differently from a migrated database.
Migration 0033 (redeem) and 0034 (purchase) re-assert the 0018 bodies, and
`schema.sql` now carries them.

## 3. Share / NAV / cost-basis invariants (audit)

Written before any code was changed. Only clear violations were fixed; no
formula was changed for taste.

### Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Σ `bag_investor_positions.shares_raw` = `bag_share_state.total_shares_raw` for every Bag | Every mint/burn RPC changes both by the same delta. Re-checked after every economics test. |
| I2 | No share balance, total supply, cost basis or holding is ever negative | Underflow guards in both redeem RPCs, plus positive-delta guards |
| I3 | A zero-share position carries zero cost basis | Proportional consumption; a full redemption consumes the whole basis |
| I4 | A failed, expired, cancelled or partially-executed intent never mints or burns shares | `INTENT_NOT_EXECUTABLE` guard in all three accounting RPCs |
| I5 | One intent produces accounting at most once, even under concurrency | Row lock plus `accounting_applied_at`. The intent must exist and belong to the same (user, bag). |
| I6 | Rounding never creates free shares or free NAV | Deposit: `shares = floor(deposit × supply / NAV)`, so `shares × NAV ≤ deposit × supply`. Redeem: value = shares × price floored, in the Bag's favor. |
| I7 | Cost basis is consumed pro rata to shares burned, and the consumed amounts sum back to the original basis | `new_basis = basis × remaining / shares` |
| I8 | No performance fee on a loss, on the creator's own redemption, or at a 0 rate. Otherwise fee = locked bps × realized profit, recorded once. | `apply_redeem_execution` plus the §1 lock |
| I9 | Zero supply is only bootstrapped when NAV is also zero. Positive supply at zero NAV is never priced. | `OrphanedNavError` / `ZeroNavError` |

### Violations found and fixed (migration 0036, `shares.ts`)

- **A** — The accounting RPCs never looked at the intent's status. Now
  `INTENT_NOT_EXECUTABLE` for FAILED / EXPIRED / CANCELLED / PARTIAL_SUCCESS /
  RECONCILIATION_REQUIRED. Accounting runs while the intent is SUBMITTED or
  CONFIRMING, and expiry only happens before execution, so no legitimate
  path is blocked.
- **B** — An unknown intent id was accounted with no idempotency row, so every
  retry minted again. The intent's own user and bag were never compared with
  the caller's. Now `INTENT_NOT_FOUND` / `INTENT_MISMATCH`.
- **C** — The router-settled redeem path had no share or holdings underflow
  guard. Now it has the same guards as the LI.FI path.
- **D** — The router-settled path rounded the consumed basis to 2 decimals
  even on a full redemption, which left residual basis on a 0-share
  position. Fixed.
- **E** — The deposit quote divided by the display price, which is truncated
  downward, so a deposit could mint a few raw units more than it paid for.
  Now the exact ratio is floored once.
- **F** — Zero supply with positive NAV (orphaned holdings from a
  reconciliation) bootstrapped at price 1 and handed the orphaned value to
  the next depositor. Now it fails closed.

Tests: `lib/server/__tests__/integration/protocol-economics.integration.test.ts`
covers all 20 requested scenarios against real PostgreSQL. It checks I1–I3
after every test, and 6 of its tests fail on the pre-0036 SQL. Unit tests for
E and F are in `lib/domain/basket-protocol/shares/__tests__/shares.test.ts`.

### Known economic properties, intentionally NOT changed

- **Shares are minted at the quoted amount, holdings at the received amount.**
  A purchase mints `intent.sharesRaw` (priced at quote time), while the Bag
  receives what the swaps actually returned. Slippage within tolerance
  therefore dilutes existing holders by at most the per-leg slippage floor
  (LI.FI `toAmountMin` / BAG Router `minOutputs`, default 1%). Removing this
  would mean re-pricing shares at execution time: an architecture change,
  not a rounding fix.
  *Since Accounting V2 / A4 (migration 0051, `docs/ACCOUNTING_V2_DESIGN.md` §7):*
  shares are no longer an economic quantity. A depositor's position is valued
  from the holdings recorded for **that depositor** (what their own swaps
  returned) against their wallet balance, and a sale sells a fraction of those
  holdings — so a quote-priced mint no longer moves value between holders.
  The share columns remain for the legacy fee path and are guarded as
  non-authoritative (`lib/server/__tests__/a4-authority-guard.test.ts`).
- **The fee is computed on quoted value.** The redemption fee is charged on
  profit against the quoted redemption value, not on realized swap proceeds.
  The same quote-time model applies. *Still open after A4:* a sale that fills
  below its quote can be charged a fee on profit it did not realize. Planned:
  base the fee on the proceeds actually received (`docs/STATUS.md` §4).
- **Router-path fees are recorded as settled.** The router-settled fee amount
  is attested server-side (creator self-redeem and loss both give 0; §1
  locked rate) and settled on-chain before accounting. The SQL records what
  was settled rather than re-deciding it after the fact.
- **Reconciliation holdings.** `apply_partial_purchase_execution` adds
  verified holdings without minting shares, by design (RECONCILIATION_REQUIRED
  awaits an operator). Invariant I9 stops those holdings from being captured
  by the next depositor of a zero-supply Bag.
