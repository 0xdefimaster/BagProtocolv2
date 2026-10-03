# BagVault — Design & Spec (Phase 19.X-6)

**Status: DESIGN ONLY. No `BagVault.sol` exists. No `BagFactory.createBagVault()`
exists. No custodial wallet, no private-key custody, nothing in this
document should be read as "already built."** This is deliberate — see
strict rule in the 19.X spec ("ŞU ANDA: BagVault.sol oluşturma"). Everything
below is a proposal to be reviewed, not a changelog.

---

## 0. The one question you asked me to answer definitively

> BAG başına Vault mu? User başına Vault mu?

**BAG başına deterministic Smart Vault — one `BagVault` per Bag, never one
per user.** This isn't a preference; it's forced by architecture that
already exists in this repo, independent of anything in this design doc:

1. **`bag_holdings` is keyed by `bag_id`, not by `(bag_id, user_id)`.**
   `lib/server/bag-holdings-repo.ts` — `getBagHoldings(admin, bagId)`,
   `unique(bag_id, chain, address)`. There is exactly one holdings table
   per Bag today, off-chain. A vault is the on-chain version of that same
   table; it inherits the same keying or the two stop meaning the same
   thing.

2. **`bag_share_state` is keyed by `bag_id`, and NAV is computed from a
   single pooled holdings set.** `lib/domain/basket-protocol/nav/nav.ts`'s
   own module doc: *"NAV = Σ (holding quantity × price), computed from
   ACTUAL holdings"* — one NAV per Bag, not one NAV per (Bag, user) pair.
   `calculateNavPerShare()` (`shares.ts`) divides ONE NAV by ONE share
   supply. This is the standard ERC-4626 shape: shares are claims on a
   single shared asset pool, which is precisely what "vault" means in that
   standard — and it is already how this protocol's off-chain accounting
   works. A per-user vault would have a share supply of exactly 1 (the
   user's own shares against their own assets), at which point "shares"
   and "NAV per share" stop meaning anything — you'd just have a wallet.

3. **`Bag.sol` is already a 1:1, deterministic, factory-deployed identity
   per Bag** (`BagFactory.bagOf: bagId -> address`, `AlreadyDeployed` guard
   — one Bag can never be deployed twice). A `BagVault` sits at exactly the
   same cardinality: `BagFactory` already proves the pattern of "one
   deterministic contract per `bagId`," and reusing that pattern for the
   vault (rather than inventing a per-user one) is the only way the vault
   and `Bag.sol`'s identity stay in lockstep across composition versions,
   forks, and redeployments.

4. **Forking makes a NEW Bag with its own `bagId`, holdings, and share
   supply** (`app/api/bags/[id]/fork/route.ts` produces a new bag row with
   its own lineage — see `docs/` fork-related notes). A per-Bag vault model
   means "fork the Bag" and "fork the vault" are the same event, with the
   same cardinality guarantee `Bag.sol`/`BagFactory` already give you for
   free. A per-user model has no natural mapping to "fork" at all — whose
   vault would the fork's shares come from?

A per-user vault would also reintroduce exactly the "N signatures instead
of one" and "no atomic multi-asset basket" problems the 19.X-1..3 provider
work (`BagRouterProvider`, `RobinhoodUniswapProvider`) was built to solve
— each user would need their own custody contract deployed before their
first deposit, with its own gas cost and its own allowlist configuration,
for a basket that is economically identical for every holder.

**Repo-grounded conclusion: BAG başına Vault. Confirmed, not assumed.**

---

## 1. Vault authority

- **One `BagVault` per `bagId`**, deployed the same way `Bag.sol` is —
  factory-deployed, deterministic address recoverable from `bagId` alone
  (either via a registry mapping like `BagFactory.bagOf`, or via CREATE2
  with `bagId` as salt — see §9 for the tradeoff).
- **The vault itself never has an "owner" who can move user assets
  arbitrarily.** Its only privileged actions are protocol-level (pause,
  fee-parameter updates within pre-agreed bounds, allowlist updates for
  what `BagExecutionRouter` targets it will accept execution results from)
  — never a `withdraw(address to, uint256 amount)` escape hatch for an
  admin key. This mirrors `CreatorRewardsVault.sol`'s existing pattern:
  privileged roles can *settle* into balances, never *pull out* someone
  else's balance (see that contract's own "no settler has any withdrawal
  path beyond the same public withdraw() every creator uses" test).
- **Composition changes (`Bag.recordVersion`) do not, by themselves, move
  a single unit of the vault's assets.** A version bump changes *target*
  weights; moving actual holdings toward a new target is a separate,
  explicit rebalance execution (through the same `BagExecutionRouter` /
  provider seam item 7 already built), not something `recordVersion`
  triggers implicitly. This preserves the existing invariant from
  `nav.ts`'s doc: recipe weights are a *target*, holdings are *actual*,
  and nothing silently conflates the two on-chain either.

## 2. Asset custody

- The vault holds the Bag's actual ERC-20 holdings directly — the same set
  `bag_holdings` already tracks off-chain, now with an on-chain source of
  truth (see §13).
- **Only `BagExecutionRouter` (or its successor execution boundary) may
  move assets out of the vault to swap them**, and only into other
  allowlisted canonical assets, via the same `isAllowedTarget`/
  `isAllowedToken` two-layer allowlist model `BagExecutionRouter.sol`
  already implements. The vault does not re-implement its own DEX
  allowlist — it trusts one execution boundary, the same one item 7 built,
  rather than growing a second one.
- Deposits and redemptions are the only two paths assets cross the vault's
  boundary in bulk to/from a user; router-driven execution moves them
  *within* the vault's own custody (asset A → asset B, same vault).

## 3. Shares

- ERC-20 (or ERC-4626-compatible) share token, one per vault, 1:1 with the
  Bag. Decimals: 18, matching `bag_share_state`'s existing
  `shareDecimals` convention in `types/basket-protocol.ts` unless a
  specific Bag's off-chain state already committed to something else at
  bootstrap (see §9 migration note).
- Shares represent a proportional claim on the vault's *current* holdings
  at redemption time — never a claim on a fixed asset (a BTC-holding
  Bag's shares are not "shares that redeem for BTC," they're "shares that
  redeem for whatever the vault holds, pro-rata," exactly like
  `RedeemQuote`'s existing multi-asset shape in `shares.ts`).

## 4. NAV

- On-chain NAV computation is **out of scope for the vault contract
  itself** in this design. The vault does not embed a price oracle. NAV
  for pricing a deposit/redeem is computed off-chain (same
  `getBagNavSafe()` / `PriceProvider` path that already fails closed on a
  stale/missing price — `lib/server/purchase-execution.ts` already refuses
  to quote without it) and passed to the vault as a **signed attestation**
  at execution time — the same EIP-712 attestation pattern
  `RedeemFeeRouter.sol` already uses for fee amounts (`feeAttestor`,
  `InvalidPlanSignature`-style checks). This keeps the vault from ever
  trusting a client-supplied NAV, without duplicating a full oracle stack
  on-chain for a first version.
- Rationale for NOT putting NAV on-chain yet: every price/staleness
  invariant this protocol currently enforces
  (`lib/domain/basket-protocol/pricing/staleness.ts`,
  `StalePriceError`) already lives off-chain and is already tested; moving
  it on-chain is a separate, larger phase (an oracle integration), not a
  vault-shape decision, and mixing the two would make this doc's actual
  question (vault cardinality) harder to review.

## 5. Deposit

1. User sends input asset to the vault (or approves + vault pulls, same
   `transferFrom` pattern `BagExecutionRouter` already uses).
2. Off-chain-computed `DepositQuote` (already-existing pure math,
   `shares.ts`) determines shares to mint, using NAV-per-share **at the
   moment of execution**, attested the same way as §4.
3. Vault mints shares to the depositor.
4. If the deposit requires swapping the input asset into the Bag's target
   composition (the common case — USDG in, BTC/ETH/SOL out), that swap
   happens via `BagExecutionRouter`/`RobinhoodUniswapProvider` (items
   7/19.X-1) BEFORE minting, so shares are only minted once the vault
   actually holds the resulting basket — never mint-then-hope-the-swap-
   succeeds.

## 6. Redeem

1. User burns shares.
2. Off-chain-computed `RedeemQuote` determines the pro-rata basket (or, if
   redeeming to a single output asset, the swap path through
   `BagExecutionRouter`) owed.
3. Vault pays out — either the pro-rata basket directly, or single-asset
   after an internal swap, mirroring `RedeemFeeRouter.sol`'s existing
   multi-leg, atomic, all-or-nothing redemption pattern (a leg reverting
   reverts the whole redemption, no partial payout — same invariant
   `BagExecutionRouter.sol` already enforces for purchases).
4. Burn happens **before** payout is attempted is the wrong order for the
   reentrancy-safety pattern already used elsewhere in this repo
   (`CreatorRewardsVault`/`RedeemFeeRouter` both use
   `ReentrancyGuard` + checks-effects-interactions) — burn-then-pay is
   correct precisely because it is the same order those two contracts
   already use and have tests proving atomicity for.

## 7. Rounding

- **Always round in the vault's favor, against the depositor/redeemer** —
  same policy `quoteDecimalToRewardTokenRaw()` in
  `lib/config/robinhood-chain.ts` already documents ("floor... so the
  vault is never asked to pay out more raw units than the amount
  justifies"). Concretely:
  - Deposit: shares minted = floor(deposit value / NAV-per-share). Never
    round up share issuance.
  - Redeem: assets paid out = floor(shares burned × NAV-per-share ×
    pro-rata basket weight). Never round up payout.
- This is the standard ERC-4626 rounding direction (round down on mint,
  round down on withdraw-equivalent) specifically because rounding the
  other way, compounded over many small deposits, is an exploitable
  drain — see §8.

## 8. Donation attack / inflation attack

Both are the same underlying class of attack (an ERC-4626-family vault
with a low or zero share supply is manipulable by donating raw assets
directly to the vault to inflate `NAV-per-share` before a victim's deposit
rounds their shares down to zero) — treated together, matching how
OpenZeppelin's own ERC-4626 hardening docs treat them.

Mitigations, in order of preference for this protocol (this is a design
decision to review, not yet locked in):

1. **Virtual shares / virtual assets offset** (OpenZeppelin's ERC-4626
   `_decimalsOffset()` pattern) — pad the internal share:asset ratio with
   a fixed virtual amount so the first depositor's price-per-share can't
   be pushed to an attacker-chosen extreme by a raw donation. This is the
   standard, most battle-tested fix and requires no protocol-specific
   bootstrap logic.
2. **Dead-shares bootstrap on first deposit** (Uniswap V2's `MINIMUM_LIQUIDITY`
   pattern) — mint a small, permanently-locked amount of shares to the
   zero address (or an unrecoverable sink) on the very first deposit into
   a fresh vault, so `totalSupply` is never zero/near-zero for an attacker
   to manipulate cheaply. `bag-share-state-repo.ts`'s existing
   `bootstrapShareSupply()` already models "a fresh Bag starts with a
   defined bootstrap state" off-chain — this is the on-chain analogue.
3. **NAV computed from tracked internal accounting, not raw
   `balanceOf(vault)`.** If the vault tracks "assets it believes it holds"
   internally (updated only on deposit/redeem/router-execution) rather
   than reading `IERC20(asset).balanceOf(address(this))` live, a bare
   donation transfer changes nothing about NAV-per-share at all — it just
   sits there as an un-accounted, sweepable-by-governance surplus. This is
   the strongest mitigation but is a bigger design commitment (the vault
   must now reconcile its internal ledger against real balances
   periodically, similar to the `RECONCILIATION_REQUIRED` state item 6 of
   the parent 19.X spec already introduces for purchase/redeem intents —
   the same reconciliation *concept*, applied to vault-level accounting).

**Recommendation for the eventual implementation phase: (1) + (2)
together**, with (3) as a later hardening pass once the
execute-time-reconciliation state machine (19.X items 6/7) is live and can
be reused for vault-level reconciliation too, rather than building a
second, separate reconciliation mechanism just for the vault.

## 9. Decimal handling

- Share token: 18 decimals (see §3).
- NAV internal scale: 18 decimals — **reuse `NAV_VALUE_DECIMALS` from
  `lib/domain/basket-protocol/nav/nav.ts` verbatim** rather than picking a
  new constant for the on-chain side; that file's own doc already explains
  why 18 is the exact, remainder-free scale for any combination of asset
  decimals up to 18 (the protocol's own `assets` table cap). Two different
  "the NAV scale" constants (one off-chain, one on-chain) would be exactly
  the "reimplemented in two places" failure mode this whole 19.X effort
  has been avoiding for quoting/routing logic — the vault's on-chain
  scale must be the SAME 18, derived from the same reasoning, not a
  coincidentally-equal separate choice.
- Underlying asset decimals vary per holding (BTC/ETH/SOL/xStock all
  potentially different) — the vault (or its accounting library) must
  normalize every holding to the 18-decimal NAV scale before summing,
  exactly the way `nav.ts`'s `toNavValue()` already does off-chain. This
  is a port of existing, tested logic to Solidity, not new design.

## 10. Execution permissions

- The vault grants exactly one contract standing permission to move its
  assets for swap purposes: `BagExecutionRouter` (or a per-Bag-vault-aware
  successor — see resolution below). No other address, including the
  vault's own admin/owner role, can initiate a swap.
- The vault's owner/admin role can: pause deposits/redemptions (circuit
  breaker), update the accepted execution-router address (in case of a
  router upgrade/migration — with a timelock, in the eventual
  implementation, so this can't be used to redirect funds instantly), and
  adjust protocol fee parameters within a pre-committed bounded range. The
  admin role can NOT: withdraw arbitrary assets, mint shares to itself,
  or bypass the deposit/redeem accounting path.

### RESOLVED — vault-aware recipient mode (previously an open question)

**`BagExecutionRouter.sol` needs no change at all.** The vault simply
becomes the caller, exactly the way any end-user wallet is today. Read
straight from the contract's own `execute()` entry checks:

```solidity
if (plan.wallet != msg.sender) revert WalletMismatch(plan.wallet, msg.sender);
...
IERC20(plan.inputToken).safeTransferFrom(msg.sender, address(this), plan.inputAmount);
...
IERC20(plan.minOutputs[i].token).safeTransfer(msg.sender, outputAmounts[i]);
```

`msg.sender` is never assumed to be an EOA — it is whatever address both
(a) equals `plan.wallet` and (b) actually calls `execute()`. If the VAULT
contract is the one that calls `execute()`, with `plan.wallet ==
address(vault)`, then:
- input is pulled from the vault's own balance (`safeTransferFrom(vault, router, ...)`),
- output is paid back to the vault (`safeTransfer(vault, ...)`),
- with **zero** changes to the router's code, ABI, EIP-712 typehash, or
  its existing test suite.

This was initially flagged as an open question because it's easy to
mentally default to "the router pays `msg.sender`, so the router needs to
learn about a separate `recipient`" — but that instinct is exactly the
thing the contract's own header explicitly and deliberately rejects:

> *"There is deliberately no `recipient` parameter anywhere in this
> contract, so a stolen or malicious plan still cannot redirect a single
> token to a third party — the worst it can do is waste the caller's own
> funds within the caller's own declared minimums."*

Adding a `recipient` field to let a vault redirect output somewhere other
than itself would REINTRODUCE exactly the third-party-redirect risk that
sentence was written to close off — for no actual benefit, since the
vault redirecting its own swap output to itself is precisely what
`msg.sender`-as-recipient already gives it for free.

**What this means for the eventual `BagVault` implementation** (still not
built — this only describes the shape, per this phase's strict rule): the
vault needs one thin, access-controlled entrypoint, sketched here in
prose, not code:

- `rebalance(ExecutionPlan plan, bytes planSignature)` — restricted to a
  keeper/owner role (NOT public; unlike a user's own purchase, nobody
  external should be able to force the vault into an arbitrary allowlisted
  swap at an arbitrary moment just because the plan is validly signed).
  Internally: `IERC20(plan.inputToken).approve(router, plan.inputAmount)`,
  then `router.execute(plan, planSignature)`, with `plan.wallet` set to
  `address(this)` (the vault) by the off-chain compiler when it builds a
  rebalance plan — the SAME compiler/leg-builder/plan-signer pipeline
  items 1–3 already built, just fed a vault address instead of a user's
  wallet address as `wallet`.
- The vault's own reentrancy posture: since `execute()` already carries
  `nonReentrant`, and the vault's `rebalance()` calls it, the vault's
  internal accounting update (crediting the newly-swapped holdings) should
  happen AFTER `router.execute()` returns, checks-effects-interactions
  style — consistent with every other pattern already used in this
  repo's contracts (`CreatorRewardsVault`, `RedeemFeeRouter`).
- User-facing deposit/redeem entrypoints on the vault remain completely
  separate from `rebalance()` — a user's assets moving into/out of the
  vault (§5/§6) never themselves call `BagExecutionRouter`; only a
  keeper-triggered `rebalance()` does, and only to move the vault's
  ALREADY-HELD assets toward the Bag's target composition, never to move
  a specific user's deposit before it's been pooled into the vault's
  general holdings.

Net effect: `BagRouterProvider`/`RobinhoodUniswapProvider` (items 1–3) do
not need to know or care whether `wallet` is a user's EOA or a future
vault's contract address — the entire execution pipeline built in this
phase is already vault-ready, with no rework.

## 11. BagFactory relationship

- `BagFactory` remains the single source of truth for "does this `bagId`
  exist and what's its `Bag.sol` address" — the vault does NOT duplicate
  that registry. A `BagVaultFactory` (or an extension of `BagFactory`
  itself — a later decision, not this doc's job to make) would hold the
  equivalent `bagId -> vault address` mapping, deployed at the same time
  and by the same deployer role as the `Bag` for that `bagId`, so the two
  can never exist independently of each other (a Bag with no vault, or a
  vault with no Bag, should be structurally impossible, not just
  convention).
- Per the strict rule for this phase, **no `BagFactory.createBagVault()`
  method is added in this pass.** This section describes the intended
  relationship for when that method IS added, not a change made now.

## 12. User Wallet relationship

- A user's wallet never holds Bag shares' underlying assets directly while
  invested — it holds the ERC-20 share token. This is the same mental
  model `hooks/useBag.ts` / `hooks/use-purchase-execution.ts` already
  present to the frontend (a user "owns a Bag position," not "owns a
  basket of raw tokens they have to individually track").
- The wallet interacts with the vault through exactly two entrypoints
  (deposit, redeem) plus standard ERC-20 share transfers — never through a
  vault-specific "trade" function. All swap complexity stays inside the
  vault + `BagExecutionRouter`, invisible to the wallet, matching the
  existing "wallet layer never needs to know which provider produced a
  compiled execution" principle from `lib/execution/types.ts`'s own doc
  on `CompiledExecution`.

## 13. Source of truth

- **Post-vault, the vault's on-chain holdings become the source of truth
  for "what does this Bag actually hold,"** superseding `bag_holdings`
  for that specific question. `bag_holdings` becomes a synced *cache/index*
  of on-chain state (for fast reads, search, and the existing NAV
  calculation path), refreshed by watching the vault's own events —
  the same relationship `bag_share_state` would have to the vault's
  `totalSupply()`.
- **Until the vault exists, `bag_holdings`/`bag_share_state` remain the
  actual source of truth**, exactly as they are today. This design does
  not change anything about today's off-chain accounting; it describes
  what changes WHEN a vault is eventually implemented and deployed for a
  given Bag — and implies a per-Bag migration event (Bag by Bag, not a
  single global cutover), since each Bag's vault deployment is
  independent.

---

## Summary table

| Question | Answer |
|---|---|
| Per-Bag or per-user? | **Per-Bag.** Forced by existing `bag_holdings`/`bag_share_state` keying, NAV-per-share math, and `Bag.sol`/`BagFactory`'s existing 1:1 cardinality pattern. |
| Who can move vault assets? | Only `BagExecutionRouter` (or successor), never an admin key directly. |
| Vault-aware recipient mode? | **RESOLVED — no router change needed.** Vault calls `execute()` itself with `plan.wallet = address(vault)`; router already pays `msg.sender`. |
| Where is NAV computed? | Off-chain (existing, tested `PriceProvider`/`nav.ts` path), attested on-chain at execution time — no on-chain oracle in this design. |
| Rounding direction? | Always in the vault's favor (floor on mint, floor on payout). |
| Donation/inflation attack mitigation? | Virtual shares/assets offset + dead-shares bootstrap; internal-ledger accounting as a later hardening pass. |
| NAV decimal scale? | 18 — reuses `NAV_VALUE_DECIMALS`, not a new constant. |
| Relationship to `BagFactory`? | Parallel 1:1 registry, deployed together; **not built this phase.** |
| Is any of this implemented? | **No. Design only, per the explicit strict rule for this phase.** |
