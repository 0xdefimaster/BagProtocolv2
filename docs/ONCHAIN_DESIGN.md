# On-chain features — design (no code)

> **Status: DESIGN ONLY.** Nothing here is implemented. It builds on the
> BagVault spike (`docs/BAG_VAULT_DESIGN.md`, `contracts/BagVault.sol`, not
> deployed). Sizes are rough: **S** about a week, **M** a few weeks, **L** a
> month or more, audit not included.
>
> "Not verified" means I could not check it against a primary source in this
> work. In particular, docs.robinhood.com and docs.chain.link were not
> reachable from the environment.

Every section has the same parts:
- problem;
- mechanism;
- dependency on BagVault;
- related code;
- security risks;
- open questions;
- size.

---

## 1. Contract-enforced creator fees

**Problem.** The creator fee is enforced off-chain today:
- the backend computes and attests it;
- `RedeemSettlement` charges the performance fee on an actual sale, from a signed basis and loss carry;
- the high-water mark (HWM) and cost basis live in the database ledger (Accounting V2).

A transferable vault share has no per-user basis on chain, so this model does not carry over.

**Mechanism:**
- **Management fee by dilution.** The vault mints fee shares to the creator over time:
  - `feeShares = supply × rate × Δt / (1 − rate × Δt)`, accrued lazily on every mint/redeem;
  - it costs holders a fraction of their claim, and moves no tokens;
  - the rate is capped and fixed at vault creation, with no admin change;
  - in-kind fits naturally: the fee is a share of the basket, not cash.
- **Performance fee with an on-chain HWM.** It needs a value per share, and therefore a price.
  - Per vault (not per user): the fee is charged as dilution only when NAV per share is above a global HWM; the HWM is then raised.
  - Requires an oracle (see risks). A per-user HWM is not practical with a transferable token.
- **Relation to `CreatorRewardsVault.sol`:**
  - management-fee shares can be minted straight to the creator;
  - `CreatorRewardsVault` stays for USDG-denominated rewards from the existing off-chain path.

**Transition path.** Keep the off-chain fee for wallet-held (non-vault) positions. Vault Bags use only the on-chain management fee at first. The performance fee follows once a price source is accepted.

**BagVault dependency.** Hard: the fee is charged in vault shares.

**Related code:**
- `contracts/RedeemSettlement.sol`
- `contracts/CreatorRewardsVault.sol`
- `lib/server/redeem-settlement-attestation.ts`
- `lib/domain/basket-protocol/redeem/performance-fee-b0.ts`
- `lib/domain/basket-protocol/accounting/position-pnl.ts`
- `docs/ACCOUNTING_V2_DESIGN.md`
- `docs/FEE_ECONOMICS_DESIGN.md`

**Security risks:**
- A dilution fee must be accrued before every supply change. Missing it lets a minter avoid fees or overpay.
- Rounding.
- A performance fee priced from a manipulable oracle lets the creator inflate NAV and mint fee shares.

**Open questions:**
- Is a management fee acceptable to the product? Today it is performance-only.
- Is a global HWM fair when holders enter at different times?
- How do on-chain and off-chain fees coexist for a user who holds both forms?

**Size.** Management fee: M. Performance fee with HWM: L, gated on an oracle decision.

---

## 2. Permissionless rebalance auction

**Problem.** The vault composition is fixed. Drift and a Bag's new version have no on-chain path, and anyone allowed to swap vault assets is a custody risk.

**Mechanism:**
- **Trigger.** Anyone can start an auction when drift from target weights exceeds the Bag's `driftThresholdBps`, or when the Bag records a new composition version.
- **Contract-set flows.** The contract publishes the exact amounts it wants out and in. The goal is to move toward target weights, bounded per auction (e.g. at most N bps of NAV).
- **Solver.** A solver brings the "in" tokens and receives the "out" tokens. The solver earns the spread.
- **Minimum output.** The contract enforces a minimum value in, against an oracle: `valueIn ≥ valueOut × (1 − maxSlippage)`.
- **Dutch auction.** The required value ratio decays from above fair toward the floor over time. The first solver to accept wins. This limits the cost of a bad oracle tick.
- **Manipulation.** Use a TWAP or a median of feeds, not a spot price. Use the Chainlink tokenized-equity feed where it exists. Refuse during halts, oracle pauses or market closures, with a staleness bound.
- **Mapping to `Bag.sol` versions.** A completed rebalance to version N sets the vault's target to version N. `isCurrentComposition()` then becomes per-target rather than fixed. This needs an on-chain-recomputable composition (see `docs/BAG_VAULT_DESIGN.md` §9.1).

**BagVault dependency.** Hard. It also changes the vault: the fixed component list becomes a mutable target.

**Related code:**
- `lib/domain/basket-protocol/rebalance/rebalance.ts`
- `contracts/Bag.sol` (`recordVersion`)
- `lib/domain/basket-protocol/version.ts`
- `docs/EXECUTION_CANDIDATE_DESIGN.md`
- `docs/ROADMAP.md` (Rebalancing)

**Security risks:**
- **Oracle manipulation**, the main risk. A Dutch auction bounds it but does not remove it.
- Griefing with tiny auctions; needs a minimum size.
- Stock Token halts and market hours: Robinhood Chain Stock Token liquidity outside market hours is thin.
- Reentrancy through solver callbacks.
- New tokens entering the vault: allowlist, fee-on-transfer and rebasing tokens.

**Open questions:**
- Which oracle, per asset class?
- Who sets the per-auction bound?
- Can an IMMUTABLE Bag rebalance only for drift and never to a new composition?
- How are holders protected from a composition they did not choose? A redeem window before a version change?

**Size.** L.

---

## 3. On-chain performance record

**Problem.** A strategy's track record lives in BAG's database (NAV history, receipts). A third party has to trust BAG for it.

**Mechanism:**
- **Periodic NAV snapshots or a Merkle root on `StrategyRegistry.sol`:**
  - `publishPerformance(strategyId, version, periodEnd, navPerShare, root)`;
  - `root` commits to that period's per-day NAV points and execution receipts.
- **Who publishes:**
  - **Option A:** the creator (user-signed, like registry versions). Cheap, but the creator grades their own work.
  - **Option B:** a set of independent publishers, each signing.
- **How it is verified:** recompute from public data, or prove from the vault directly.
  - For a vault Bag, `holdings` and `totalSupply` are on chain. NAV per share is then recomputable from holdings × prices at a block, so the claim is checkable whatever the price source.
  - Receipts are checkable against transaction hashes.
- **Preventing false claims:**
  - Only claims recomputable from on-chain state and a named price source are published.
  - A challenge window: anyone can post a counter-proof (block, prices, recomputation) and the claim is marked disputed.
  - No slashing in a first version.

**BagVault dependency.** Soft. It works for wallet-held Bags via receipts, but NAV is only trustless for vault Bags.

**Related code:**
- `contracts/StrategyRegistry.sol`
- `docs/STRATEGY_REGISTRY_DESIGN.md`
- `lib/server/execution-receipts.ts`
- `lib/domain/basket-protocol/nav/*`
- `packages/bag-sdk` (verifier)

**Security risks:**
- Price-source choice decides what "performance" means.
- Unchallenged false claims if nobody watches.
- Registry storage growth; mitigate with roots plus off-chain data.

**Open questions:**
- Creator-published or neutral?
- Daily or per-version granularity?
- Where is the data behind the root hosted (IPFS, the API)?

**Size.** M. A challenge mechanism adds M.

---

## 4. Stock Token events

**Problem.** Stock Tokens follow the underlying stock's market. The vault must behave correctly around halts, splits and dividends.

**What the repo already knows** (from the Robinhood Stock Token API integration, `docs/ROBINHOOD_PRICE_AUTHORITY.md` and `lib/domain/basket-protocol/pricing/robinhood-stock-api.ts`, which cite docs.robinhood.com). I could not re-fetch docs.robinhood.com today, so treat these as **repo-verified, not re-verified**:
- Each Stock Token is an ERC-20 with 18 decimals.
- One token stands for `currentMultiplier` underlying shares. The same number on chain is `uiMultiplier() / 1e18`.
- Dividends are reinvested and splits are applied by **changing the multiplier, not the token balance**. `balanceOf` does not rebase.
- The registry reports `pendingMultiplier` and `pendingMultiplierEffectiveTime` for a queued corporate action.
- `tradingCapabilities` gives, per session (`market` / `extended` / `overnight`), whether `whole` and `fractional` trading are allowed. BAG requires fractional trading in some session (`isFractionallyTradable`, `lib/server/stock-token-guard.ts`).
- A quote with `isTradingHalt: true` becomes `MARKET_CLOSED_OR_HALTED`, and pricing fails closed.

**Not verified** (from a web search summary of Chainlink's Robinhood tokenized-equity feed docs, not read directly):
- The token has `updateMultiplier(uint256)` (immediate) and `updateMultiplier(uint256, uint256 effectiveAt)` (scheduled) functions.
- Large multiplier changes such as splits use a scheduled pause window.
- The token exposes an `oraclePaused()` flag.
- Whether the token's **transfers** can be paused during that window (which would stop vault mint/redeem for that component) is unknown.

Also **not verified**: Robinhood's EU support pages describe cash dividend payments for EU Stock Tokens. That may be a different product from the Robinhood Chain tokens, so the repo's "reinvested into the multiplier" rule is the one this design assumes.

**Mechanism:**
- **In-kind mint/redeem needs no price**, so halts and closures do not technically block the vault. Should mint still pause while a component is halted, so nobody mints against a stale basket? Recommendation: no pause for in-kind mint/redeem. Any feature that prices (§1 performance fee, §2 rebalance, §5 hook) must check halt status, `oraclePaused()` and staleness, and refuse.
- **Splits and dividends need no action from the vault.** Because the multiplier, not the balance, changes:
  - the vault's internal holdings stay correct;
  - each share's claim in underlying shares grows automatically.

  This is exactly why rebasing tokens are excluded and multiplier tokens are fine. It must be confirmed against the token contract before an audit.
- **Pause windows.** If a token pauses transfers, redeem reverts for the whole basket during the window. Options: accept it as a temporary pause and document it, or allow a partial redeem that skips the paused component (`docs/BAG_VAULT_DESIGN.md` §9.5).

**BagVault dependency.** Hard for the vault-specific parts; the price-side checks already exist off-chain.

**Related code:**
- `lib/server/stock-token-guard.ts`
- `lib/domain/basket-protocol/pricing/robinhood-stock-api.ts`
- `lib/domain/basket-protocol/pricing/provider.ts` (`MARKET_CLOSED_OR_HALTED`)
- `lib/server/asset-repo.ts` (`updateAssetMultiplier`)
- `lib/domain/basket-protocol/registry/robinhood-import.ts`

**Security risks:**
- A token-level pause or blocklist (issuer control) can stop redemptions.
- Mispricing around the multiplier's effective time, for anything that prices.
- Delisting or redeployment of a token contract (the registry already guards purchases; a vault would hold the old contract).

**Open questions:**
- Confirm the token's pause and multiplier functions from the contract source.
- Delisting policy for a vault component.
- Does Robinhood allow contracts (not EOAs) to hold Stock Tokens, and are there transfer restrictions? Not verified.

**Size.** S for the doc and guards, M if a partial redeem is added.

---

## 5. Uniswap v4 hook with NAV-aware liquidity

**Problem.** A transferable vault share needs a market. Without one, entering or leaving requires holding every component.

**Mechanism:**
- **A v4 pool** of share/USDG with a hook that biases fees toward NAV:
  - low fees for trades moving the pool price toward NAV per share;
  - high fees for trades moving it away;
  - or a dynamic fee by distance from NAV.
- **NAV source:** vault holdings × component prices.
- **Arbitrage keeps the price near NAV without the hook trusting the price fully:**
  - pool below NAV → buy shares, `redeem` in kind, sell the components;
  - pool above NAV → buy components, `mint`, sell shares.

  In-kind mint/redeem is what makes this arbitrage possible. The hook only shapes fees.

**BagVault dependency.** Hard.

**Related code:**
- `lib/config/robinhood-chain.ts` (Uniswap addresses on Robinhood Chain)
- `lib/blockchain/robinhood-uniswap-quoter.ts`

Is Uniswap v4 deployed on Robinhood Chain? **Not verified**; the repo only references v3 and the Universal Router.

**Security risks:**
- **Oracle dependency in the hook.** A manipulated price sets the wrong fees but cannot move vault assets: the hook never touches the vault.
- v4 hook bugs (custom accounting, reentrancy into the pool manager).
- Thin component liquidity outside US market hours makes arbitrage slow.

**Open questions:**
- Is a plain v3/v4 pool without a hook enough, given arbitrage?
- Who seeds liquidity?
- Is v4 available on Robinhood Chain?

**Size.** L (custom hook plus audit).

---

## 6. Non-custodial DCA with smart accounts

**Problem.** Smart DCA (ROADMAP) needs recurring purchases without the user signing each one and without BAG holding funds or keys.

**Mechanism:**
- **Session key.** An ERC-4337 account with an ERC-7579 session-key module, limited to what the user signs:
  - which Bag (strategy id + `definitionHash`);
  - input token and amount per run;
  - frequency;
  - max slippage and price impact;
  - expiry and a total cap.
- **Keeper.** At each interval, a permissionless keeper submits a user operation:
  - built with `compileBag` (SDK, unsigned Composer transaction);
  - the module checks the limits on chain (target = Composer, amount, frequency) before executing.
- **No custody.** Assets land in the user's account. The keeper only pays gas and gets a fee or refund.
- **With BagVault:** the session could mint vault shares in kind after the swap.
- **Relation to the ROADMAP:**
  - "Smart DCA" and "Smart-account execution";
  - EIP-5792 batching, already used for approval + execute (`hooks/use-redeem-execution.ts`, `lib/blockchain/wallet-sweep-client.ts`);
  - Permit2 (`PERMIT2_ADDRESS` in `lib/config/robinhood-chain.ts`) to cut approvals.

  A session key is the next step: one signature for many runs.

**BagVault dependency.** None for buying into the wallet. Optional for minting shares.

**Related code:**
- `packages/bag-sdk` (`compileBag`, `simulateBag`)
- `lib/wallet-context.tsx`
- `hooks/use-redeem-execution.ts`
- `docs/ROADMAP.md`

**Security risks:**
- Session-key module bugs.
- Over-broad permissions (any calldata to Composer could route output elsewhere): the module must bind the recipient to the user's account.
- Keeper MEV and sandwiching (bounded by slippage).
- Smart-account support in user wallets.

**Open questions:**
- Which 4337/7579 stack? Is a bundler and entry point available on Robinhood Chain? Not verified.
- Can the Composer calldata recipient be checked by the module?
- Is the keeper fee in the input token or in ETH?

**Size.** L.

---

## 7. Proposed order and dependencies

```
Native ETH purchase ──▶ BagVault (audit #1)
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
   Management fee (§1, audit #2)   Performance record (§3)
               │                             │
               └──────────────┬──────────────┘
                              ▼
   ┌───────────────┬──────────┴──────────┬───────────────┐
   ▼               ▼                     ▼               ▼
 Rebalance     v4 NAV hook          Performance       DCA (§6)
 auction (§2)  (§5)                 fee + HWM (§1)    (independent of the vault
 (audit #3)    (audit #4)           (oracle decision) for wallet buys)
```

1. **Native ETH purchase.** In progress on its own branch; small, no new contracts.
2. **BagVault.** Resolve `docs/BAG_VAULT_DESIGN.md` §9 first: component binding, token allowlist, guardian. **Audit #1.**
3. **Management fee (§1)** and **performance record (§3).** Neither needs a price oracle on chain. **Audit #2** for the fee.
4. **Oracle decision.** It gates §1 performance fee, §2 rebalance and §5 hook. Pick it once, for all three.
5. **Rebalance (§2), v4 hook (§5), DCA (§6).** In parallel. **Audits #3 and #4** for rebalance and the hook. DCA can start earlier for wallet purchases, since it does not need the vault.

§4 (Stock Token events) is a set of checks every step above must include, not a separate step.
