# Demo readiness

What is true today, stated by evidence level. "Verified in code" means
implemented in this repository **and** exercised by its tests, against a
local Hardhat EVM and a real PostgreSQL. It does not mean deployed, and it
does not mean audited by a third party.

Index of every document by status (CURRENT / LEGACY / SPIKE / NOT IMPLEMENTED /
HISTORICAL): **[docs/STATUS.md](docs/STATUS.md)**.

> ## ⚠️ DO NOT PUT REAL PRIVATE KEYS IN THE REPOSITORY
> Keys (`DEPLOYER_PRIVATE_KEY`, `BAG_ROUTER_PLAN_SIGNER_KEY`, the settlement
> and attestor keys, any E2E wallet key) belong only in `.env.local` or your
> host's secret store. `.env*.local` is git-ignored. `.env.example` must only
> ever contain placeholders. Use throwaway wallets for deployment and E2E
> tests.

---

## Verified in code (implemented + tested here)

| Area | Where | Evidence |
|---|---|---|
| Bag creation, versioning, forking | `lib/server/bag-repo.ts`, `create_bag_*` RPCs | unit + integration tests |
| User-signed on-chain deployment (`BagFactory.createBag`, receipt verification, atomic confirm) | `lib/server/deploy-bag.ts`, `lib/blockchain/evm/adapter.ts`, migration 0025 | `bag-deployment-*.integration.test.ts` (local EVM, concurrency) |
| Provider abstraction (BAG Router → LI.FI Composer → LI.FI sequential) | `lib/execution/` | compiler / provider tests |
| BAG Router contract (allowlists, delta-based output checks, no owner sweep) | `contracts/BagExecutionRouter.sol` | Hardhat contract tests |
| EIP-712 signed execution plan | `bag-router-provider.ts`, `bag-execution-router-signer.ts` | provider + contract tests |
| Multi-chain data layer: one chain config, resilient RPC (Alchemy → secondary → public, circuit breaker, hash-checked tx broadcast), LI.FI crypto prices, Robinhood Stock Token API (identity, per-token multiplier, corporate actions, trading capabilities), unified `BagAsset` | `lib/config/chains.ts`, `lib/blockchain/rpc/`, `lifi-token-data.ts`, `pricing/bag-price-router.ts`, `robinhood-stock-api.ts`, `bag-asset-service.ts` | `resilient-rpc.test.ts`, `endpoints.test.ts`, `lifi-token-data.test.ts`, `robinhood-stock-api.test.ts` (live-capture fixtures), `bag-price-router.test.ts` (mixed multi-chain NAV), `bag-asset-service.test.ts` |
| Candidate comparison (quoted vs guaranteed-minimum output, like-for-like ranking only) | `candidate-*.ts` | `candidate-output-semantics.test.ts` and others |
| Fallback when a provider is ineligible or fails | `compiler.ts` | compiler tests |
| Wallet execution (user signs in the browser; the server never signs) | `hooks/use-purchase-execution.ts`, `use-deploy-bag.ts` | hook tests |
| On-chain verification before accounting (receipts, events, received amounts vs `minOutputRaw`) | `purchase-execution.ts`, `bag-router-status.ts` | unit tests |
| Accounting (shares, holdings, cost basis, fees; idempotent, fail-closed guards) | migrations 0033–0036 | `protocol-economics.integration.test.ts` (20 scenarios) |
| Performance fee locked after the first external investment (database-enforced) | migration 0033 | `performance-fee-lock.integration.test.ts` |
| Mutable Bag on-chain version path (creator-signed, compare-and-swap, event-verified) | `BagFactory.recordBagVersion`, `bag-versioning.ts`, migration 0035 | `bag-versioning-local-evm.integration.test.ts` + contract tests |
| Homepage accessibility and responsive behavior | `components/layout`, `components/landing` | `landing-a11y.test.tsx`, `Header.test.tsx`, `scripts/responsive-check.mjs` (real Chromium, 6 viewports, axe incl. contrast) |

## Verified live (Robinhood Chain, V2 test site, 2026-10-05)

Observed with a real wallet on bagprotocolv2.netlify.app (its own Supabase
project and Netlify site; the V1 demo is separate). Details: `docs/STATUS.md` §1.

| Item | Evidence |
|---|---|
| Supabase with `supabase/schema.sql` | Applied; RLS on every table |
| `BagFactory` + user-signed `createBag` | A Bag deployed and confirmed from the real receipt (on-chain version 1) |
| Asset registry | 4 crypto + 194 Robinhood Stock Tokens imported |
| RPC, LI.FI quotes | Working |
| Purchase in one LI.FI Composer transaction | $5 into 4 stocks; every output read from the tx receipt and above its on-chain minimum; version binding checked |
| Redeem a fraction in one LI.FI Composer transaction | 50% sale into USDG; Bag TVL halved |

Not covered by the live run: the provider compiler (flag off: the live purchase
used the legacy path), the BAG Router (not deployed, and kept disabled — see
`docs/STATUS.md` §3), fee-taking redemptions, `StrategyRegistry` (not deployed),
and the price authority's guard checks against live data.

## Requires a live environment (not verifiable from this repository)

| Item | Status |
|---|---|
| Deployed `BagFactory` (Robinhood Chain) | **Deployed and used live** (see above). `scripts/deploy-bag-factory.ts robinhood` for a new environment. |
| Deployed `BagExecutionRouter` | **Not deployed, deliberately**: stays disabled until the plan-signer trust model is resolved (`docs/STATUS.md` §3). `scripts/deploy-bag-execution-router.ts` |
| Deployed `StrategyRegistry` | **Not deployed.** `scripts/deploy-strategy-registry.ts robinhood`, then `STRATEGY_REGISTRY_ADDRESS_ROBINHOOD` |
| Router allowlists (targets, tokens) | Set by the router deploy script and `scripts/sync-router-token-allowlist.ts` |
| Plan signer configuration | `BAG_ROUTER_PLAN_SIGNER_KEY` must match the router's on-chain `planSigner` |
| Real RPC | `ALCHEMY_API_KEY` (or `<CHAIN>_RPC_URL`) as primary, optional `<CHAIN>_RPC_URL_SECONDARY`, operator public RPC last (none for Ethereum). **Not reachable from the development sandbox.** |
| Real asset registry | Imported on the V2 test site; `scripts/import-robinhood-assets.ts --apply` for a new environment |
| Real liquidity | Uniswap v3 pools for each Bag asset vs the input token; never exercised live |
| LI.FI API / network | **Working live** (quotes, Composer purchase and redeem). Blocked from the development sandbox. |
| Real price sources | Stock Tokens: Robinhood `/rhj/prices` mid × `currentMultiplier` (no config), verified by Chainlink when `ROBINHOOD_CHAINLINK_FEEDS` is set. Crypto on all chains: LI.FI `priceUSD`; TWAP (`ROBINHOOD_PRICE_POOLS`) / CoinGecko only on a LI.FI data gap. **Not verified live**: Robinhood, LI.FI and RPC hosts are blocked from the sandbox (`scripts/verify-robinhood-stock-api.ts`, `scripts/verify-robinhood-price.ts`). |
| Supabase project | V2 test site: `schema.sql` applied (all migrations). Existing projects: apply `supabase/migrations/` in order |
| `public/` static assets | `logo.png`, `logo-full.png`, `hero/glass-mark.png` are in the repository (from the `landing-update` branch). |

## Not yet production-ready

This list was requested as "not built". The first three rows are built and
tested here. They are still not production-ready until the conditions in the
last column hold.

| Item | Actual state | What production needs |
|---|---|---|
| Performance fee immutability | **Implemented + tested** (database triggers, migration 0033) | Migration applied; independent review |
| Mutable Bag on-chain version path | **Implemented + tested** (contracts, server, migration 0035). No version-editing UI yet. | Factory (re)deployed; UI; live test |
| Full economic audit | **Internal invariant audit done**: 6 violations fixed (migration 0036, `shares.ts`); Accounting V2 (0048–0051) values positions from wallet holdings, not shares; see `docs/PROTOCOL_ECONOMICS.md` | Independent third-party audit; redemption fee on actual proceeds instead of the quote |
| Rescue policy | **Decided, not implemented** (ADR-2). Unrestricted sweep rejected. Finding recorded: leftover input is returned by absolute balance. | Apply the delta fix at the next router redeploy; optional constrained recovery |
| Second aggregator | **Not built** (ADR-1) | A new `BagExecutionProvider` |
| One Bag spanning several chains | **Not built.** A Bag is one contract on one chain; valuation is multi-chain, execution is single-chain (`docs/PRICE_AND_DATA_LAYER.md`). | Cross-chain execution design (bridging legs, custody, partial failure) |
| Full on-chain reward settlement | **Not built** (ADR-3). Rewards are ledger-recorded and settled to `CreatorRewardsVault` by a worker; router-path fees are settled on-chain. | On-chain NAV and cost basis, or accept the hybrid model |
| Performance history | **NAV snapshots recorded** (migrations 0044–0045); per-version performance on the History tab | Enough recorded history; a strategy performance index (planned A6) |

---

## Environment

- **Node.js ≥ 24** (`engines`, `.nvmrc`, CI). Required by `@lifi/composer-sdk@0.5.0`. Node 22 is unsupported.
- **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, plus `SESSION_SECRET` and `CRON_SECRET`. Fresh project: run `supabase/schema.sql`. Existing project: apply `supabase/migrations/` in order.
- **RPC and contracts (Robinhood):**
  - `ALCHEMY_API_KEY` or `ROBINHOOD_RPC_URL` (+ optional `ROBINHOOD_RPC_URL_SECONDARY`)
  - `FACTORY_ADDRESS_ROBINHOOD`, `CONFIRMATIONS_ROBINHOOD`
  - Provider compiler / BAG Router: `BAG_EXECUTION_COMPILER_ENABLED`, `BAG_EXECUTION_ROUTER_ADDRESS`, `BAG_ROUTER_PLAN_SIGNER_KEY` — **leave the router unset** for now (`docs/STATUS.md` §3)
  - `STRATEGY_REGISTRY_ADDRESS_ROBINHOOD` once the registry is deployed
  - `REDEEM_FEE_ROUTER_ADDRESS`, `CREATOR_REWARDS_VAULT_ADDRESS` (+ their deploy and settlement keys)
- **Pricing:** Robinhood Stock Tokens need nothing (Robinhood's keyless API); optional `ROBINHOOD_CHAINLINK_FEEDS`. Crypto: LI.FI (`LIFI_API_KEY` for rate limits); fallbacks `ROBINHOOD_PRICE_POOLS`, `CRYPTO_PRICE_FALLBACK=coingecko` + `COINGECKO_API_KEY`. See `docs/PRICE_AND_DATA_LAYER.md`. `PRICE_PROVIDER=mock` is refused in production.
- **LI.FI:** `LIFI_API_KEY` (required for Composer), `LIFI_INTEGRATOR`.
- **Other chains:** RPC via `ALCHEMY_API_KEY` or `<CHAIN>_RPC_URL`, plus `FACTORY_ADDRESS_<CHAIN>` for ethereum, base and arbitrum.
- Full, commented list: `.env.example`. Step-by-step local setup (Turkish): `docs/VSCODE_LOCAL_SETUP.md`.

### Build and test commands

```bash
node -v                          # v24.x
npm ci
npx tsc --noEmit
npm run lint
npm test                         # unit
TEST_DATABASE_URL=postgres://… npm run test:integration   # real PostgreSQL 14+
npm run test:contracts           # Hardhat
npm run build
# optional real-browser check (needs a running build + Chromium + playwright-core):
NODE_PATH=<dir with playwright-core> BASE_URL=http://localhost:3100 CHROMIUM_PATH=<chrome> node scripts/responsive-check.mjs
```

### Verified (last run: fresh clone, Node 24.21.0, clean `npm ci`)

| Command | Result |
|---|---|
| `node -v` | v24.21.0 |
| `npm ci` | exit 0, 0 `EBADENGINE` warnings |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 (no errors) |
| `npm test` | 93 files, **1144 tests passed** |
| `npm run test:integration` (PostgreSQL 16 + in-process Hardhat) | 8 files, **139 tests passed** |
| `npm run test:contracts` | **95 passing** |
| `npm run build` | exit 0, compiled successfully |
| `scripts/responsive-check.mjs` (real Chromium; 1440×900, 1280×800, 1024×768, 768×1024, 390×844, 375×667; sample-data and no-database states) | **12/12 passed**: no overflow or clipping, targets ≥ 24px, menu keyboard behavior, axe WCAG 2.1 AA incl. color contrast |

Nothing in this table touches a live chain, a live RPC or a live API.
