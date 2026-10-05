# Performance fee economics — design

Status: **DESIGN FOR REVIEW. No code, contract or migration changes.** Nothing
here is implemented until the decisions in §8 are taken.

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
| Recipients | Creator: 100% of the fee (claimable from the vault). Protocol: **0**. (Fork royalty is a separate, purchase-time 1.5% and is not touched here.) |
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
- **B0 (interim, no contract change)** — keep today's router, change only what
  the server attests: the fee is computed on the **guaranteed minimum
  proceeds** (the floor the router itself enforces) instead of the NAV quote.
  Actual proceeds are always ≥ that floor, so the user is **never charged on
  gain they did not realize**; the creator may receive slightly less than the
  exact fee (at most `rate × (actual − minimum)`, i.e. ≤ rate × slippage).

## 4. The three cases, with numbers

Common setup: one investor (not the creator), cost basis **$100**, sells 100%;
locked fee rate **10%**; slippage floor **1%** (the minimum is 99% of the swap
quote; the router reverts below it); protocol share **0** (today's value, §6).
Money in USDG; fee rounded down to the cent in the user's favour.

### Case 1 — actual proceeds above the quote

NAV value $120.00 · swap quote $120.00 · guaranteed minimum $118.80 · **actual $122.00** · realized gain $22.00

| | Today (NAV quote) | B0 (minimum, no contract change) | Target (B + C) |
|---|---|---|---|
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
| Gross proceeds | 119.00 | 119.00 | 119.00 |
| Fee base | 20.00 | 18.80 | 19.00 |
| Performance fee | 2.00 (overcharge 0.10) | 1.88 | 1.90 |
| User receives | 117.00 | 117.12 | 117.10 |
| Creator receives | 2.00 | 1.88 | 1.90 |
| Protocol receives | 0 | 0 | 0 |

### Case 2b — the quote shows a gain, the sale realizes a loss

NAV value $101.00 · swap quote $100.50 · minimum $99.49 · **actual $99.60** · realized gain **−$0.40**

| | Today | B0 | Target |
|---|---|---|---|
| Gross proceeds | 99.60 | 99.60 | 99.60 |
| Fee base | 1.00 (from the quote) | 0 (minimum < basis) | 0 (loss) |
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
(non-custodial, documented in ACCOUNTING_V2_DESIGN §3.3). Fee rounded down to
the token's smallest unit, in the user's favour.

## 6. Recipients

| | Today | Proposed |
|---|---|---|
| Creator | 100% of the performance fee, via `CreatorRewardsVault` (claim) | Unchanged |
| Protocol | 0 | Unchanged here. A protocol share is a separate business decision; if taken it is one more split in the same atomic step and must be visible in the preview |
| Fork parent | Purchase-time fork royalty (1.5%), separate | Unchanged |

## 7. Trust boundaries

| Step | Today | B0 | Target B (+ C + D) |
|---|---|---|---|
| Fee amount | Server-computed and attested from NAV | Server-computed and attested from the guaranteed minimum | **Contract-computed** from the measured output |
| What the server still attests | Fee, minimum proceeds, exact legs | Same | Consumed basis, loss carry, rate, exact legs, minimum proceeds |
| Worst case if `feeAttestor` is stolen | Any fee up to the output (user sees it only in the preview) | Same | Inflated basis/loss carry can only **lower** the fee; an inflated rate is capped by a user-visible maximum in the signed parameters — and ideally by the rate stored on-chain (open item) |
| User's guarantee | `swapOutput ≥ minUserProceeds + fee` | Same, and fee ≤ fee on the floor | Fee ≤ rate × max(0, actual − basis − carry), checked on-chain |

Target B also requires the proceeds to pass through BAG's router, so a fee Bag
cannot sell through LI.FI Composer unless Composer can deliver its output to
the router (not verified).

## 8. Decisions requested

| # | Decision | Recommendation |
|---|---|---|
| F1 | Fee base = realized gain from actual proceeds (C); quotes never enter | **Yes** |
| F2 | Consumed basis from A3 holdings, not shares | **Yes** |
| F3 | Net across legs within a sale | **Yes** |
| F4 | Loss carry-forward / realized high-water mark (D) | **Yes**, from the first implementation (A3 already computes it); otherwise in the contract PR at the latest |
| F5 | Mechanism | **B0 now** (server-only change, no contract, never overcharges), **B later** as the audited contract PR (D4) |
| F6 | Protocol share of the performance fee | Stays 0; separate decision |
| F7 | Post-settlement collection (A) | **Rejected** for enforcement; kept as accounting (A3) |

## 9. Implementation plan (after the decisions)

1. **B0 + F1–F4 (server only).** Attestation computes `feeBase` from the
   guaranteed minimum and the holdings-based basis net of loss carry; the
   preview shows *estimated* fee (from the quote) and *maximum* fee (from the
   floor); the ledger records the charged fee next to the A3 fee base. Tests:
   the cases in §4 as fixtures; a property test that the charged fee never
   exceeds rate × realized gain for any actual ≥ minimum.
2. **B (contract PR, audited, D4).** `RedeemFeeRouter` v2 computes
   `fee = rate × max(0, swapOutput − basis − carry)` on-chain with a
   user-visible cap; new deployment (no upgrade path, same rule as the
   registry); server attests inputs only.
3. Later, separately: on-chain storage of the locked fee rate, so the rate is
   not an attested value.

## 10. Not decided here / not verified

- Whether LI.FI Composer can route a fee Bag's output through BAG's router.
- Gas cost of on-chain fee computation (Target B).
- The protocol-share question (F6).
- No fee-taking redemption has been executed live yet (`docs/STATUS.md`).
