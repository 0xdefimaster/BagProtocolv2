# BAG Protocol — V10 Production Hardening Sprint Report

Method followed as instructed: repository audit first (architecture map,
call graph, invariants, prioritized bugs) → minimal patches → tests → this
report. No unrelated rewrites. No existing API/repository-layer signatures
were changed except where a new interface method was strictly required by
a P0 fix (documented in section 2).

---

## 0. Architecture map / call graph (as audited, before any change)

```
CREATE BAG        app/dashboard/create/page.tsx → POST /api/bags
                   → lib/server/bag-repo.ts (createBag)

PUBLISH/DEPLOY     POST /api/bags/[id]/deploy → lib/server/deploy-bag.ts
                   → resolveAdapter(chain) → EvmAdapter (real RPC) OR
                     MockAdapter (chain not configured)
                   → BagFactory.createBag() on-chain (real chain) or a
                     fabricated tx hash (mock)

INVEST (purchase)  hooks/use-purchase-execution.ts → LI.FI executeRoute()
                   (multi-chain swap, unrelated to Robinhood-chain-only
                   scope — deposit assets can be on any LI.FI-supported
                   chain) → POST /api/purchase-intent/:id/step/:i/report
                   → lib/server/purchase-execution.ts
                   → admin.rpc('apply_purchase_execution')  [SQL, atomic]
                     → bag_holdings / bag_investor_holdings /
                       bag_share_state / bag_investor_positions
                     → IF fork: activities(FORK_ROYALTY_EARNED) +
                       creator_reward_settlements (EARNED)  [0018: NO
                       LONGER touches portfolios.cash_balance]

HOLD / profit      Priced via lib/server/price-provider.ts (real CoinGecko
                   or fail-closed in production if PRICE_PROVIDER=mock)

REDEEM             hooks/use-redeem-execution.ts → LI.FI executeRoute()
                   (STILL — RedeemFeeRouter.sol + the EIP-712 attestation
                   service exist but are NOT called by this hook; see
                   section 9, unchanged blocker from the prior pass)
                   → POST /api/redeem-intent/:id/step/:i/report
                   → lib/server/redeem-execution.ts
                   → admin.rpc('apply_redeem_execution')  [SQL, atomic]
                     → cost-basis reduction, realized-profit calc
                     → IF fee: activities(PERFORMANCE_FEE_EARNED) +
                       creator_reward_settlements (EARNED)  [0018: NEW —
                       previously this credited portfolios.cash_balance
                       ONLY, with no on-chain path at all]

SETTLEMENT WORKER  app/api/cron/settle-creator-rewards (GET, per Vercel's
                   actual cron trigger method — verified prior pass)
                   → lib/server/creator-rewards-settlement.ts
                     runSettlementBatch()
                     1. reconcileStuckSubmissions() [NEW, this pass —
                        section 2]
                     2. claimBatch() [EARNED/RETRYABLE only]
                     3. CreatorRewardsVault.settleReward() on-chain

RECONCILIATION     app/api/cron/reconcile-creator-rewards (GET)
                   → lib/server/creator-rewards-reconciliation.ts
                     runReconciliation() — read-only report, 4 cases

CREATOR CLAIM      app/dashboard/profile/page.tsx → hooks/useCreatorRewards.ts
                   → lib/blockchain/creator-rewards-vault-client.ts
                     (browser-side, real viem, real wallet signature)
                   → CreatorRewardsVault.withdrawAll() directly from the
                     creator's own wallet — no backend involved
```

### Invariants identified and enforced (verified, not assumed)

1. `CreatorRewardsVault.balanceOf(creator)` is the ONLY spendable
   representation of a creator reward. **Was violated for fork royalty
   AND performance fee before this pass — fixed, see section 2.**
2. `creator_reward_settlements.reward_amount_token_raw` is always
   `floor(gross_amount_quote * 10^6)` — verified consistent across 0015
   (legacy backfill), 0017 (fork royalty), 0018 (performance fee), and
   `lib/config/robinhood-chain.ts`'s `quoteDecimalToRewardTokenRaw`.
3. `refUsed(refId)` on the vault is the single point of truth for "was
   this exact reward event ever paid" — both the settlement worker and
   the reconciliation job key off it exclusively, never off DB state
   alone.
4. `purchase_intents.accounting_applied_at` / `redeem_intents.accounting_applied_at`
   gate all accounting side effects (including, as of 0017/0018, the
   `creator_reward_settlements` insert) atomically in the SAME SQL
   transaction — verified this actually prevents double-crediting on a
   direct retried RPC call (section 8, real Postgres test).

---

## 1. ARCHITECTURE DECISION

No architecture change from the prior pass's conclusion
(`docs/FINAL_PRODUCTION_AUDIT.md`): Robinhood Chain (4663) is the single
production settlement chain; USDG is the single reward token;
`CreatorRewardsVault` is the sole on-chain source of truth for claimable
creator balances. This sprint's decision, per the brief's own explicit
allowance, is:

- **Fork royalty**: asynchronous settlement via the existing cron worker
  remains correct (purchase happens via a cross-chain LI.FI swap — cannot
  be made atomic with a same-chain vault call without a bridge, which is
  out of scope). What changed: the royalty is no longer ALSO a spendable
  `cash_balance` credit — the Vault is now the only place it's real money.
- **Performance fee**: promoted from "cash_balance only, no on-chain path
  at all" to the SAME settlement-worker path fork royalty already used
  (`creator_reward_settlements` → cron → `settleReward`). This is
  explicitly the brief's allowed "settlement wallet as interim
  fallback/async mechanism" — full atomic in-transaction settlement via
  `RedeemFeeRouter` remains blocked (section 9), so this is the correct,
  documented interim source of truth, not a compromise dressed up as done.

---

## 2. CHANGED FILES

| File | Why |
|---|---|
| `lib/server/deploy-bag.ts` | **New finding, this pass**: `resolveAdapter()` silently fell back to `mockAdapter` (fabricated tx hash, fake "successful" deployment) whenever a chain's RPC/factory wasn't configured — with NO production guard, unlike `price-provider.ts`'s equivalent. Added `MockAdapterInProductionError`, fails closed when `NODE_ENV=production`. |
| `lib/server/__tests__/deploy-bag.test.ts` | New test for the guard above. |
| `supabase/migrations/0018_single_source_of_truth_creator_rewards.sql` | **P0 fix**: removes `portfolios.cash_balance` mutation for fork royalty (`apply_purchase_execution`); adds the SAME atomic `creator_reward_settlements` insert performance fee never had (`apply_redeem_execution`), using `p_intent_id` directly as `source_redeem_intent_id` (no correlation trick needed, unlike 0015's legacy backfill). Fixes a latent `revoke`-ambiguity bug in 0016/0017's own scripts (explicit signatures now). |
| `lib/server/creator-rewards-settlement.ts` | **P0 fix**: added `reconcileStuckSubmissions()` (the crash-recovery algorithm) and wired it to run first, every `runSettlementBatch()` call. Extended `RewardSettlementRepo`/`VaultChainClient` interfaces (`getStuckSubmitted`, `markSubmittedRetryable`, `isRefUsed`, `updatedAtMs`). |
| `lib/server/creator-rewards-settlement-repo.ts` | Real Supabase implementations of the two new repo methods. |
| `lib/blockchain/creator-rewards-vault-chain-client.ts` | Added `isRefUsed` to `createVaultChainClient()` (previously only on the separate read-only reconciliation client) — needed by the settlement worker's own crash-recovery pass now. |
| `lib/server/__tests__/creator-rewards-settlement.test.ts` | Rewritten for the extended interfaces; added the full A/B/C/D/E crash-recovery test matrix (19 tests total, up from 9). |

**Not changed, verified correct/pre-existing from the prior pass and left
alone per "don't rewrite working systems":** `CreatorRewardsVault.sol`,
`RedeemFeeRouter.sol`, `lib/server/creator-rewards-reconciliation.ts`,
`lib/server/redeem-fee-attestation.ts`, `lib/domain/basket-protocol/redeem/performance-fee-preview.ts`
(already the correct single-source-of-truth bigint/cents fee calculator
the brief's "tek kaynak" section asked for), `hardhat.config.ts`'s
`robinhoodFork` network, the 19.X-B spike harness.

---

## 3. DATABASE CHANGES

One new migration: `0018_single_source_of_truth_creator_rewards.sql`.
7th/2nd revision respectively of `apply_purchase_execution()` /
`apply_redeem_execution()`. No schema/table changes — `creator_reward_settlements`
(0014) already had every column needed; this migration only changes
function BODIES. **Verified against a real local Postgres 16** (not read
for syntax only):

- Fresh DB built from `supabase/schema.sql` + all 18 migrations in
  order, zero unexpected errors.
- Fork royalty purchase: `cash_balance` unchanged (0.00 before and
  after), `creator_reward_settlements` gets exactly one `FORK_ROYALTY`
  row for 15.00 (1000 × 150bps).
- Redemption with profit: cost-basis math verified exact (400/1000 shares
  redeemed → consumed cost basis 400.00, profit 50.00, 10% fee = 5.00),
  `cash_balance` still 0.00, `creator_reward_settlements` gets exactly one
  `PERFORMANCE_FEE` row correctly linked via `source_redeem_intent_id`.
- Retried `apply_redeem_execution()` call (same intent id): `alreadyApplied: true`,
  row count stays at 2 (not 3) — idempotent, confirmed directly.

---

## 4. SMART CONTRACT CHANGES

**None this pass.** `CreatorRewardsVault.sol` and `RedeemFeeRouter.sol`
were audited (re-read in full) and found consistent with the fixes above
— no ABI changes were needed to support them, since both the accounting
fix (SQL-only) and the crash-recovery fix (worker-only, using the vault's
existing `refUsed` view function) needed no new on-chain surface. 40/40
Hardhat tests still pass unchanged.

---

## 5. EXECUTION FLOW (updated, real)

See section 0's call graph. The one flow-level change this pass made:
performance fee now reaches `creator_reward_settlements` in the SAME
atomic step as fork royalty always did — before this pass, a creator
earning a performance fee had literally no code path to ever see it in
`CreatorRewardsVault.balanceOf`, only in their own spendable paper
`cash_balance`.

---

## 6. ACCOUNTING MODEL — source of truth, explicit

| Data | Source of truth | Notes |
|---|---|---|
| Creator's **claimable** reward balance | `CreatorRewardsVault.balanceOf(creatorWallet)` on-chain | The ONLY place. Verified: neither `apply_purchase_execution` nor `apply_redeem_execution` touch `portfolios.cash_balance` for creator rewards as of 0018. |
| Creator's reward **history/audit** | `creator_reward_settlements` (Supabase) | State machine: EARNED → PENDING_SETTLEMENT → SUBMITTED → CONFIRMED, or FAILED/RETRYABLE/CANCELLED. Never itself spendable. |
| Investor's own **cost basis / position** | `bag_investor_positions` (Supabase) | Unrelated to creator rewards; unchanged. |
| Investor's own **spendable proceeds** | Still the legacy `portfolios.cash_balance` paper model for the LI.FI-executed redeem path (unchanged — this pass's scope was creator rewards specifically, not the investor-proceeds model, which was not reported broken). |

---

## 7. SECURITY

| Severity | Finding | Status |
|---|---|---|
| **HIGH** | `deploy-bag.ts` silently fabricates a fake successful deployment (fake tx hash, `mock-factory` address) if a chain's RPC isn't configured, with no production guard | **Fixed this pass** — fails closed in production, verified by test |
| **HIGH** (carried from prior pass) | Two Vercel Cron routes only accepted POST; Vercel triggers with GET | Already fixed in the prior pass, re-verified still correct |
| **HIGH** (carried, this pass's main P0) | Creator rewards double-representable (`cash_balance` + Vault) | **Fixed this pass**, verified against real Postgres |
| **MEDIUM** | Settlement worker had no recovery path for a row stuck SUBMITTED after a crash between `markSubmitted`/`markConfirmed` — silent, permanent, no operator alert | **Fixed this pass** (`reconcileStuckSubmissions`), full A–E case coverage tested |
| **MEDIUM** | `RedeemFeeRouter`/EIP-712 attestation exist but are not in the live redemption path — normal `use-redeem-execution.ts` still bypasses fee enforcement entirely | **NOT fixed** — see section 9, real infra blocker (unverified swap-target address), unchanged from the prior audit |
| **LOW** (demo-vs-real audit, new finding) | `app/dashboard/profile/page.tsx` blends real wallet/financial data with `mockUser`/`mockBags` fake social metrics (followers, reputation, forks count) on the same rendered page | Not fixed — cosmetic/social, not financial, out of this sprint's P0/P1 scope, but flagged as requested by the brief's "demo vs real" audit section |
| **LOW** (carried) | `creator_reward_settlements`'s RLS policy references `auth.uid()`, which this app's custom-JWT model never populates — dead policy, not currently exploitable (browser never talks to Supabase directly) | Not fixed — documentation-only issue, noted in prior audit |

No new client-trust violations found in the routes/RPCs re-audited this
pass (purchase, redeem, deploy, creator rewards): price, fee amount,
creator id, wallet address, and settlement status are all server/DB
derived in every path checked.

---

## 8. TEST RESULTS (exact, this session)

```
npx hardhat test          → 40 passing (40 nodejs)
npx vitest run             → 46 test files, 486 tests passed, 0 failed, 0 skipped
npx tsc --noEmit           → clean (only scripts/spike/deploy-19x-a.ts's
                             pre-existing, unrelated spike-script errors —
                             same as every prior pass, not touched)
npx eslint .               → 0 errors, 6 warnings (all `<img>` vs
                             `next/image` perf suggestions, unrelated to
                             this sprint)
npm run build              → FAILS — next/font/google cannot reach
                             fonts.googleapis.com (this sandbox's network
                             egress allowlist does not include it; same
                             failure, same root cause, verified again this
                             session). NOT an application defect — tsc's
                             clean result covers the same type-level
                             surface next build would hit first.
```

Plus, this session specifically, against a real local Postgres 16
(not simulated): migration chain 0002→0018 applies cleanly; fork-royalty
and performance-fee accounting verified correct and idempotent with real
fixture data (section 3).

Net new tests this pass: 7 (deploy-bag production guard: 1;
settlement crash-recovery: 10 new + 9 existing rewritten = worker file's
suite grew from 9 to 19).

---

## 9. REMAINING BLOCKERS

Unchanged from the prior pass's audit — re-verified, not newly
discovered, and not fixable without external resources this sandbox
lacks:

1. **`RedeemFeeRouter` still not wired into the live redeem UX.**
   `hooks/use-redeem-execution.ts` still drives every redemption through
   LI.FI's `executeRoute()`, never through `RedeemFeeRouter.redeem()`.
   Root cause unchanged: the router takes a caller-supplied `swapTarget` +
   raw `swapCallData` — building that client-side requires either a
   Uniswap SDK integration or a swap-routing API this codebase has none
   of, AND depends on a swap-target address that has never been
   independently verified (below). Wiring this without resolving both
   would mean either inventing an address or shipping dead/untestable code.
2. **`ROBINHOOD_UNISWAP_SWAP_TARGET_ADDRESS` still unverified.**
   Robinhood's own protocol-contracts page lists Permit2 but no canonical
   Uniswap router/factory. `UNISWAP_ROUTER_ADDRESS = null` in
   `lib/config/robinhood-chain.ts`, fails closed everywhere it's needed —
   verified still true.
3. **No real deployment has ever been broadcast.** `CREATOR_REWARDS_VAULT_ADDRESS`
   / `REDEEM_FEE_ROUTER_ADDRESS` remain unset; this sandbox has no network
   route to `rpc.mainnet.chain.robinhood.com` (confirmed via direct curl,
   403, prior pass and re-confirmed this session for the 19.X-B spike).
4. **Multi-asset redemption is not supported by `RedeemFeeRouter`/the
   attestation service** — `signFeeAttestation()` fails closed with
   `MultiAssetRedemptionNotSupportedError` rather than attesting a partial
   fee. The brief's P0 "multi-asset redemption" ask (N input assets → 1
   output, atomic fee) was **NOT implemented this pass** — it depends on
   #1/#2 being resolved first (there is no live single-asset path to
   extend yet), and building a new multi-leg allowlisted-router
   abstraction on top of an unverified swap target would be exactly the
   "fake it to look done" outcome this brief explicitly prohibits. This is
   the single largest unimplemented P0 item from the brief — stated
   plainly, not minimized.
5. **`npm run build` cannot be completed in this sandbox** (Google Fonts
   network access) — confirmed, not a code defect.
6. Cosmetic demo data (`mockUser`/`mockBags` social metrics on the profile
   page) — real but low-severity, not addressed this pass (out of P0/P1
   accounting/settlement scope).

---

## 10. PRODUCTION READINESS

> **NOT READY**

Reasons, stated exactly as the brief requires (not "contract exists" /
"endpoint exists" reasoning):

1. **Performance-fee enforcement is NOT CONNECTED to the live redemption
   path.** `RedeemFeeRouter.sol` and the EIP-712 attestation service are
   real, tested in isolation, and correct — but `use-redeem-execution.ts`
   never calls either. A real user redeeming today goes through LI.FI
   directly; the fee is calculated and recorded (as of this pass, into a
   real settlement pipeline) but is **not enforced at the point of
   execution** — collection currently depends on the redeem RPC's
   bookkeeping being trusted, not on an on-chain transfer the user cannot
   route around by construction. This is exactly the gap the brief's own
   P0 "GERÇEK REDEEM FEE ENFORCEMENT" section describes and it remains
   open.
2. **Multi-asset redemption fee enforcement does not exist at all** (P0
   item, not implemented — section 9.4).
3. **Nothing has been deployed.** Every on-chain address the settlement
   worker, reconciliation job, and (once wired) the redeem router need is
   unset. The entire creator-reward-settlement pipeline this pass hardened
   has been verified in isolation (real Postgres, real Hardhat EVM) but
   never against a real deployed vault on real Robinhood Chain.

**What genuinely improved this pass and is real, verified progress, not
just documentation:** the accounting model is now provably single-source
(no double-representation of creator money — the exact P0 #1 ask, fixed
and tested against a real database), and the settlement worker can no
longer leave a reward permanently stuck if it crashes mid-transaction
(the exact P0 crash-recovery ask, fixed and tested with full state-machine
coverage). Both were real, previously-unfixed bugs, not busywork.
