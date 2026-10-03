# BAG data layer: chains, RPC, assets, prices

BAG runs on four EVM chains. One data layer serves all of them. Each external
provider is used only for the data it is authoritative for.

```
                         BAG DATA LAYER
                               │
          ┌────────────────────┼─────────────────────┐
       CRYPTO             STOCK TOKENS             ONCHAIN
          │                    │                      │
        LI.FI          Robinhood Stock API     Alchemy (+ fallback RPCs)
   token metadata      /assets  (identity,     balances, eth_call, allowance,
   priceUSD            multiplier, trading     gas, logs, receipts, blocks,
   routes / quotes     capabilities)           oracle reads, tx broadcast
   execution           /prices  (bid/ask)
                       /corporate-actions
          └────────────────────┼─────────────────────┘
                               │
                BAG normalizer (lib/server/bag-asset-service.ts)
                               │
                 BagAsset + BagPriceRouter (one PriceProvider)
                     ┌─────────┴──────────┐
               Portfolio / NAV       Router / execution
                     │                    │
         BAG UI (via /api only)    LI.FI · BAG Router quotes
```

## Chains

`lib/config/chains.ts` is the only place chains are described.

| Chain | chainId | Native | Asset types | Public RPC fallback |
|---|---|---|---|---|
| Ethereum | 1 | ETH | CRYPTO | none |
| Arbitrum One | 42161 | ETH | CRYPTO | arb1.arbitrum.io (chain operator) |
| Base | 8453 | ETH | CRYPTO | mainnet.base.org (chain operator) |
| Robinhood Chain | 4663 | ETH | CRYPTO, STOCK_TOKEN | rpc.mainnet.chain.robinhood.com |

Solana stays in the protocol `ChainId` union for LI.FI routing. It is not an
EVM chain and is not part of this configuration.

## RPC: `lib/blockchain/rpc/`

Server code gets chain access in one of two ways:

- `getChainPublicClient(chain)`: a normal viem client.
- `getChainTransport(chain)`: the same layer, for wallet clients.

Nothing else knows which provider answered.

**Endpoint order**

1. Primary: `<CHAIN>_RPC_URL`. If unset, Alchemy
   `https://<eth|arb|base|robinhood>-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY`.
   The legacy name `RPC_URL_<CHAIN>` is still read.
2. Secondary: `<CHAIN>_RPC_URL_SECONDARY` (QuickNode or any other provider).
3. Public: the chain operator's public endpoint.

**Resilience**

| Feature | Behaviour |
|---|---|
| Timeout | Per request, default 8 s |
| Failover | On timeout, network error, HTTP error, rate limit or "node behind" errors, the next endpoint is tried |
| Deterministic errors | Reverts and invalid params are returned immediately; another node would give the same answer |
| Bounded retry | Two passes over the endpoint list, with exponential backoff between passes |
| Circuit breaker | Three consecutive failures skip an endpoint for 30 s, then it is probed again |
| Health state | `healthSnapshot()` reports each endpoint's circuit, staleness, last block, latency and last error, with URLs redacted |
| Stale detection | An endpoint more than 20 blocks behind the best `eth_blockNumber` seen is demoted |
| Logging | Structured JSON events (`rpc.request.failed`, `rpc.circuit.open`, `rpc.endpoint.stale`, `rpc.tx.*`). API keys are never logged. |

**Transactions are never blindly re-broadcast.** The flow is:

1. Compute the transaction hash locally.
2. Send it through the primary endpoint.
3. If that times out or errors, look the hash up on every endpoint.
4. If any node knows the hash, the transaction was accepted; return the hash.
5. Only if no node knows it, send through the next endpoint.
6. Check the hash again before using the final fallback.

Some errors have fixed meanings:

- "already known" counts as accepted.
- "nonce too low" counts as accepted if the hash is found.
- Deterministic rejections such as insufficient funds are thrown and never
  sent elsewhere.
- If every endpoint fails ambiguously, `TransactionBroadcastUnknownError`
  carries the hash so the caller can check again later.

Users sign in their own wallets and the wallet broadcasts, so this path
matters for the one server-side sender: the creator-rewards settlement worker.

Browser code never gets the Alchemy URL, because it contains the key. Browser
reads use public RPCs.

## Assets: `BagAsset`

`lib/domain/basket-protocol/assets/bag-asset.ts` defines one shape for every
chain. The semantics differ by asset type:

| | Crypto | Stock Token |
|---|---|---|
| `assetType` | `CRYPTO` | `STOCK_TOKEN` |
| Identity | chainId + address, validated against LI.FI's answer | chainId 4663 + the contract listed ACTIVE in `/rhj/assets` |
| `metadataSource` | `LIFI`, or `ONCHAIN` (ERC-20 read) when LI.FI does not know the token | `ROBINHOOD` |
| Price | LI.FI `priceUSD` | `/rhj/prices` mid × `currentMultiplier` |
| Extra | none | `stock` block: bid, ask, raw bid/ask, multiplier, pending multiplier and effective time, halt, fractional tradability |

Every `priceUSD` is `priceKind: "INDICATIVE"`. `priceSource` names the source
that actually produced the number, fallbacks included:

- `LIFI`
- `ROBINHOOD_STOCK_API`
- `UNISWAP_V3_TWAP`
- `COINGECKO`
- `USDG_PEG`

`priceSourceDetail` keeps the full trail.

**Identity rules**

- A ticker never makes an asset a Stock Token. A contract calling itself
  "AAPL" that `/rhj/assets` does not list is treated as crypto.
- A Robinhood quote that names a different contract is rejected.
- A Chainlink feed configured for a non-registry address is refused.

## Price source priority: `BagPriceRouter`

| Asset | 1st | 2nd |
|---|---|---|
| Stock Token | Robinhood `/rhj/prices` mid × `currentMultiplier` | Chainlink feed (if configured) **verifies** the price on-chain. More than 200 bps disagreement fails closed. It never substitutes for a failed API price. |
| Crypto | LI.FI `priceUSD` | Only on a LI.FI **data gap** (token unknown to LI.FI, or no `priceUSD`): Robinhood Chain uses the Uniswap v3 TWAP; other chains use CoinGecko only if `CRYPTO_PRICE_FALLBACK=coingecko`. A LI.FI **outage** never switches sources. |
| Blockchain state | Alchemy (primary RPC) | secondary, then public RPC |
| Execution | LI.FI route/quote, or the BAG Router when configured (`lib/execution`) | none |

If the Robinhood registry has never loaded, no Robinhood asset can be
classified, so only USDG is priced. Other chains are unaffected.

## Caching

The repository has no Redis. Caches are in-process and shared, one per
provider. All callers go through them: pricing, `/api/asset-prices`,
`/api/stock-quotes` and the purchase guard. Concurrent identical requests
share one fetch, and failures are never cached.

| Data | Window |
|---|---|
| `/rhj/assets` | 5 min; the last good copy keeps serving through outages, retried every 60 s |
| `/rhj/prices/{symbol}` | 15 s (documented) |
| `/rhj/corporate-actions` | 1 h; never per page load |
| LI.FI token (`/v1/token`) | 60 s; also seeded from the tokens inside LI.FI quotes, so a quoted token is not fetched twice |
| Robinhood rate limit | 60 req/s sliding window. A 429 pauses every call, honouring `Retry-After`. |

The browser calls only BAG routes:

- `/api/asset-prices?assets=chain:address,…`: unified `BagAsset`s for any
  chain.
- `/api/stock-quotes?symbols=…`: Stock Token bid/ask for the Composition tab.

## Corporate actions

`RobinhoodStockApi.corporateActions()` parses `{"corpActions":[…]}`. Each
action has a type, a status, a protobuf `processDate` and a cash dividend rate.

`reconcileCorporateActions()` reports:

- actions for registry tokens
- actions naming a foreign contract (never applied)
- queued multiplier changes, with their effective time
- drift between the stored `assets.current_multiplier` and the registry

The multiplier itself always comes from `/assets`. It is not rebuilt from
action history, because the API exposes per-share rates but not totals.
`scripts/import-robinhood-assets.ts` prints this report.

## One-click purchase: indicative vs execution

1. Resolve assets through the database registry, then re-check Stock Tokens
   against the live Robinhood registry (`stock-token-guard.ts`). They must
   still be the listed contract, still active, and fractionally tradable now.
2. Compute the indicative NAV with `BagPriceRouter`. The preview says
   "no swap is quoted".
3. Request execution quotes: a LI.FI route/quote or the BAG Router, which
   carries quoted output and guaranteed minimum output (`lib/execution`).
4. The user signs in their own wallet.
5. On-chain verification of receipts and received amounts via the RPC layer.
6. Accounting.

A market price is never used as an execution amount.

### When the oracle cannot value the Bag (e.g. Stock Tokens on a weekend)

The oracle NAV is needed for one thing only: how many shares a purchase mints.
Allocation (weights × amount), the minimum investment (payment-token amount)
and the buyer's protections (route, quote, minimum output, slippage,
allowlists, policy) never depend on it. So an unavailable price no longer
stops a purchase by itself:

- **Preview** returns the allocation and execution plan, `depositQuote: null`,
  `shareValuation: "EXECUTION_QUOTE"`, and `valuation.unavailable`: each holding
  without a usable price and why (`MARKET_CLOSED_OR_HALTED`, `SPREAD_TOO_WIDE`,
  `STALE_QUOTE`, `NOT_LISTED`, `SOURCES_DISAGREE`, `SOURCE_UNAVAILABLE`,
  `NO_PRICE`). The UI shows "Market price unavailable: …" and keeps Purchase on.
- **Intent creation** quotes first, then prices the shares from that quote
  (`lib/domain/basket-protocol/shares/execution-valuation.ts`): each holding is
  valued at input spent / BAG's minimum output for its leg, rounded up, and
  the payment token at 1. No value moves between the buyer and existing
  holders at the prices the market actually offers; using the minimum output
  and rounding up can only give the buyer fewer shares, never more.
- **Still blocked, with the real reason:** no executable quote
  (`QUOTE_FAILED`, nothing written), or a holding the purchase does not buy and
  that has no price of its own (`VALUATION_UNAVAILABLE`, assets named, nothing
  written). Robinhood's Stock Token registry being unreachable is reported as
  `STOCK_REGISTRY_UNAVAILABLE`, not as a price problem.
- When the oracle works, nothing changes: shares come from the oracle NAV.

Redemption still values through the oracle NAV; moving it (and the
performance fee) to realized amounts is the accounting work tracked
separately.

## Deliberately not done

- **A single Bag spanning several chains**, for example ETH on Ethereum plus
  AAPL on Robinhood Chain. A Bag is one contract on one chain, and purchases
  execute on that chain. Valuation already works across chains, including a
  user's portfolio of Bags on different chains. Cross-chain Bag *execution*
  (bridging legs, multi-chain custody, partial-failure recovery) is a protocol
  design change, not a data-layer change.
- **Alchemy Prices API.** LI.FI already provides crypto prices. A second
  independent price system is not added without a documented data gap.
- **`ROBINHOOD_API_CONFIGURATION`.** Robinhood's Stock Token API is keyless,
  so there is nothing to configure. The base URL is a constant.
- **Redis.** None exists in the repository. The in-process caches are per
  server instance.

## Live verification

**NOT VERIFIED.** The sandbox cannot reach Robinhood, LI.FI, Alchemy or any
chain RPC.

- Response shapes come from live captures (MIT-licensed fixtures under
  `pricing/__tests__/fixtures`), and the parsers are pinned to them.
- Everything else is unit-tested with scripted HTTP and JSON-RPC.

To check live, run:

    npx tsx scripts/verify-robinhood-stock-api.ts AAPL CRWD
    ROBINHOOD_PRICE_POOLS='{"0x…":"0x…"}' npx tsx scripts/verify-robinhood-price.ts
