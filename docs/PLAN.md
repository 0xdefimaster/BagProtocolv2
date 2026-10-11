# BAG Protocol: plan to an investable product

Living document. Owner of each line: **C** = code (Claude, in this repo), **O** = owner (live
transactions, keys, accounts, money, legal, users). Status reflects `main`; update it in the PR that
changes it.

## Thesis

BAG is not "a vault platform". It joins, in one verifiable system, the full life of an investment
strategy:

create → test → publish → get invested → execute on-chain → produce verifiable results → pay its creator

Copying Glider (automation), SoSoValue (strategy discovery and research) or Enzyme (vault accounting)
does not differentiate us. The defensible part is the link between a strategy's public definition, its
real execution, its verified results and its creator's income: a strategy GitHub with real investment
infrastructure.

## What we take, and what we add

| Area | Take from | BAG's addition |
|---|---|---|
| Automation | Glider: templates, target weights, scheduled/threshold rebalancing, spend limits, kill switch | Run a creator's published strategy in the investor's own account, under a scoped, revocable permission (assets, routes, amounts, expiry) |
| Discovery & research | SoSoValue: no-code index builder, methodology page, backtest, benchmark | Keep simulated and live results strictly apart; live results tied to positions, forks and creator income |
| Vault & accounting | Enzyme: shares, NAV, fees (HWM, hurdle), access control, emergency stop | Same accountability in a simple retail flow; a narrow, audited core before any breadth |
| Creator economy | Strategy publishing | Versioning, fork lineage, reputation, verified income |
| Proof | Market data | Per-transaction record, real balances, net return after fees, gas and slippage |
| Execution | Automated execution | Route search (LI.FI Composer), pre-trade simulation, cost and slippage limits, controlled fallback |

This is positioning from public product documentation, not a full feature comparison and not a claim
that BAG already does all of it.

## Architecture

- **Strategy Marketplace**: discover, compare, create, follow.
- **Strategy Lab**: rules, backtest, versions, risk analysis.
- **Fork Graph**: parent strategy, forks, diffs, creator relationships.
- **Execution Engine**: routing, simulation, cost and slippage controls.
- **BAG Vault** (later, see Vault plan): shares, NAV, fees, deposits and withdrawals.
- **Verified Results & Creator Economics**: real performance, investor positions, creator payments,
  auditable history.

## Status against the plan (main)

| Capability | Status | Where |
|---|---|---|
| Strategy identity, versions, diff, passport, fork lineage, bag.json v1 | Done | `lib/domain/basket-protocol/*`, `docs/BAG_JSON_V1_DESIGN.md` |
| On-chain strategy registry, creator-signed; browser verification; SDK | Done | StrategyRegistry (Robinhood), `packages/bag-sdk` |
| Execution: LI.FI Composer, simulation, slippage / min-out / price-impact guards, allowlists | Done | `lib/blockchain/lifi-composer-adapter.ts` |
| Wallet batches (EIP-5792 / EIP-7702) recognised and booked | Done | `lib/blockchain/composer-status.ts` |
| Accounting: immutable ledger, average cost, realized P&L from verified proceeds, holdings-based valuation | Done | `docs/ACCOUNTING_V2_DESIGN.md` |
| Wallet reconciliation (external outflows) | Done, does not scale (20 wallets / 5 min) | `lib/server/wallet-reconciliation.ts` |
| Performance fee with HWM and loss carry, settled on-chain (RedeemSettlement) | Built; **positive fee not yet proven live** | `docs/FEE_ECONOMICS_DESIGN.md` |
| Fork royalty accounting and creator rewards vault | Built; **withdrawal not yet proven live end to end** | `docs/CREATOR_REWARDS_SETTLEMENT.md` |
| Leaderboard on live Bags, NAV every 5 minutes | Done | `lib/domain/leaderboard`, `lib/server/nav-snapshot-sweep.ts` |
| Rebalance preview and live quote | Done (no execution) | `lib/server/rebalance-*.ts` |
| Rebalance execution (user-signed) | Missing | — |
| TVL verified against on-chain balances | Missing | — |
| Public proof page | Missing | — |
| Backtest and benchmark | Missing | — |
| Discovery: tags, risk level, watchlist | Missing | — |
| Scoped automation permission | Missing | — |
| Pilot vault | Spike only (`feat/bag-vault-spike`), not deployed | `docs/BAGVAULT_DESIGN.md` |

## Phase 1 (days 0–30): a trustworthy core

1. **C+O** Prove the money flows live: a second wallet buys a fee-paying Bag, sells at a profit, the
   performance fee is settled on-chain, the creator and a fork parent withdraw. Checklist and a
   read-only verification script from **C**; transactions from **O**.
2. **C** TVL verified on-chain: each holder counts at most what their wallet holds; freshness shown.
3. **C** Reconciliation that scales: Transfer logs per tracked token, balances re-read only for wallets
   that moved.
4. **C** Public proof page: verified TVL, net returns, fees paid, execution success rate, each linked
   to transactions.
5. **O** Production readiness: CI billing, `CRON_SECRET`, Alchemy webhook, LI.FI key rotation,
   Supabase backups, production domain on V2.
6. **C+O** Pick one vault model and a narrow asset scope (decision recorded below).

## Phase 2 (days 31–60): a narrow pilot

- **C** Strategy Lab: backtest with a documented price source, benchmark comparison.
- **C** Discovery: tags, risk level, watchlist, version diff from the strategy page.
- **C** User-signed rebalance execution (R3). **O** applies the migration.
- **C** Pilot vault code and tests (ERC-4626 shares, NAV with stale-price checks, HWM fee, allowlisted
  assets and routes, no arbitrary transfers by the manager, pause). **O** independent security review
  before outside capital; low caps until then.
- Measure: execution failures, cost deviation, NAV freshness, user errors.

## Phase 3 (days 61–90): demand and income

- **O** Closed pilot with outside creators and investors.
- **C** Metrics: active investors and creators, repeat investment, net inflow, TVL per strategy,
  retention, execution success, withdrawal time, creator income, security incidents. Losing strategies
  stay visible.
- **C** Live net return vs benchmark; creator income with transaction proofs.
- **C+O** Investor deck from those numbers.

## Vault plan

- **A. Self-custodial strategy accounts** (today's model): each investor holds their own assets;
  strategy rules drive execution. Not a pooled fund.
- **B. One pilot vault**: pooled capital with verifiable shares and NAV; narrow assets, routes, caps and
  fees.
- **C. Several strategies and creators**: only after B works end to end; each strategy's assets and
  performance tracked separately.

Self-custodial accounts and pooled vaults are not forced into one accounting model: they describe
ownership and risk differently.

Minimum for the first vault: allowlisted tokens and routes only; the manager cannot send investor
capital elsewhere; price source, timestamp and staleness checks in NAV; consistent share math for
deposits and withdrawals; correct HWM or equivalent; emergency stop; contract tests, independent review,
small caps; investors see balance, realized P&L, fees and withdrawal status.

Later, the same vault behind the SDK for other apps (BAG as infrastructure provider).

## Proof an investor should see

| Proof | Shows |
|---|---|
| On-chain verified TVL | Real, correctly classified assets, not database rows |
| Net performance | After fees, gas, slippage |
| Benchmarks | Each strategy against a fitting benchmark |
| Deposit → trade → withdraw | Works with real funds |
| Creator income | Creators are paid and withdraw under the rules |
| Retention | People come back |
| Security | Tests, independent review, permission limits, incident plan |

TVL methodology must separate new capital, price movement and realized gains, and never count one wallet
balance in two strategies.

## Risk: Robinhood Stock Tokens

Stock Tokens give no direct legal or beneficial ownership of the underlying shares and are restricted in
some jurisdictions. A contract being able to hold them does not make offering them in a pooled vault
lawful. **O**: specialist legal review (who may invest where, fee model, pooled capital) before an
investor presentation; follow Robinhood's terminology and terms in all communication.

## Decisions

| Date | Decision |
|---|---|
| — | Vault model for the pilot: _open_ |
| — | Asset scope for the pilot: _open_ |
