# Performance fee economics — design

Status: **DESIGN APPROVED — decisions F1–F7 locked (2026-10-05, §8). B0
implemented (server only; §9 step 1), not yet validated live. B not started.**
Implementation follows §9: B0 first, then a separate, audited contract PR for
B. Never both in one PR.

The question this document answers:

```
quoted redemption value  →  actual on-chain proceeds  →  performance fee base
```

A sale's actual proceeds are not known before the swap runs. So the real
question is **where in the execution, and inside which trust boundary, the fee
is computed** — and what it is computed on.

## 1. Terms (never interchangeable)

| Term | Meaning | Example: basis $100, sold for $120 |
|---|---|---|
| **Gross proceeds** | Output token that actually reached the wallet/router from the swaps | $120 |
| **Consumed cost basis** | The cost basis of exactly the quantities sold | $100 |
| **Realized gain** | Gross proceeds − consumed cost basis (can be negative) | $20 |
| **Fee base** | The part of the realized gain the fee applies to (≥ 0) | $20 (or less, §5.4) |
| **Performance fee** | Fee base × the Bag's locked fee rate | $2 at 10% |
| **User receives** | Gross proceeds − performance fee | $118 |

A performance fee applies to **gain**, never to gross proceeds: in the example
the fee base is $20, not $120.

Three more terms, because the router's floor is easy to misread:

| Term | Definition | Where it lives |
|---|---|---|
| **grossMinimumProceeds** | Σ per-leg minimum outputs (each leg's swap quote × (1 − slippage)); the least the swaps may return without reverting | Computed by the server from the leg quotes |
| **minUserProceeds** | `grossMinimumProceeds − fee` | Signed in the attestation |
| **Contract invariant** | `swapOutput ≥ minUserProceeds + fee` (= `swapOutput ≥ grossMinimumProceeds`) | `RedeemFeeRouter.redeem()` |

"Minimum proceeds" in this document always means **grossMinimumProceeds**;
the user's own floor is **minUserProceeds**. Example: grossMinimumProceeds
118.80 and a fee of 1.88 sign `minUserProceeds = 116.92`; the router then
requires `swapOutput ≥ 116.92 + 1.88 = 118.80`.

## 2. What the code does today

Source: `lib/server/redeem-fee-attestation.ts`, `previewPerformanceFee`
(`lib/domain/basket-protocol/redeem/performance-fee-preview.ts`),
`contracts/RedeemFeeRouter.sol`, `contracts/CreatorRewardsVault.sol`.

| Item | Today |
|---|---|
| Which sales pay a fee | Bags with a performance fee > 0, sold by a non-creator. These **must** use `RedeemFeeRouter` (`FEE_ROUTER_REQUIRED`); fee-0 Bags use LI.FI Composer and are not affected by this document |
| "Quote" used | `redeemValueQuote` = the **NAV** value of the shares burned (`getRedeemQuote`, display prices) — not even the swap quote |
| Consumed cost basis | `costBasis × sharesBurned / positionShares` — share-proportional (shares are non-authoritative since A4) |
| Fee formula | `fee = rate × max(0, redeemValueQuote − consumedCostBasis)`, no loss carry-forward |
| Where it is computed | BAG's server, **before** the swap; the amount is fixed in an EIP-712 attestation signed by `feeAttestor` (a server key) |
| What the contract does | Pulls the legs, swaps them through allowlisted targets into USDG, measures `swapOutput` from its own balance, requires `swapOutput ≥ minUserProceeds + fee`, sends `fee` to `CreatorRewardsVault` for the creator and `swapOutput − fee` to the user — one atomic transaction |
| Partial execution | Impossible on this path: any failing leg reverts the whole sale |
| Recipients | Creator: 100% of the fee (claimable from the vault). Protocol: **0**. (Superseded for forks: a fork's root creator gets 20% of the fee, paid by RedeemSettlement v2 in the same transaction — `docs/FORK_ROYALTY_ONCHAIN.md`.) |
| Accounting (A3) | Already computes the *fee base the ledger says is right* — realized gain from verified proceeds above the position's high-water mark (`feeBaseQuote`) — but it is **not charged**: the charged fee is the attested one (D4) |

**The defect.** The fee is fixed from a NAV valuation before the swap. Slippage
(and any NAV-vs-market gap) is borne entirely by the user, and a sale can be
charged a fee on gain it never realized — including a sale that realized a
loss (§4, case 2b).

## 3. The four models

| | A. Post-settlement | B. Atomic fee sweep | C. Realized-gain semantics | D. High-water mark |
|---|---|---|---|---|
| What it is | A **mechanism**: fee computed after the receipt, collected later | A **mechanism**: router measures actual output, splits fee/remainder in the same tx | A **semantic**: fee base = realized gain from actual proceeds; the quote never enters | A **semantic** refinement: fee only on cumulative realized gain above its previous peak (loss carry-forward) |
| When the fee is known | After settlement | During the swap transaction | — (combines with A or B) | — (combines with A or B) |
| Who computes it | BAG server from the verified receipt | The contract, from its measured balance + attested inputs | — | Needs per-position cumulative realized P&L (A3 already keeps it) |
| Trust boundary | Server + ledger | Contract arithmetic; server only attests inputs (basis, loss carry, rate) | — | Same as its mechanism; the loss carry is one more attested input |
| Enforceable without custody? | **No.** Proceeds are already in the user's wallet; a later fee is a debt the user may never pay. Collecting it needs custody or a lock — outside the A model | **Yes** — proceeds pass through the router for one transaction, which is how fees are enforced today | — | — |
| Contract change | None | **Yes** (router computes the fee) — audited contract PR (D4) | — | Included in B's inputs |

So A and B are *how* the fee is collected; C and D are *what* it is computed
on. The choice is a pair: one mechanism + one semantic.

- **A is rejected as the enforcement mechanism** (non-custodial). It remains
  what A3 already does for *accounting*: the ledger computes the correct fee
  base after settlement.
- **B is the target mechanism**, with **C + D** as its semantics.
- **B0 — interim conservative approximation (floor-based fee), no contract
  change.** Keep today's router; change only what the server attests. B0 does
  **not** charge on the actual result — it cannot know it — but on the
  **minimum realizable gain**:

  ```
  B0:  fee = rate × max(0, grossMinimumProceeds − consumedBasis − lossCarry)
  B:   fee = rate × max(0, actualGrossProceeds  − consumedBasis − lossCarry)
  ```

  Since `actualGrossProceeds ≥ grossMinimumProceeds` (the router reverts
  otherwise), **charged fee ≤ fee on the actual result** always holds: the user
  is never charged on gain they did not realize. The cost is on the creator's
  side: up to `rate × (actual − grossMinimum)` less than the exact fee (≤ rate ×
  slippage). B0 is an approximation of the target semantics, not their
  implementation; only B charges on the actual result.

## 4. The three cases, with numbers

Common setup: one investor (not the creator), cost basis **$100**, sells 100%;
locked fee rate **10%**; slippage **1%** (grossMinimumProceeds = 99% of the swap
quote; the router reverts below it); protocol share **0** (today's value, §6).
Money in USDG; amounts shown to the cent for readability (the canonical
precision is §5.7).

### Case 1 — actual proceeds above the quote

NAV value $120.00 · swap quote $120.00 · guaranteed minimum $118.80 · **actual $122.00** · realized gain $22.00

| | Today (NAV quote) | B0 (floor-based, no contract change) | Target (B + C) |
|---|---|---|---|
| grossMinimumProceeds | 118.80 | 118.80 | 118.80 |
| minUserProceeds (signed) | 116.80 | 116.92 | — (fee computed on-chain; router checks `swapOutput ≥ 118.80`) |
| Gross proceeds | 122.00 | 122.00 | 122.00 |
| Fee base | 20.00 (from the quote) | 18.80 | 22.00 |
| Performance fee | 2.00 | 1.88 | 2.20 |
| User receives | 120.00 | 120.12 | 119.80 |
| Creator receives | 2.00 | 1.88 | 2.20 |
| Protocol receives | 0 | 0 | 0 |

### Case 2 — actual proceeds below the quote (still a gain)

NAV value $120.00 · swap quote $120.00 · minimum $118.80 · **actual $119.00** · realized gain $19.00

| | Today | B0 | Target |
|---|---|---|---|
| grossMinimumProceeds | 118.80 | 118.80 | 118.80 |
| minUserProceeds (signed) | 116.80 | 116.92 | — |
| Gross proceeds | 119.00 | 119.00 | 119.00 |
| Fee base | 20.00 | 18.80 | 19.00 |
| Performance fee | 2.00 (overcharge 0.10) | 1.88 | 1.90 |
| User receives | 117.00 | 117.12 | 117.10 |
| Creator receives | 2.00 | 1.88 | 1.90 |
| Protocol receives | 0 | 0 | 0 |

### Case 2b — the quote shows a gain, the sale realizes a loss

NAV value $101.00 · swap quote $100.50 · grossMinimumProceeds $99.495 · **actual $99.60** · realized gain **−$0.40**

| | Today | B0 | Target |
|---|---|---|---|
| grossMinimumProceeds | 99.495 | 99.495 | 99.495 |
| minUserProceeds (signed) | 99.395 | 99.495 | — |
| Gross proceeds | 99.60 | 99.60 | 99.60 |
| Fee base | 1.00 (from the quote) | 0 (floor < basis) | 0 (loss) |
| Performance fee | **0.10 — charged on a loss** | 0 | 0 |
| User receives | 99.50 | 99.60 | 99.60 |
| Creator receives | 0.10 | 0 | 0 |
| Protocol receives | 0 | 0 | 0 |

This is the case that makes "quote = fee base" wrong, not just imprecise.

### Case 3 — execution partially succeeds

**Today, on the fee path:** impossible. One transaction; a failing leg reverts
everything. Nothing is sold, no fee, the user keeps every token and pays only
gas. Recorded as FAILED; no ledger events.

**If sales ever run as one transaction per asset with a fee** (not built; listed
so the semantics are fixed in advance): four holdings with basis $25 each;
three legs settle for $30, $31 and $24 ($85), the fourth fails.

| | Rule |
|---|---|
| Gross proceeds | 85.00 (settled legs only) |
| Consumed cost basis | 75.00 (only the three sold holdings) |
| Fee base | **net** realized gain of the settled legs: 85 − 75 = 10.00 (the −1 leg offsets the winners) |
| Performance fee | 1.00 |
| User receives | 84.00, and keeps the unsold holding with its $25 basis |
| Creator receives | 1.00 |
| Protocol receives | 0 |

Rejected alternative: charging winning legs only ((5 + 6) × 10% = 1.10) — it
taxes gross wins while ignoring losses in the same sale.

## 5. Semantics to lock

### 5.1 Fee base from proceeds, never from a quote (C)
`feeBase = max(0, grossProceeds − consumedCostBasis − lossCarry)`. Quotes and
NAV are used only to set slippage floors and to show an *estimate* in the
preview (labelled as such).

### 5.2 Consumed cost basis from holdings, not shares
Use the A3 ledger: Σ over sold assets of (average cost per unit × quantity
sold). This replaces `costBasis × sharesBurned / positionShares`. For a
pro-rata sale with no drift the two agree; after an external outflow they do
not, and only the holdings-based figure is right (A4).

### 5.3 Netting inside one sale
The fee base is computed on the sale as a whole (net of losing legs), never
per leg.

### 5.4 Loss carry-forward (D)
Per position (user × Bag): cumulative realized P&L and its high-water mark,
recomputed from the ledger by the A3 engine (`computePositionPnl` →
`realizedHighWaterMarkQuote`, `feeBaseQuote`; not a stored column, so it is
rebuildable from events like every other projection). The fee applies only to the
part of a sale's gain that lifts cumulative realized P&L above the mark.

Example — deposit $100, sell all for $90 (realized −10, fee 0, mark stays 0);
deposit $100 again, sell for $110 (sale gain +10):

| | Per-sale (C only) | With high-water mark (C + D) |
|---|---|---|
| Cumulative realized after sale 2 | 0 | 0 |
| Fee base of sale 2 | 10.00 | **0** (recovers the earlier loss) |
| Fee | 1.00 | 0 |

A later sale with +5 → cumulative 5, above the mark by 5 → fee 0.50; the mark
becomes 5.

The mark is over **realized** P&L, not over NAV: an unrealized peak
($100 → $130 → $110 without selling) creates no fee and no mark. Selling at
$130 realizes that gain; selling later at $110 realizes the smaller gain then.
External outflows realize nothing (A3) and never move the mark.

### 5.5 Unchanged rules
Creator selling their own Bag: no fee. Fee rate: the locked rate (0033). Fees
apply only to exits executed through BAG; tokens sold elsewhere pay nothing
(non-custodial, documented in ACCOUNTING_V2_DESIGN §3.3).

### 5.6 Design constraint — which position state an attestation is bound to
The fee is attested from the position at time T0 (basis, loss carry) and
executed at T1. Today: one active redemption per user and Bag
(`REDEEM_IN_PROGRESS`), a 5-minute attestation lifetime, a single-use
`redemptionId`, and `apply_redeem_execution` re-checks under a row lock. Not
covered: a **purchase** into the same Bag between T0 and T1 changes the
average cost of what is sold, so the attested basis and the basis the ledger
applies can differ. The contract cannot see the database either way.

- **B0 (as implemented, `lib/server/fee-redemption-lock.ts`):** a two-way lock
  instead of a persisted sequence (no migration): the server refuses to attest
  while a purchase of the same position is in flight (`PositionBusyError`),
  and refuses a purchase — at creation and again at execution — while a
  fee-paying sale of it is open (`REDEEM_IN_PROGRESS`). It is race-safe
  because each side **writes before it reads**: the sale intent exists before
  its fee is attested, and a purchase intent is inserted, then checked, and
  cancelled if a fee sale is open — so the later read always sees the earlier
  write and at least one side refuses. This needs each write to be
  **committed** before the other side reads: in production every supabase-js
  call is its own PostgREST request, run in its own transaction and committed
  before it returns, and the check is a separate, later request (kept so by
  `fee-lock-write-then-check-guard.test.ts`; the integration test asserts each
  write is visible from a fresh session before the read, and shows that an
  uncommitted write would be missed). Tested with parallel races in both
  orders on real PostgreSQL (`fee-redemption-lock.integration.test.ts`); the
  first, check-then-write version let both proceed in 11 of 120 races. A quote that expired
  unsubmitted no longer counts; a submitted transaction always does. The
  attestation's deadline never exceeds the sale intent's expiry, so it cannot
  execute after the lock is released (an expired intent gets no attestation).
  With both
  directions closed, no fill can change the attested basis between T0 and T1
  (an external outflow does not change the average cost per unit; the
  pre-sign coverage check handles the quantity). The charged fee is recorded
  verbatim from the router's `Redeemed` event; the A3 fee base is recomputed
  from the ledger next to it, so any difference stays visible.
- **B (contract PR input):** the signed struct carries a state commitment —
  at least a monotonic per-position nonce/ledger sequence, ideally a
  `positionStateHash` over (basis, loss carry, holdings). The contract keeps a
  per-(user, Bag) nonce and accepts an attestation only for the current one,
  then increments it, so two attestations for the same position state can
  never both execute.

### 5.6a Design constraint — price quality is not the minimum output
A minimum output protects against the price moving *after* the quote; it says
nothing about whether the quote was a fair price. The first live check
(2026-10-05) found stock tokens whose only quoting Uniswap v3 pool was
near-empty (AAOI: $25 of stock → $0.18). The attestation took the first tier
that answered and set the minimum at 99% of that quote, so such a sale would
have "succeeded" at a ~99% loss.

Rule (implemented, `redeem-quote-quality.ts`, used by `signFeeAttestation` and
the read-only checker alike): for every swap leg, quote **every** fee tier and
take the **best**; compare it with the leg's value at BAG's verified price (the
NAV price provider); refuse the attestation if the best quote is more than
`FEE_REDEEM_MAX_PRICE_DEVIATION_BPS` (500 = 5%, the protocol default of the
policy's `maxPriceImpactBps`) below that value. No verified price — e.g. a
Stock Token outside market hours — means no attestation. This applies to every
router sale, fee-paying or not. Making the deviation a per-strategy policy
parameter is a later step.

### 5.7 Design constraint — one canonical rounding rule
Today the fee is rounded **to the cent, half away from zero** in TypeScript
(`previewPerformanceFee`) and SQL (`round(…, 2)`), then converted to USDG raw
units (6 decimals) by truncation. Half-away-from-zero can round the fee **up**
(against the user) by up to half a cent, and cents are coarser than the token.

Rule for B0 and later: the fee is computed **in USDG raw units (6 decimals)**
and rounded **down** (floor) — `fee = floor(feeBaseRaw × rateBps / 10000)`.
TypeScript, SQL and the eventual Solidity use this same integer formula; the
ledger records the charged raw amount verbatim and never re-rounds it.
Display may round for readability only. Parity is tested (the same fixtures
through TypeScript and SQL, and later Solidity).

## 6. Recipients

| | Today | Proposed |
|---|---|---|
| Creator | 100% of the performance fee, via `CreatorRewardsVault` (claim) | Unchanged |
| Protocol | 0 | Unchanged here. A protocol share is a separate business decision; if taken it is one more split in the same atomic step and must be visible in the preview |
| Fork root creator | Purchase-time fork royalty (1.5%), separate | 20% of the fork's fee, at sale, on-chain (`docs/FORK_ROYALTY_ONCHAIN.md`); no purchase-time royalty |

## 7. Trust boundaries

What moves on-chain at each stage:

```
Today   server computes the fee (from NAV)                      → contract checks it is covered
B0      server computes the fee conservatively (from the floor) → contract checks it is covered
B       contract computes the arithmetic; server attests economic inputs (basis, loss carry, rate)
B+      locked rate on-chain + position state commitment (§5.6); server attests only what the chain cannot know
```

B is **not** trustless: the contract computes, but on attested inputs. The
long-term direction is strategy → locked fee rate on-chain → position /
accounting commitment → user intent → router → actual output → contract
computes the fee.

| Step | Today | B0 | Target B (+ C + D) |
|---|---|---|---|
| Fee amount | Server-computed and attested from NAV | Server-computed and attested from the guaranteed minimum | **Contract-computed** from the measured output |
| What the server still attests | Fee, minimum proceeds, exact legs | Same | Consumed basis, loss carry, rate, exact legs, minimum proceeds |
| Worst case if `feeAttestor` is stolen | Any fee up to the output (user sees it only in the preview) | Same | Inflated basis/loss carry can only **lower** the fee; an inflated rate is capped by a user-visible maximum in the signed parameters — and ideally by the rate stored on-chain (open item) |
| User's guarantee | `swapOutput ≥ minUserProceeds + fee` | Same, and fee ≤ fee on the floor | Fee ≤ rate × max(0, actual − basis − carry), checked on-chain |

Target B also requires the proceeds to pass through BAG's router, so a fee Bag
cannot sell through LI.FI Composer unless Composer can deliver its output to
the router (not verified).

## 8. Decisions (locked 2026-10-05)

| # | Decision | Outcome |
|---|---|---|
| F1 | Fee base = realized gain from actual proceeds (C); quotes never enter | **Approved** (B0 approximates it from the floor, §3) |
| F2 | Consumed basis = quantity sold × average cost per asset (A3), not shares | **Approved** |
| F3 | Net across legs within a sale | **Approved** |
| F4 | Loss carry-forward / realized high-water mark (D), from the first implementation | **Approved** |
| F5 | Mechanism: B0 now (server only), B later (audited contract PR, D4) — separate PRs | **Approved** |
| F6 | Protocol share of the performance fee | **0 for now**; separate decision |
| F7 | Post-settlement collection (A) as enforcement | **Rejected**; kept as accounting (A3) |

## 9. Implementation plan (after the decisions)

1. **PR: B0 + F1–F4 (server only; no contract, no change to the fee-0 path).**
   *Implemented:* `performance-fee-b0.ts` (pure), `redeem-fee-attestation.ts`,
   `fee-redemption-lock.ts`, the preview's fee estimate; tests include the
   real RedeemFeeRouter on Hardhat. Live validation pending (needs a
   non-creator wallet selling a fee-paying Bag through a deployed router).
   Attestation computes the fee from grossMinimumProceeds and the
   holdings-based basis net of loss carry, in raw USDG with floor rounding
   (§5.7), and signs `minUserProceeds = grossMinimumProceeds − fee`. It binds
   the position's ledger sequence and refuses while another intent for the
   position is in flight (§5.6). The preview shows the *estimated* gain (from
   the quote, labelled) and the fee that will be charged (from the floor). The
   ledger records the charged fee next to the A3 fee base.
   Tests: the §4 cases as fixtures; a property test that for every
   actual ≥ grossMinimum the charged fee ≤ rate × max(0, actual − basis − carry);
   TS ↔ SQL rounding parity; the concurrency refusal.
   Ships and is verified live before step 2 starts.
2. **Separate PR: B (contract, independently audited, D4).** `RedeemFeeRouter`
   v2 computes `fee = rate × max(0, swapOutput − basis − carry)` on-chain from
   attested inputs, with a user-visible cap and the per-position nonce (§5.6);
   new deployment (no upgrade path, same rule as the registry).
3. Later, separately: on-chain storage of the locked fee rate, so the rate is
   not an attested value.

## 10. Not decided here / not verified

- Whether LI.FI Composer can route a fee Bag's output through BAG's router.
- Whether the Bag tokens are executable on Uniswap v3 at realistic sale sizes:
  `scripts/check-fee-router-liquidity.ts` answers it read-only (same tier
  order and 99% floor as the attestation); not yet run against the live chain.
- Gas cost of on-chain fee computation (Target B).
- The protocol-share question (F6).
- No fee-taking redemption has been executed live yet (`docs/STATUS.md`).
