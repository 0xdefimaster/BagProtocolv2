# Price authority qualification

Design and guarantees: `docs/ROBINHOOD_PRICE_AUTHORITY.md`. Fee-sale confidence rules: Draft PR #147
(`docs/release-notes/settlement-price-confidence.md` on that branch).

## 1. New live evidence (2026-11-14)

`scripts/verify-robinhood-stock-api.ts AAPL CRWD` run read-only on the maintainer's machine (API keys blanked,
public Robinhood RPC). Output: `evidence/price-authority/robinhood-stock-api-2026-11-14.txt`.

| Check | Result |
|---|---|
| `/rhj/assets` registry | 203 assets; 57 with multiplier ≠ 1 listed |
| `/rhj/corporate-actions` | 43 actions |
| `/prices` response shape | `{"quotes":[…]}` with bid/ask, parsed |
| AAPL | bid 354.45 / ask 355.35 × 1.00109…, spread 25 bps, `halt=false`, price layer OK 355.287 USD |
| CRWD (multiplier 4.0) | bid 230.15 / ask 233 × 4, spread 123 bps, price layer OK 926.30 USD = mid × 4 |
| Off-hours | first observation: a Saturday 05:00 UTC request returned fresh quotes with `halt=false` |
| Chainlink cross-check | **NOT RUN**: no `ROBINHOOD_CHAINLINK_FEEDS` configured (confidence shown as `-`) |
| Uniswap TWAP (`scripts/verify-robinhood-price.ts`) | **NOT RUN**: no `ROBINHOOD_PRICE_POOLS` configured |

So the API path is LIVE_VERIFIED read-only for two symbols, including the multiplier case; the cross-check and TWAP
guards remain NOT_VERIFIED.

## 2. Remaining qualification steps (read-only unless noted)

1. Obtain Chainlink feed addresses for the stock tokens in fee-bearing Bags from Chainlink's documentation; run the
   verify script with `ROBINHOOD_CHAINLINK_FEEDS` and record agreement in bps.
2. Run `scripts/check-fee-sale-feed-coverage.ts` (PR #147) to measure which fee-bearing Bags have feed coverage.
3. Re-run `scripts/check-fee-router-liquidity.ts` with the #16 quality rule (STATUS §1a) and record executability.
4. Decide on PR #147: rebase, review, merge before the positive-fee proof (recommended), or a recorded waiver.
5. Observe one weekday session and one weekend window for spread and staleness; the 500 bps spread and 5-minute
   staleness limits stay as they are unless data says otherwise.

## 3. Refusal behaviors to keep

Stale (> 5 min), halted, crossed or wide (> 500 bps) quotes, source disagreement (> 200 bps), unknown shapes and
mock providers in production all fail closed (unit-tested in `pricing/__tests__/`). Never revive the historical
"first executable Uniswap tier" selection; the #16 rule (quote every tier, refuse > 5% below verified value) stays.
