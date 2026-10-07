# Bag Protocol

The marketing site + app for Bag Protocol — "the investment layer of the
internet." An open standard (`bag.json`) for portable, programmable investment
strategies.

## Structure

```
bag-protocol/
│
├── app/
│   ├── page.tsx              # Landing page
│   ├── layout.tsx            # Fonts + metadata
│   ├── dashboard/            # THE live app — Explore, Create, Bag detail,
│   │                         # Profile, Portfolio, Leaderboard, Inventory.
│   │                         # Wired to the real backend below; falls back
│   │                         # to lib/mock-data.ts only for a bag id the
│   │                         # backend doesn't know about (demo fixtures).
│   ├── api/
│   │   ├── bags/[id]/        # Bag CRUD, purchase-preview (+ LI.FI quotes)
│   │   ├── trades/           # Paper-trading endpoints
│   │   ├── portfolio/
│   │   ├── points/
│   │   ├── leaderboard/
│   │   └── auth/             # Wallet-login session (nonce/verify/session)
│   └── inventory-demo/       # Standalone character-builder/inventory demo
│
├── lib/
│   ├── domain/basket-protocol/  # Pure domain logic: NAV, shares, deposit
│   │                             # allocation, rebalance, validation — no
│   │                             # Supabase, no I/O, fully unit-testable
│   ├── server/                  # Repositories (Supabase-backed) + route
│   │                             # helpers (bag-repo, asset-repo, bag-nav,
│   │                             # purchase-preview, deploy-bag, ...)
│   ├── blockchain/              # Chain clients + read-only verifiers:
│   │                             # deploy/version adapters (evm/), BAG
│   │                             # Router status, LI.FI quote adapter. The
│   │                             # server never signs user transactions —
│   │                             # the user's wallet does, in the browser.
│   ├── execution/               # Provider abstraction + compiler (BAG
│   │                             # Router, LI.FI Composer, LI.FI sequential),
│   │                             # candidate comparison — see its README
│   ├── supabase/                # Browser + server (service-role) clients
│   └── *-store.ts               # Client-side React state (portfolio,
│                                 # activity, notifications, user bags, ...)
│
├── components/            # UI, grouped by feature (app, bags, trading,
│                           # creator, activity, inventory, character-builder,
│                           # landing, layout, leaderboard, collectibles, nft)
├── hooks/                 # Data-fetching hooks (useBag, useMyBags,
│                           # useBagNFTs, usePoints, useLeaderboard, ...)
├── types/                 # Shared TypeScript types (basket-protocol.ts is
│                           # the canonical domain model)
├── supabase/schema.sql    # Full DB schema
├── scripts/                # seed-bags.ts, seed-bag-holdings.ts,
│                           # seed-input-assets.ts — populate a real
│                           # Supabase project with working demo data.
│                           # import-robinhood-assets.ts — dry-run-by-default
│                           # importer that pulls Robinhood's live Stock
│                           # Token registry (chain id 4663) into the Asset
│                           # Registry; run with --apply to actually write
├── contracts/              # Solidity: BagFactory, Bag, BagExecutionRouter,
│                           # RedeemFeeRouter, CreatorRewardsVault (+ tests)
├── docs/                   # Point-in-time phase reports and feature notes
│                           # (not required reading to run the app)
└── public/                 # Static assets (logo.png, logo-full.png, hero/glass-mark.png)
                            # — NOT present in this repository snapshot; add
                            # them locally or those images render broken.
```

Current, evidence-based status of every part (what is verified in code,
what needs a live environment, what is not production-ready):
**[DEMO_READINESS.md](DEMO_READINESS.md)**. Which document is current, legacy,
a spike or historical: **[docs/STATUS.md](docs/STATUS.md)**. Product and infrastructure direction:
**[docs/ROADMAP.md](docs/ROADMAP.md)**.

Supported chains are Ethereum, Arbitrum, Base and Robinhood Chain (4663).
The data layer is described in
**[docs/PRICE_AND_DATA_LAYER.md](docs/PRICE_AND_DATA_LAYER.md)**. Each
provider is used for its own data:

- LI.FI: crypto tokens, prices and routes
- Robinhood's Stock Token API: Stock Token identity, bid/ask, multipliers and
  corporate actions
- Alchemy, with fallback RPCs: chain state and transactions

## Requirements

- **Node.js 24 or newer** (`package.json` `engines.node: ">=24"`, `.nvmrc`).
  This is not a preference: the production dependency
  `@lifi/composer-sdk@0.5.0` and its `@lifi/compose-spec@0.5.0` declare
  `engines.node: ">=24"`. Under Node 22, `npm install` prints `EBADENGINE`
  warnings for them — treat that as an unsupported runtime, not a green
  build. CI (`.github/workflows/ci.yml`) and the production runtime (Vercel
  reads `engines.node`) use the same major. With nvm: `nvm install && nvm use`.
- PostgreSQL 14+ for `npm run test:integration` (see `TEST_DATABASE_URL` in
  `docs/USER_SIGNED_DEPLOYMENT.md`).

## Getting started

1. **Install and run:**
   ```bash
   npm install
   npm run dev
   ```
   Open http://localhost:3000. The landing page and the `/dashboard/*` UI
   shell render fine with zero config — but any page that needs real data
   (a Bag's NAV, holdings, purchase preview, live LI.FI quotes, etc.) needs
   step 2.

2. **Connect a real backend** — copy `.env.example` to `.env.local` and fill
   in a Supabase project's URL + keys (`supabase/schema.sql` is the schema
   to apply). Without this, `isSupabaseConfigured()` is `false` and every
   `/api/bags/*` route returns `503`; `/dashboard/bag/[id]` then falls back
   to the hardcoded demo fixtures in `lib/mock-data.ts` — which look real
   but never touch the backend, and will never show a live LI.FI quote.

3. **Seed a real Bag** (once Supabase is connected) so there's something to
   click through end to end:
   ```bash
   tsx scripts/seed-input-assets.ts   # registers a VERIFIED input asset (e.g. USDC)
   tsx scripts/seed-bags.ts           # creates a Bag + published recipe
   tsx scripts/seed-bag-holdings.ts   # gives it real holdings for NAV to compute from
   ```
   `seed-bags.ts` refuses to fabricate on-chain addresses for the mock asset
   catalog — as shipped, `ASSET_ADDRESS_MAP` inside that script is **empty**,
   so every seeded bag will fail with `INVALID_ADDRESS` until you fill it in
   with real, verified addresses for the assets you want to seed (see the
   comment at the top of the script for why this is deliberate — guessed
   contract addresses were judged too risky to hardcode). This is the one
   remaining manual step between "backend connected" and "a clickable demo
   bag exists."

   Once a bag exists, visit `/dashboard/bag/<the-seeded-id>` and click
   **Invest Now** — the preview modal calls
   `POST /api/bags/:id/purchase-preview?quotes=true`, which computes the
   allocation for real and (optionally, if `LIFI_API_KEY` is set — it's
   optional) fetches a live LI.FI route quote per swap step.

4. **Optional: on-chain Bag deployment / LI.FI quotes** — see the
   Phase-4 and Phase-14 sections of `.env.example`. There is no mock
   fallback for deployment: without `RPC_URL_<CHAIN>` / `FACTORY_ADDRESS_<CHAIN>`
   the deploy endpoints fail closed (`CHAIN_UNAVAILABLE`). LI.FI quotes need
   network access to li.quest (`LIFI_API_KEY` optional for plain quotes,
   required for Composer).

5. **Optional: provider execution compiler** — `BAG_EXECUTION_COMPILER_ENABLED`
   (server-only, default off). OFF keeps the legacy purchase path; `true`
   routes purchases through the provider compiler (`lib/execution/`: BAG
   Router → LI.FI Composer → LI.FI sequential) and enables
   `/api/bags/[id]/purchase-options`. The BAG Router provider is only
   registered when the flag is on, `BAG_EXECUTION_ROUTER_ADDRESS` and
   `BAG_ROUTER_PLAN_SIGNER_KEY` are both set, and the Bag is a deployed
   Robinhood Chain Bag. Details: `.env.example` and `lib/execution/README.md`.

## Notes

- **Landing page** (`app/page.tsx`) is a faithful port of the original
  `bag-protocol-landing.html` design.
- The **"Launch Protocol" / "Launch App"** buttons point at `/dashboard`
  (`lib/constants.ts` → `APP_URL`) — that is the one, real app shell.
  There is no separate placeholder app tree anymore; an earlier
  `app/app/*` mock-only duplicate of the same pages was removed since it
  never called the backend and only caused confusion about which route was
  "the real one."
- The server never signs or sends a user's transaction. Purchases,
  redemptions, deployments and version updates are signed by the user's own
  wallet in the browser; the server prepares unsigned calldata and verifies
  receipts on-chain before any accounting. (`quoteExecutionPlan()` in
  `lib/blockchain/execution-adapter.ts` is still quote-only by design.)
- The homepage's Featured Bags / Hero read live data from `/api/bags`
  (Supabase, ACTIVE = deployed Bags only). There is no mock fallback on the
  homepage: without Supabase it says so, and the Hero shows a card clearly
  badged EXAMPLE. `lib/mock-data.ts` is used only inside the dashboard, for
  bag ids the backend doesn't know and when `NEXT_PUBLIC_DEMO_MODE=true`.
- No `favicon.ico` is included — drop one into `app/favicon.ico`.
