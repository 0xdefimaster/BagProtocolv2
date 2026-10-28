# Bag Protocol

Bag Protocol lets anyone publish an investment strategy (a "Bag": a set of
tokenized stocks and crypto assets with target weights) and lets anyone buy or
sell it from their own wallet in one transaction. Strategies are described by
an open format, `bag.json`, and can be registered on-chain so a third party can
verify a strategy without trusting this app.

Assets never leave the user's wallet: buying a Bag swaps into its assets, and
selling swaps them back. There is no vault or pool. The server prepares unsigned
transactions and verifies receipts on-chain; it never signs for a user.

## Features

- **Create and deploy a Bag** on Robinhood Chain (`BagFactory`), signed by the
  creator's wallet, with an optional first buy.
- **Buy a Bag** with ETH or a stablecoin: every asset in one LI.FI Composer
  transaction, with per-swap minimum output and a whole-flow price-impact limit.
- **Sell a Bag** by fraction into a stablecoin (USDG): one transaction where
  possible, per-asset swaps otherwise.
- **Swap page**: multi-buy and multi-sell of wallet tokens on Robinhood Chain,
  Ethereum, Arbitrum and Base.
- **Rebalance** a position back to the Bag's weights (user-signed).
- **Versions, forks and on-chain registry**: each version's `bag.json` hash can
  be committed to `StrategyRegistry`; forks record their parent.
- **Accounting**: positions, cost basis and realized P&L come from verified
  transaction receipts, not from quotes.
- **Performance fees and fork royalties** computed and paid on-chain at sale
  through `RedeemSettlement` (Robinhood Chain); a fee-paying sale has not yet
  been run live (see docs/STATUS.md).
- **Smart-account wallets** (MetaMask EIP-7702): transactions routed through the
  wallet's DelegationManager are verified like direct ones.
- **Read-only MCP server** and a standalone SDK (`packages/bag-sdk`) for
  `bag.json` parsing, validation, hashing and registry verification.

## Stack

Next.js (App Router) · TypeScript · Supabase (PostgreSQL) · viem · LI.FI SDK and
Composer SDK 0.6 · Solidity (Hardhat) · Vitest · hosted on Netlify.

## Repository layout

```
app/                Next.js pages (landing, /dashboard/*) and API routes (app/api/*)
components/         UI, grouped by feature
hooks/              Client flows (purchase, redeem, deploy, registration, ...)
lib/
  domain/           Pure domain logic (allocation, validation, bag.json) — no I/O
  server/           Server-side flows and Supabase repositories
  blockchain/       Chain clients, LI.FI / Composer adapters, on-chain verifiers
  execution/        Provider compiler (see lib/execution/README.md)
  config/           Chains, tokens and contract addresses (single source)
contracts/          Solidity: BagFactory, Bag, StrategyRegistry, RedeemSettlement,
                    RedeemFeeRouter, BagExecutionRouter, CreatorRewardsVault (+ tests)
packages/bag-sdk/   Standalone SDK for bag.json and registry verification
supabase/           Schema and numbered migrations
scripts/            Deploy, import and diagnostic scripts (read-only unless noted)
docs/               Design docs; docs/STATUS.md says what is current and live
```

## Getting started

Requirements: **Node.js 24+** (`.nvmrc`; the Composer SDK requires it) and, for
integration tests, PostgreSQL 14+.

```bash
npm install
cp .env.example .env.local   # fill in Supabase, RPC and LI.FI settings
npm run dev                  # http://localhost:3000
```

Without Supabase the landing page renders, and data routes answer `503`.
`.env.example` documents every variable; deployment and contract addresses are
read from the environment and fail closed when missing. Never put real private
keys in the repository.

A step-by-step local setup (Turkish) is in
[docs/VSCODE_LOCAL_SETUP.md](docs/VSCODE_LOCAL_SETUP.md).

## Checks

```bash
npm run lint
npm run typecheck
npm test                     # unit tests
npm run test:integration     # needs TEST_DATABASE_URL (real PostgreSQL + local EVM)
npm run test:contracts       # Hardhat
```

CI runs the same checks plus a secret scan (`.github/workflows/`).

## Documentation

- [docs/STATUS.md](docs/STATUS.md) — what is live, what is verified, and which
  document is current
- [docs/ROADMAP.md](docs/ROADMAP.md) — direction
- [docs/BAG_JSON_V1_DESIGN.md](docs/BAG_JSON_V1_DESIGN.md) — the `bag.json` format
- [docs/USER_SIGNED_DEPLOYMENT.md](docs/USER_SIGNED_DEPLOYMENT.md) — deploy flow
- [docs/PRICE_AND_DATA_LAYER.md](docs/PRICE_AND_DATA_LAYER.md) — chains, assets, prices
- [docs/archive/](docs/archive/) — historical phase and audit reports

## License

See [LICENSE](LICENSE).
