# Robinhood Chain price authority

## Decision

This page covers Robinhood Chain. The multi-chain picture (LI.FI for crypto,
the RPC layer, `BagAsset`) is in [`PRICE_AND_DATA_LAYER.md`](PRICE_AND_DATA_LAYER.md).

Production pricing (`lib/server/price-provider.ts`) is one `BagPriceRouter`.
A second source may **verify** a price and reject it. It never
**substitutes** for a primary source that failed.

| Asset | Price source | Verification / fail closed |
|---|---|---|
| Robinhood **Stock Token** | Robinhood `/rhj/prices` mid × `currentMultiplier` | halt, stale quote, spread > 5%, zero or crossed quote, quote naming another contract. With a Chainlink feed configured, Chainlink must agree within 2%. |
| Other Robinhood assets (USDG, WETH, …) | LI.FI `priceUSD` (crypto) | Only if LI.FI has no price: Uniswap v3 TWAP vs USDG |
| Every other chain | LI.FI `priceUSD` | CoinGecko only on a LI.FI data gap and only if `CRYPTO_PRICE_FALLBACK=coingecko` |

Code: `pricing/bag-price-router.ts`, `robinhood-stock-api.ts`,
`chainlink-feed-provider.ts`, `robinhood-twap-provider.ts`,
`lib/blockchain/lifi-token-data.ts`.

```
             STOCK TOKEN (identity: /rhj/assets, by ADDRESS)
                  │
       ┌──────────┴──────────┐
       │                     │
  Robinhood API          Chainlink feed
  /rhj/prices            latestRoundData()
  raw per-SHARE          per-TOKEN
  bid / ask              (multiplier included)
       │                     │
  × currentMultiplier        │
       │                     │
       └──────────┬──────────┘
                  │  both per TOKEN, compared like-for-like
             BAG price layer
```

## Sources

Robinhood publishes a keyless, read-only REST API
([Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/)):

- `GET https://api.robinhood.com/rhj/assets`: the canonical registry.
  `tokenSymbol`, `tokenName`, `deployments[].{contractAddress, chainId}`,
  `currentMultiplier`, `pendingMultiplier`, `status`, `tokenDecimals`.
- `GET https://api.robinhood.com/rhj/prices/{symbol}`: the live body is
  `{"quotes":[{tokenSymbol, deployments, bid, ask, currency,
  dailyTradingVolume, isTradingHalt, generatedAt, …}]}`. Every numeric is a
  string, and a 404 means there is no quote. The documented cache window is
  15 seconds.
- `GET https://api.robinhood.com/rhj/corporate-actions`: the live body is
  `{"corpActions":[{id, type, status, processDate:{year,month,day},
  tokenSymbol, deployments, details}]}`.
- All endpoints are rate-limited to 60 requests per second.

Chainlink runs one feed per Stock Token on Robinhood Chain
([Robinhood tokenized equities](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)).
The answer is the price of one token, meaning share price × multiplier.

## The two rules

### 1. Identity comes from the registry, not the ticker

Other contracts on the chain use the same names and tickers as Stock Tokens.
An address counts as a Stock Token only when `/rhj/assets` lists it as an
`ASSET_STATUS_ACTIVE` deployment on chain id 4663.

- Pricing starts from the address and looks up the symbol. It never goes the
  other way.
- A Chainlink feed configured for an address missing from the registry is
  refused.
- The asset importer (`scripts/import-robinhood-assets.ts`) uses the same
  registry.

### 2. `/prices` is per share, holdings are per token

`/rhj/prices` quotes one underlying share and does not apply the multiplier.
One token stands for `currentMultiplier` shares, after reinvested dividends
and splits:

    tokenPrice = underlyingPrice × currentMultiplier

- On-chain, the same number is the token's `uiMultiplier()` / 1e18.
- The Chainlink answer already includes the multiplier.
- The layer compares only per-token values, so a 4:1 token like CRWD is never
  treated as a 300% disagreement.
- The math uses exact decimal strings and bigints, with no floats.

## Guarantees

| Requirement | How |
|---|---|
| Caching and rate limit | One process-wide client: registry refreshed every 5 minutes, corporate actions every hour, each symbol's price at most once per 15 s, concurrent requests share one fetch, a sliding-window limiter below 60 req/s. Failures are never cached. |
| Registry outage | The last good registry keeps serving, retried every 60 s. If no registry has ever loaded, only USDG is priced. Without the registry a Stock Token cannot be told apart from anything else. |
| Stale data | API quote older than 5 min, Chainlink round older than 5 min, or TWAP block older than 5 min: fail closed. Each limit is configurable. |
| Trading halt | `isTradingHalt: true` fails closed. |
| Bad quote | Zero or crossed bid/ask, or a spread wider than 500 bps: fail closed. |
| Source disagreement | API vs Chainlink beyond 200 bps: `PriceSourceDisagreementError` (a `PriceUnavailableError`). |
| Verification unavailable | Chainlink unreachable: the API price stands with `confidence: 0.5` and `source` ending in `verify:chainlink-unavailable`. API unreachable: no price. Chainlink never substitutes. |
| Audit trail | `source` records the path, e.g. `robinhood-api:prices:CRWD:mid×4.0\|verify:chainlink:0x…:3bps`. |
| Unknown response shape | Missing or non-decimal `bid`/`ask`, `isTradingHalt` or `generatedAt` throws. Nothing is guessed. |
| No mock in production | `PRICE_PROVIDER=mock` still throws under `NODE_ENV=production`. |

`pendingMultiplier` (a corporate action about to change the multiplier) is
shown in the UI and the quotes API. It does not block pricing: the current
multiplier stays correct until the action is applied.

## Display quotes

`GET /api/stock-quotes?symbols=AAPL,CRWD` serves quotes to the frontend. Each
quote carries:

- per-token `bid`/`ask`/`mid`
- raw `rawBid`/`rawAsk`
- `currentMultiplier`, `pendingMultiplier`
- `spreadBps`, `isTradingHalt`, `generatedAt`

The Bag page's Composition tab shows, for example, `$213.45 / $213.47`,
refreshed every 15 s. When the multiplier is not 1 it also shows the raw
share quote.

These quotes go through the server rather than the browser, so all viewers
share the cache and the rate limit. They are for display only: protocol math
always goes through `getPriceProvider()`.

## Configuration

| Variable | Meaning |
|---|---|
| `ROBINHOOD_CHAINLINK_FEEDS` | `{"0xtoken":"0xfeed"}`, copied from docs.chain.link. Optional; enables on-chain verification of the API price. |
| `ROBINHOOD_CHAINLINK_MAX_AGE_SECONDS` | Default 300. Equity feeds may not update while markets are closed. |
| `ROBINHOOD_PRICE_MAX_DEVIATION_BPS` | Default 200 |
| `ROBINHOOD_API_MAX_AGE_SECONDS`, `ROBINHOOD_API_MAX_SPREAD_BPS` | Defaults 300 and 500 |
| `ROBINHOOD_PRICE_POOLS`, `ROBINHOOD_TWAP_WINDOW_SECONDS` | TWAP fallback for non-stock assets when LI.FI has no price. Pools configured for Stock Tokens are ignored. |

## Explicit assumptions and limits

- **USD.** The API and Chainlink quote USD. The TWAP quotes USDG, treated as
  USD, and a depeg is not detected.
- **Mid, not executable.** NAV uses the mid price. What a purchase actually
  receives is enforced separately by the execution path's minimum output.
- **Off-hours.** Behavior of `/prices` and the equity feeds outside market
  hours has not been observed. The staleness limits decide whether a price is
  served.
- **Chainlink feed addresses** are not in this repository and must come from
  Chainlink's docs. A wrong feed fails the verification step (disagreement), provided
  the API is reachable.

## Live verification

**NOT VERIFIED.** This sandbox cannot reach any of these hosts. The egress
proxy answers 403 for:

- `api.robinhood.com`
- `docs.robinhood.com`
- `docs.chain.link`
- the Robinhood RPC

The endpoint names and fields come from Robinhood's documentation as indexed
by search. The response shapes are pinned by live captures (MIT-licensed
fixtures, `pricing/__tests__/fixtures/README.md`). Those captures showed the
`{"quotes":[…]}` wrapper, which an earlier version of the parser did not
handle. Every branch (parsing, multiplier, cache, rate limit, halt,
staleness, spread, disagreement, impostor address, registry outage) is
unit-tested with scripted HTTP and chain clients in
`pricing/__tests__/robinhood-stock-api.test.ts` and `bag-price-router.test.ts`.

To verify live, run this anywhere the hosts are reachable:

    npx tsx scripts/verify-robinhood-stock-api.ts AAPL CRWD
    ROBINHOOD_CHAINLINK_FEEDS='{"0x<token>":"0x<feed>"}' npx tsx scripts/verify-robinhood-stock-api.ts CRWD
    ROBINHOOD_PRICE_POOLS='{"0x<asset>":"0x<pool>"}' npx tsx scripts/verify-robinhood-price.ts

The first script prints:

- the raw `/prices` payload, so a shape change is visible
- the per-token quote
- the price the layer would use, or the exact reason it fails closed

CRWD (multiplier 4.0) is the case that proves the multiplier handling.
