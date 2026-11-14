# Base staging end-to-end plan: create → register → buy → partial sell → full sell → portfolio

For `integration/base-app` deployed to a **staging** site (not production). Uses the existing Base contracts; nothing
is redeployed. Steps marked **[SIGN]** need a wallet signature and the owner's explicit approval at that moment;
everything else is read-only. Each run is recorded in `evidence/base-e2e/<date>.md` (public data only: transaction
hashes, contract addresses, amounts; no session cookies, emails, user ids or RPC URLs).

## 0. Preconditions (read-only)

| # | Check | Pass |
|---|---|---|
| 0.1 | Staging runs commit `ed6283e` or later of `integration/base-app` (or its merge), with F-01 merged first | commit shown in the deploy log |
| 0.2 | Staging env: `FACTORY_ADDRESS_BASE`, `STRATEGY_REGISTRY_ADDRESS_BASE`, `STRATEGY_COMPOSITIONS_ADDRESS_BASE`, `EXPLORER_URL_BASE`, `CONFIRMATIONS_BASE=1`, `BASE_RPC_URL` (+ secondary), `LIFI_API_KEY` | `GET /api/deploy/chains` → `deployable` contains `"base"` |
| 0.3 | Contracts unchanged | `npx tsx scripts/verify-chain-readiness.ts base` (or the recheck in `docs/chains/BASE_APP_INTEGRATION.md` §5): runtime hashes = 2026-11-08, factory owner/treasury/fee as recorded |
| 0.4 | Creation fee shown | `GET /api/deploy/creation-fee?chain=base` = 0.00015 ETH |
| 0.5 | Test wallet | one maintainer-controlled wallet, on Base: ≥ 0.002 ETH for gas and fee, ≥ 5 USDC. Prefer a plain EOA for the first run; repeat steps 3–5 with a MetaMask EIP-7702 account afterwards |
| 0.6 | Verified Base assets exist | the create page lists WETH, cbBTC (Base phase-1 reviewed set) for network Base only |

## 1. Create and deploy the BAG

1. UI: Create → network **Base** → assets WETH 60 %, cbBTC 40 % → performance fee **0 %** (a non-zero fee must be
   refused with `PERFORMANCE_FEE_UNSUPPORTED_CHAIN`: check this first, it is read-only) → save.
2. `POST /api/bags/[id]/deploy/prepare` returns the factory call: `to` = `0x9F66…df4a`, chain 8453, value = creation
   fee. Compare before signing.
3. **[SIGN]** `createBag` from the wallet.
4. `POST /api/bags/[id]/deploy/confirm` → deployed; the Bag address on Basescan is a `Bag` created by the factory
   in that transaction; the app shows the BAG on Base.

## 2. Register the strategy

1. `POST /api/bags/[id]/registry/prepare` → call to StrategyRegistry `0xcad8…5920` (and compositions `0x7D4A…4Fc8`).
2. **[SIGN]** registration transaction.
3. `POST /api/bags/[id]/registry/confirm` → registered; `GET /api/bags/[id]/registry` shows the on-chain record;
   the registered definition hash equals the app's.

## 3. Buy (two purchases)

For each: `POST /api/bags/[id]/purchase-preview`, `POST /api/bags/[id]/purchase-intent`,
`POST /api/purchase-intent/[intentId]/execute`, then the wallet signs, `…/step/[i]/report`, `…/verify`.

| Purchase | Input | Expect before signing | **[SIGN]** | Expect after |
|---|---|---|---|---|
| 3a | 2 USDC | one Composer transaction; `to` = the wallet's Composer proxy or the factory `0xaceb…bdae` (first use); one approval of USDC to the proxy for ≤ 2 USDC | approval (if any) + purchase | intent `COMPLETED`; `PURCHASE` ledger rows on chain `base`; holdings WETH and cbBTC > 0; deposit left the wallet in full (F-01 check) |
| 3b | 0.0005 ETH | value = 0.0005 ETH, no approval | purchase | same, native input |

With `BAG_SDK_COMPOSER_COMPILE=shadow` on staging, each purchase logs `[sdk-compile-shadow] chain=base … verdict=MATCH`.

## 4. Partial sale, then full sale

1. `POST /api/bags/[id]/redeem-preview` (50 %) → per-leg sell amounts read from **Base** balances.
2. `POST /api/bags/[id]/redeem-intent` → `POST /api/redeem-intent/[intentId]/execute`. Expect no settlement / fee
   path (fee 0 %, settlement is Robinhood-only). **[SIGN]** the sale transaction.
3. Verify → `COMPLETED`; proceeds measured on Base (USDC Transfer, or native balance delta for ETH output); position
   reduced by half; no `FEE_CHARGED` row.
4. Repeat at 100 % → position closed; wallet holds no WETH/cbBTC from this BAG.

Also check (read-only): a sale preview whose legs would mix chains is refused.

## 5. Portfolio and reconciliation

1. `GET /api/portfolio/positions`: the Base position valued from Base balances; a Robinhood position in the same
   wallet (if any) separate and unchanged.
2. `POST /api/users/me/reconcile`: Base balances read; freshness advances only when every chain read.
3. Outage simulation on staging only: point `BASE_RPC_URL` at an unreachable host, reconcile → Base balances
   **unknown**, never zero, global freshness not advanced; restore.

## 6. Exit criteria

All rows pass with transaction hashes recorded; no unexpected `VERIFICATION_FAILED`; ledger and on-chain amounts
agree. Only then may `docs/STATUS.md` mark Base "production-qualified in BAG App". Any failure: stop, keep Base
variables out of production, record the failing step.

## 7. Approvals this plan needs (none given yet)

1. Staging deploy of `integration/base-app` and its Base env.
2. Each **[SIGN]** step: create (fee + gas), registration, approval and two purchases, two sales. Estimated total
   value at risk: about 2 USDC + 0.0005 ETH plus fees and gas.
