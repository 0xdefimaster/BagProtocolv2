# Arbitrum One (42161): rollout to the same level as Base

The application code is chain-aware already (`docs/chains/THREE_CHAIN_APP.md`). What Arbitrum lacks is its own
contracts and configuration. Nothing below is live until the owner signs and sets the variables.

Code state after 2026-11-19:

| | Base | Arbitrum |
|---|---|---|
| Create / buy / sell / portfolio | yes, once `FACTORY_ADDRESS_*` is set | same |
| Pay / receive | USDC or ETH only | USDC or ETH only (`SETTLEMENT_AND_NATIVE_ONLY_CHAINS`) |
| Rebalance | yes, hub USDC | yes, hub USDC `0xaf88…5831` |
| Creator fee | once `REDEEM_SETTLEMENT_ADDRESS_BASE` is set | once `REDEEM_SETTLEMENT_ADDRESS_ARBITRUM` is set |
| Tokenized stocks | Coinbase (NVDAc, AAPLc, GOOGLc, METAc) | LI.FI-verified xStocks / Backed / Ondo, chosen by the owner after a route test |

## 1. Deploy the three BAG contracts (owner signs 3 transactions)

On your own machine, `.env.local` (never committed): `DEPLOYER_PRIVATE_KEY` (one-off key with a little ETH on
Arbitrum), `PROTOCOL_TREASURY_ADDRESS=0x5186f0cCAB569dE1655922213074D97914378cd8`,
`FACTORY_OWNER=0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46`, `BAG_CREATION_FEE_ETH=0.00015`, and `ARBITRUM_RPC_URL`
(or `ALCHEMY_API_KEY`). The values match the live Robinhood and Base factories.

```powershell
npm run compile:contracts
npx tsx scripts/deploy-strategy-registry.ts arbitrum
# put the printed address in .env.local as STRATEGY_REGISTRY_ADDRESS_ARBITRUM, then:
npx tsx scripts/deploy-bag-factory.ts arbitrum
npx tsx scripts/deploy-strategy-compositions.ts arbitrum
npx tsx scripts/deploy-strategy-compositions.ts arbitrum --verify 0x…
npx tsx scripts/verify-chain-readiness.ts arbitrum
```

Use only the addresses printed after successful receipts, never the predicted ones in
`evidence/three-chain-app/unsigned-deployments.json`. Remove the deployer key afterwards.

## 2. Netlify variables

```
FACTORY_ADDRESS_ARBITRUM=0x…
STRATEGY_REGISTRY_ADDRESS_ARBITRUM=0x…
STRATEGY_COMPOSITIONS_ADDRESS_ARBITRUM=0x…
EXPLORER_URL_ARBITRUM=https://arbiscan.io
CONFIRMATIONS_ARBITRUM=1
ARBITRUM_RPC_URL=<provider URL>   # plus ARBITRUM_RPC_URL_SECONDARY; without them the public RPC is used
```

Redeploy. `GET /api/deploy/chains` must list `arbitrum` in `deployable` and `rebalance`.
Rollback: unset `FACTORY_ADDRESS_ARBITRUM` (no new Bags; existing ones stay readable and sellable).

## 3. Assets

```powershell
npx tsx scripts/import-lifi-assets.ts --stocks --chain=arbitrum                  # dry run: LI.FI-verified stocks
node scripts/check-lifi-routes.mjs --chain=arbitrum --usd=10,100,1000 0x… 0x…    # buy and sell route per stock
npx tsx scripts/import-lifi-assets.ts --stocks --chain=arbitrum --only=SYM1,SYM2 --apply
npx tsx scripts/refresh-asset-routes.ts arbitrum
```

Only register stocks whose route test says `OK` (round trip ≤ 2% at $1,000). On Base, the Backed tokens had no sell
route at all; check before adding, not after.

## 4. Creator fee (optional, one more signature)

```powershell
# REDEEM_SETTLEMENT_DEPLOY_CONFIRM=I_UNDERSTAND_THIS_DEPLOYS_TO_ARBITRUM, owner and attestor addresses as on Base
npx tsx scripts/deploy-redeem-settlement.ts --chain=arbitrum
```

Then `REDEEM_SETTLEMENT_ADDRESS_ARBITRUM` in Netlify. Details: `docs/chains/BASE_FEE_SETTLEMENT.md` §2.

## 5. End-to-end test (small amounts)

Create (fee 0%) and register → buy with USDC → buy with ETH → portfolio → publish a new version and rebalance →
sell 50% → sell 100%. Keep every transaction hash. Only then call Arbitrum production-qualified in `docs/STATUS.md`.
