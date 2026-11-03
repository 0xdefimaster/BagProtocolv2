# Release note: reference-price confidence for fee-paying sales

Status: IMPLEMENTED on branch `fix/settlement-price-confidence`, tests passing locally.
Not MERGED, not DEPLOYED, not LIVE VERIFIED. This is internal work and has not been audited.

## What changes

A fee-paying sale leg is refused when its quote is too far below
quantity × reference price (`redeem-quote-quality.ts`). Until now both
fee-sale paths read only `.price` from the price router, so every reference
price got the same 500 bps band, whether it had been verified or not.

The band now depends on how well the price router verified the reference
(`lib/domain/basket-protocol/redeem/sale-price-confidence.ts`):

| Router result | Meaning | Fee-sale decision |
|---|---|---|
| `confidence: 1` | Robinhood API price agrees with Chainlink, within `ROBINHOOD_PRICE_MAX_DEVIATION_BPS` (200) | **VERIFIED**: 500 bps band (unchanged) |
| `confidence: 0.5`, source `…\|verify:chainlink-unavailable` | A feed is configured but could not be read, or its round is stale; the API price was not verified | **REDUCED_CONFIDENCE**: `FEE_SALE_REDUCED_CONFIDENCE_MAX_DEVIATION_BPS`, default **100** |
| no `confidence` | No feed is configured for the stock token, or the price is a crypto (LI.FI / TWAP) price | **refused** (`CONFIDENCE_MISSING`) |
| confidence < 0.5, not a number, or outside [0, 1] | — | **refused** |
| timestamp missing, unparseable, or more than 30 s in the future | — | **refused** (`TIMESTAMP_INVALID`) |
| older than `FEE_SALE_PRICE_MAX_AGE_SECONDS` (300) | — | **refused** (`PRICE_STALE`) |
| router throws `PriceSourceDisagreementError` (> 200 bps) or any source error | — | **refused** (unchanged) |

A refusal means phase 1 (`quoteSettlement`) records no plan, so phase 2
(`attestSettlement`) has nothing to sign and the attestor key signs nothing.
The legacy `signFeeAttestation` (RedeemFeeRouter) path applies the same policy
before it signs.

Configuration errors fail closed. An invalid value (for example `1%`, `-1`, or a
band above 500) refuses the sale as `PRICE_UNAVAILABLE`; it never falls back to
a wider default.

## What does not change

- The free sale path (`/execute`, `redeem-execution.ts`), purchases, NAV, the
  redeem preview and display pricing all still read `.price` as before.
  Test 7 pins this.
- The price router itself: confidence values, the 200 bps disagreement
  check, and the API and Chainlink staleness limits.
- The contracts, the signed `Settlement` struct, the plan schema and the
  Composer floors.
- Read-only reporting tools (`scripts/check-fee-router-liquidity.ts`,
  `fee-router-executability.ts`) still assume the 500 bps band. They can show a
  leg as executable that the attestation now refuses, when the reference is
  not verified. This is a known divergence.

## The provisional 100 bps band: trade-offs

- **Why stricter at all.** With Chainlink unreadable, the reference is the
  Robinhood API mid on its own. Giving it the same 5% band as a cross-checked
  price treats an unchecked number as if it were checked.
- **Availability cost.** A Uniswap v3 sale already pays the pool fee
  (0.05–1%) plus price impact. A 1% band therefore refuses most sales out of
  thin stock-token pools, and sales larger than about 1% of pool depth,
  while the feed is unreadable. Equity feeds can stop updating outside market
  hours, and a stale round is "unavailable", so off-hours fee sales mostly fall
  into this band. Off-hours API quotes are often refused anyway by
  `ROBINHOOD_API_MAX_SPREAD_BPS` (500).
- **What it does not do.** The band limits loss *relative to the reference*;
  it does not verify the reference. If the unverified API price is itself too
  low, a correspondingly low quote can still pass. Only a working feed
  (confidence 1) closes that gap.
- **Alternatives.**
  - `0` accepts only quotes at or above the unverified reference. In practice
    this halts fee sales during a feed outage.
  - Refusing confidence 0.5 outright was not chosen, because a short RPC
    outage would then block every fee sale.
  - Values up to 500 are allowed, but 500 removes the distinction altogether.
- **Revisit** once real fee-sale data exists (the positive-fee runbook), using
  observed deviation distributions per pool rather than this estimate.

## Release implications (read before deploying)

1. **Every stock token sold with a fee needs a Chainlink feed in
   `ROBINHOOD_CHAINLINK_FEEDS`.** Without one the router returns no
   confidence, and the fee sale is refused with `PRICE_UNAVAILABLE`. Today the
   variable is optional. Check which tokens are held by fee-charging Bags
   before deploying.
2. **Crypto legs** (anything priced by LI.FI or the TWAP fallback) carry no
   confidence, so a fee sale that includes them is refused. USDG legs are not
   priced and are unaffected.
3. **More `PRICE_TOO_LOW` refusals** while a feed is unreadable (100 bps
   instead of 500).
4. Positive-fee sales are NOT LIVE VERIFIED on RedeemSettlement v2. This change
   alters the conditions under which the first one can run. The owner's
   positive-fee runbook should be run with this change deployed, if it ships,
   and with feeds configured for the tokens sold.
5. No contract change, no migration, no new secret. Rollback means
   reverting the commit. The env variables then become inert.

## Tests

- `lib/domain/basket-protocol/redeem/__tests__/sale-price-confidence.test.ts`:
  tiers, staleness, invalid input, env parsing, and the real `BagPriceRouter`
  (scripted sources) feeding the policy.
- `lib/server/__tests__/redeem-settlement-attestation.test.ts`, block
  "reference-price confidence":
  1. A high-confidence leg 3% below its reference is planned.
  2. At confidence 0.5, 3% below is refused (band 100) and 0.9% below passes.
     The env band is configurable, and a bad value refuses the sale.
  3. Missing confidence is refused.
  4. A stale price is refused.
  5. Source disagreement is refused.
  6. A refused quote leaves no plan, no claim, no final build and no
     signature; phase 2 fails with `NO_PLAN`.
- `lib/server/__tests__/redeem-fee-attestation-b0.test.ts`: the same policy on
  the legacy RedeemFeeRouter path.
- `lib/server/__tests__/sale-price-confidence-scope.test.ts`: (7) the free sale
  path and the other price consumers are not altered.

No fork run and no live run was done for this change.
