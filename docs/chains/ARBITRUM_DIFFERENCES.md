# Arbitrum One (42161): differences from the Base plan

Arbitrum comes **after** Base. It follows the same gates A–E (`docs/chains/BASE_READINESS.md`) and the same read-only
check (`npx tsx scripts/verify-chain-readiness.ts arbitrum`, with B-Core / B-App as for Base). This page lists only what differs.

Status 2026-11-03: **NOT production-qualified.** Nothing is deployed and no pin has been reviewed.

| Area | Base | Arbitrum One | Consequence |
|---|---|---|---|
| Chain stack | OP Stack (op-geth / op-reth) | Arbitrum Nitro, the same family as Robinhood Chain (an Orbit chain) | Closest to the existing Robinhood evidence, but **not** covered by it |
| Wrapped native | WETH predeploy `0x4200…0006` | WETH `0x82aF…Bab1` | Gate A checks the address in `lib/config/chains.ts` |
| Stablecoin | Native USDC `0x8335…2913` | Native USDC `0xaf88…5831`. **Not** the bridged USDC.e (`0xFF97…5CC8`) | Strategies and sweeps must use native USDC; gate A checks it |
| Block shape | The first tx is the L1-attributes deposit, followed by zero or more others | The first tx is an ArbOS internal (start-block) tx, followed by zero or more others | A block containing a user's purchase has at least 2 txs, so `SINGLE_TRANSACTION_BLOCK` (purchase must be the only tx) refuses on both chains |
| Indexed receipt reader | `GETH_TRANSACTION_INDEX` refuses: the client is not `Geth/v1.16` | `ROBINHOOD_NITRO_TRANSACTION_INDEX` is chain-gated to 4663 and pinned to one Nitro build | A Nitro reader for 42161 would need its own chain gate, build pin and qualification with real historical reads. Until then, `DELIVERY_LOG` (SDK 0.4 candidate) is the route |
| Composer pin | Separate review | Separate review (`docs/SDK_DEPLOYMENT_PIN_ARBITRUM.md`, to be written) | The Robinhood and Base pins never apply |
| Stock tokens | None | Robinhood's registry lists some Stock Token deployments on 42161 | **Out of scope.** `supportedAssetTypes` for `arbitrum` stays `['CRYPTO']`; stock pricing (API + Chainlink) is qualified only for 4663 |
| Price fallback | LI.FI; CoinGecko only if `CRYPTO_PRICE_FALLBACK=coingecko` | Same | No TWAP fallback outside Robinhood Chain |
| Finality tag | `finalized` follows L1 finality | `finalized` follows L1 finality of the batch, usually longer than on Robinhood | Any keeper or verifier confirmation depth must be set per chain, not copied |
| Public RPC | `mainnet.base.org` (rate-limited) | `arb1.arbitrum.io/rpc` (rate-limited) | Use your own RPC for checks and evidence |

Everything else is identical:
- the deploy scripts already accept `arbitrum`;
- addresses come only from `…_ARBITRUM` variables;
- RedeemSettlement, royalties, DCA, BagExecutionRouter and cross-chain baskets stay out of scope.
