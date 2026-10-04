# Accounting V2 — design draft

Status: **design approved, decisions locked (§13); A1 in progress.** Not implemented yet.
Scope: V2 only. V1 (bagprotocol.com) is not changed by anything in this document.

Architecture decision this builds on (2026-10-04): **BAG stays non-custodial
through V2.** The assets a user buys stay in the user's own wallet. BAG
coordinates execution, verifies it, and keeps the books; it never holds the
assets. A pooled BagVault is a separate, future decision (legal review, audit,
economic design) and nothing here depends on it.

---

## 1. What accounting has to answer

For every (user, strategy):

1. What does the user **actually hold** because of this strategy, right now?
2. What did it **cost**, what has been **realized**, what is **unrealized**?
3. Which fees and royalties were **charged**, on which realized amount?
4. Where does the ledger **disagree with the chain**, and why?
5. What is the strategy's own **track record**, independent of who invested when?

Every answer must be reproducible from immutable records (receipts and ledger
events), never from UI state.

## 2. Current state (V2 main + PR #6 branch)

| Table / function | What it holds |
|---|---|
| `bag_holdings` | Per-Bag aggregate quantity per asset, the sum of all investors' DB holdings |
| `bag_share_state` | Per-Bag total share supply |
| `bag_investor_positions` | Per (user, bag): `shares_raw`, one `cost_basis_quote` number |
| `bag_investor_holdings` | Per (user, bag, asset): quantity bought through BAG |
| `apply_purchase_execution` | Atomic: adds holdings (bag + investor), mints shares, adds cost basis, accrues fork royalty from cost basis, writes `activities 'PURCHASE_EXECUTED:…'` |
| `apply_redeem_execution` | Atomic: burns shares, removes holdings sold, cost basis reduced pro rata, profit = `redeemValueQuote − consumed cost basis`, performance fee from that profit |
| `bag_nav_snapshots` (0044/0045) | Per-Bag gross NAV history from `bag_holdings` |
| `creator_reward_settlements` | Fees and royalties owed to creators |

What is already right and stays: atomic RPCs with row locks and
`accounting_applied_at` idempotency; tx-hash claims (`intent_tx_claims`);
per-investor holdings; redeem allocation from the investor's **own** holdings
(`calculateRedeemAllocation`); fee lock after the first external investment
(0033); server-derived lineage (0046).

### Problems in the non-custodial model

- **P1. Pooled shares mix investors.** Shares are minted against the Bag-level
  NAV (`bag_holdings` × prices), but a redemption sells the investor's own
  holdings. The portfolio page values a position as `shares × Bag NAV/share`
  (`app/api/portfolio/positions/route.ts`), so one investor's displayed value
  moves with other investors' fills. In a pooled vault shares are correct; with
  assets in each user's wallet they are an approximation that can be wrong per
  user.
- **P2. Fees on an estimate.** Profit is `redeemValueQuote` (NAV at quote time)
  minus cost basis, not what the sale actually returned. RedeemFeeRouter takes a
  server-attested fixed `feeAmount`. Redeem also needs a NAV, which fails for
  stock tokens when markets are closed.
- **P3. No reconciliation with the chain.** If the user moves or sells tokens
  outside BAG, the ledger still shows them. Positions, TVL and NAV snapshots are
  overstated (`bag_holdings` is DB truth, not chain truth).
- **P4. Thin history.** One cost-basis number per position; no realized P&L,
  no per-asset basis, no event log a third party could audit.
- **P5. Unstructured activity log.** `activities.action` is a string
  (`'PURCHASE_EXECUTED:<intent>:<bag>'`).

## 3. Target model

```
Receipts (verified executions)        Chain observations (balances, logs)
            │                                       │
            ▼                                       ▼
      ledger_events  ◀──── append-only, idempotent, immutable ────▶
            │
            ▼  (deterministic projection, rebuildable)
  position_holdings  ·  positions  ·  strategy aggregates  ·  NAV / TVL
```

- **`ledger_events` is the source of truth.** Every change to a user's tracked
  exposure is one event with a unique idempotency key. Nothing updates a
  projection without an event.
- **Projections are derived.** They can be dropped and rebuilt from events; a
  check compares the rebuilt state with the stored one.
- **The position is the holdings.** A position's economic content is the set of
  (asset, quantity) the user holds because of the strategy, capped by what the
  chain shows (§5). Shares stop being the economic quantity (decision D1).

### 3.1 Ledger event kinds

| Kind | Written by | Effect on tracked holdings | Money fields |
|---|---|---|---|
| `PURCHASE_FILL` | verified purchase receipt | `+qty` per asset received | input spent (payment token raw), USD value |
| `REDEEM_FILL` | verified redeem receipt | `−qty` per asset sold | **proceeds actually received** |
| `FEE_CHARGED` | redeem settlement | none | fee amount, base (realized gain), bps |
| `ROYALTY_ACCRUED` | purchase settlement | none | royalty amount, base, bps |
| `EXTERNAL_OUTFLOW` | reconciliation | `−qty` (tracked follows the chain down) | none (proceeds unknown); reason starts as `UNKNOWN_OUTFLOW` |
| `OUTFLOW_CLASSIFIED` | classifier | none | references an earlier `EXTERNAL_OUTFLOW` and adds its reason (`EXTERNAL_SWAP`, `EXTERNAL_TRANSFER`); the original event is never edited |
| `RECONCILIATION_NOTE` | reconciliation | none | records surplus or a resolved drift |
| `OPENING_BALANCE` | migration only | sets initial state from the existing tables | cost basis carried over |

Common columns: `id`, `user_id`, `bag_id`, `kind`, `legs jsonb`
(`[{chain, address, decimals, delta_raw}]`), `quote jsonb` (payment token
address/decimals/raw amount, USD value and its price source), `source jsonb`
(`{intentId}` or `{chain, txHash, logIndex}` or `{snapshotId}`),
`idempotency_key text unique`, `strategy_version int`, `definition_hash text`,
`created_at`. Rows are insert-only (no update/delete grants; a trigger rejects
both).

### 3.2 Cost basis and realized P&L

- **Method: average cost per (user, bag, asset)** (decision D2). Deterministic,
  easy to audit, no lot bookkeeping. A purchase adds quantity and its share of
  the input spent; a sale or outflow removes quantity at the current average
  cost.
- The input spent is split across assets in proportion to each leg's input
  amount (the receipt already records per-leg input).
- **Realized P&L on a BAG redemption** = proceeds actually received (verified
  receipt outputs, in the payment token) − average cost of the quantities sold.
  This removes the NAV dependency from redeem accounting (fixes P2 and the
  weekend redeem).
- **External outflow** removes quantity and its cost basis but records **no**
  realized P&L: BAG does not know the proceeds and does not guess.

### 3.3 Fees

- Performance fee base: **realized gain above the position's high-water mark of
  cumulative realized P&L** (loss carry-forward). A user who realized a loss
  earlier pays no fee until that loss is recovered.
- Enforceability (documented, not a bug): a fee can only be collected on exits
  executed through BAG. If the user sells the tokens elsewhere, BAG cannot and
  does not charge.
- Today RedeemFeeRouter takes a fixed, server-attested `feeAmount`. Charging on
  realized proceeds on-chain needs a contract change (router computes
  `fee = max(0, swapOutput − attestedCostBasis − attestedLossCarry) × bps`).
  That is a separate contract PR with its own review and audit (decision D4).
  Until then the off-chain ledger records the fee that was actually taken.
- Fork royalty: unchanged (from the purchase's input value, at fill time).

## 4. Units, value and performance

Decision D1 (recommended): **retire pooled shares as the economic quantity.**

- **Position value** = Σ effective quantity × verified price, per user.
  No other investor's fills affect it.
- **Redeem by fraction.** "Sell 25 % / 100 % of this position" sells that
  fraction of each tracked holding (today's allocation math, keyed by bps of the
  position instead of shares).
- **Investor return** from the ledger: money-weighted return (cash in, cash out,
  current value) per position.
- **Strategy track record** = a **Strategy Performance Index**: the target
  weights of each version applied to verified prices, rebalanced at version
  changes, starting at 100. It measures the strategy, not investor timing, and
  is computable for any strategy without any investor. Method published with
  the numbers; real and illustrative series are never mixed.
- `bag_share_state` and `shares_raw` stay readable during migration and are
  then dropped from the UI and API.

### 3.4 Ledger events are not chain events

A chain event says "50 AAPL left the wallet". A ledger event says "these 50
AAPL left the exposure of strategy #42". The classifier links the two: every
ledger event that comes from the chain carries `source = {chain, txHash,
logIndex}` and the allocation used, so the attribution can be audited later.

## 5. Wallet reconciliation

### 5.1 Observation
For each (wallet, tracked asset): `balanceOf` at a recorded block number
(multicall; `lib/server/wallet-holdings.ts` already reads balances).

### 5.2 Attribution
A wallet can hold the same asset for several strategies and outside BAG.

- `tracked_total(asset)` = Σ tracked quantity across the user's positions.
- If `observed ≥ tracked_total`: every position is fully backed; the surplus is
  not BAG exposure and is only noted.
- If `observed < tracked_total`: **shortfall is allocated pro rata** across the
  positions holding that asset (decision D3). Each position's effective
  quantity = tracked × observed / tracked_total.
- **The allocation is stored with the record** (`allocation jsonb`: each
  position's tracked quantity and share at that block). A later change to
  strategy weights or positions never re-allocates an earlier outflow.

### 5.2a Ledger, effective and the record are three different numbers
For each position and asset the projection exposes `ledgerQuantity`,
`observedWallet` (the position's share of it), `effectiveExposure`,
`reconciliationDelta` and `reconciliationStatus` (`OK`, `DRIFT`,
`EXTERNALLY_EXITED`). `min(ledger, wallet)` is only the effective exposure;
it is never written back over the ledger.

### 5.2b When tokens come back
If a shortfall disappears before it is confirmed (§5.3), it was a timing gap:
the drift record is closed and no event is written. After an
`EXTERNAL_OUTFLOW` has been recorded, tokens that later arrive in the wallet
are **not** automatically re-attached to the strategy (they may be an
unrelated purchase); they show as surplus. Re-attaching is an explicit user
action that writes its own event. Earlier events are never deleted.

### 5.3 Invariant
`effective_quantity ≤ tracked_quantity` and
`Σ effective_quantity(asset) ≤ observed_balance(asset)`. The difference is never
hidden: every shortfall produces a reconciliation record and, once confirmed on
two consecutive observations, an `EXTERNAL_OUTFLOW` event that brings tracked
quantity down to effective.

### 5.4 Cadence (decision D6: event-driven + 5-minute safety pass)
- **Real time:** a listener for `Transfer` events of tracked assets from/to
  tracked wallets triggers reconciliation of that wallet within seconds.
  Netlify functions cannot hold a WebSocket open, so the listener is either a
  small always-on worker (provider WebSocket endpoint) or a provider address-
  activity webhook that calls a BAG endpoint. Which one Robinhood Chain's
  provider supports is to be verified before A2.
- **Backstop:** a scheduled pass every 5 minutes (same pattern as the #47
  reconciler) re-reads balances, so a missed event is corrected.
- Also on portfolio/activity visits. Pending BAG intents for the wallet are
  settled first so an in-flight sale is not misread as an external exit.
- Chain source of truth: provider RPC/WebSocket (Robinhood's documentation
  recommends a provider such as Alchemy over the public RPC for production,
  and an archive endpoint for historical reads). Blockscout is a supplemental
  indexer for classification, debugging and fallback, never the source of
  truth (decision D5).

## 6. External exit detection

Phased, so v2.0 never claims more than it knows.

- **v2.0 — balance diff only.** Shortfall → `UNKNOWN_OUTFLOW` reason. Correct,
  cheap, no log indexing.
- **v2.1 — classification from logs.** For each outflow, read the transaction:
  - hash claimed by a BAG intent → `BAG_EXECUTION` / `BAG_REDEEM`;
  - same tx also credits the wallet with a registry token → `EXTERNAL_SWAP`;
  - transfer to another address with nothing back → `EXTERNAL_TRANSFER`;
  - anything else → `UNKNOWN_OUTFLOW`.

  Source: RPC `eth_getLogs` filtered by `Transfer(from = wallet)` per asset, or
  an indexer (Blockscout API) — decision D5. A classification is shown only when
  the evidence supports it.

## 7. Position state machine

```
            PURCHASE_FILL
   (none) ───────────────▶ ACTIVE ◀──────────────┐
                            │  │                  │ drift resolved
              BAG redeem    │  │ shortfall        │ (balance restored)
              requested     │  ▼                  │
                            │  DRIFTED ───────────┘
                            │  │ effective = 0, cause external
                            │  ▼
                            │  EXTERNALLY_EXITED (terminal for this position)
                            ▼
                       REDEEMING ── verified fill ──▶ ACTIVE (partial) / CLOSED (100 %)
                            └── failed / expired ──▶ previous state
```

States are stored on the position projection and used by the portfolio UI,
TVL, and performance. `CLOSED` and `EXTERNALLY_EXITED` positions stay visible
in history with their realized results.

**User-facing:** a drift is shown on the position ("about 42 % of this
position left your wallet outside BAG on Oct 4, 2026 · view transaction"),
with the reason only as certain as the classifier is (`UNKNOWN_OUTFLOW` is
shown as "moved out, reason unknown"). A fully exited position shows
"Externally exited". In the non-custodial model this is a feature, not an
error state.

## 8. NAV and TVL

- **Strategy TVL** = Σ over its positions of effective quantity × verified
  price. Uses the reconciled view, not `bag_holdings`.
- **NAV snapshots** keep their table; the value they record switches to the
  reconciled TVL, with the snapshot's price sources stored alongside.
- **Settlement never uses NAV.** Purchases price from the executable quote
  (#44); redemptions book realized proceeds. NAV is valuation and reporting.
- Price rules unchanged: missing, stale or out-of-band prices fail closed and
  the value is shown as unavailable, never estimated.

## 9. Data model changes

New:
- `ledger_events` (§3.1), insert-only.
- `position_holdings` (user, bag, asset → tracked_qty, avg_cost, effective_qty,
  last_observed_block). Replaces `bag_investor_holdings` after migration.
- `positions` (user, bag → state, cost_basis, realized_pnl, realized_hwm,
  opened_at, closed_at). Replaces `bag_investor_positions` after migration.
- `wallet_observations` (wallet, asset, block, observed_raw, observed_at).
- `reconciliation_records` (user, asset, block, tracked_total, observed,
  shortfall, allocation jsonb, reason, status).

Changed:
- `apply_purchase_execution` / `apply_redeem_execution` also write the ledger
  event in the same transaction (idempotency key = intent id), during the
  dual-write period.
- `apply_redeem_execution` takes realized proceeds (from the verified receipt)
  instead of `p_redeem_value_quote`.
- `activities` stays for the activity feed; ledger events are the record.

Dropped (after migration and a release with both): `bag_share_state`,
`shares_raw` in the API, `bag_holdings` as a source for TVL.

## 10. Migration

1. Create the new tables (migration, idempotent).
2. Backfill `OPENING_BALANCE` events from the existing positions and holdings,
   and replay settled intents where their receipts allow it.
3. Rebuild projections from events and **compare with the current tables**;
   the migration fails on any difference above dust.
4. Dual-write (old tables + events) for one release; reads move to the new
   projections behind a flag.
5. Turn on reconciliation (v2.0); then remove the old reads.

## 11. Invariants (tested)

- Same events → same projections (rebuild equals stored).
- Every event's idempotency key is unique; replaying a receipt changes nothing.
- `effective ≤ tracked`; `Σ effective(asset) ≤ observed balance(asset)`.
- Realized P&L only from verified proceeds; never from NAV or a quote.
- Fee only when cumulative realized P&L exceeds its high-water mark.
- Concurrency: 50 concurrent fills and 8 concurrent applies of one intent
  (existing tests) extended to ledger events; reconciliation concurrent with a
  settling redemption does not double-count.
- Events cannot be updated or deleted (privilege + trigger test).

## 12. Delivery plan (V2 PRs)

| PR | Content |
|---|---|
| A1 | `ledger_events` + dual write in both RPCs + backfill + rebuild-equals-stored check |
| A2 | Wallet observations + reconciliation v2.0 (balance diff) + effective exposure in portfolio and TVL |
| A3 | Realized P&L and fees from verified proceeds (off-chain books) + loss carry-forward |
| A4 | Redeem by fraction; position value from holdings; shares removed from UI/API |
| A5 | External exit classification v2.1 |
| A6 | Strategy Performance Index + `/strategies/:id/performance` |
| C1 (separate) | RedeemFeeRouter: fee computed on-chain from realized output (needs audit) |

API added along the way: `/users/me/positions` (state, tracked, effective,
drift), `/users/me/ledger`, `/users/me/reconciliation`.

## 13. Decisions (locked 2026-10-04)

- **D1** Pooled shares are retired as the economic quantity.
- **D2** Average cost per (user, bag, asset). A tax-lot engine, if ever needed,
  is a separate layer on top of the ledger.
- **D3** Shortfall allocation across strategies is pro rata, with the
  allocation snapshot stored on the record (§5.2).
- **D4** Fee on realized proceeds enforced on-chain is a separate, audited
  contract PR **after** Accounting V2. Until then the existing enforceable fee
  path stays, and the docs state plainly: a BAG-enforced fee applies only to
  exits executed through BAG; a sale outside BAG carries no BAG fee.
- **D5** Provider RPC/WebSocket is the chain source of truth; Blockscout is
  supplemental (classification, debugging, fallback).
- **D6** Event-driven reconciliation plus a 5-minute safety pass.

One-click sell (exit the whole strategy in one plan) ships alongside A4: it is
the end-to-end test of the books (buy → position → wallet → sell → realized
P&L → closed).

## 14. Not verified

- Robinhood Chain RPC limits for `eth_getLogs` and multicall batch sizes.
- Blockscout API availability and rate limits for Robinhood Chain.
- Whether every historical intent's receipt has enough data to replay it
  exactly; where it does not, the opening balance comes from the current tables.
