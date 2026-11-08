# Three-chain BAG application

2026-11-08, `codex/three-chain-bag-flows`, based on upstream `main` `4774ac9` plus the Arbitrum SDK work. This change prepares ordinary **create/register → buy → sell → portfolio** flows. Each BAG remains on one network. It does not bridge a basket between networks, release DCA, or enable non-Robinhood performance fees.

## Implemented and checked

- Existing generic creation prepares the transaction using the saved BAG's chain and the session wallet. Added Base/Arbitrum regression cases. Unconfigured networks, including the initially selected network, remain disabled; an empty/failed configuration response cannot enable a fallback network. Zero-address factories are rejected.
- Existing Composer multi-buy and multi-sell paths now reject an explicitly wrong-chain provider transaction instead of replacing its chain ID with the requested one. Tests serialize real Composer SDK flows for all three networks against HTTP fixtures.
- BAG sale previews and portfolio valuation resolve a client for each holdings chain. Actual RPC chain IDs are checked; identical token addresses across networks stay separate, with separate block numbers. An outage produces unknown balances for that network, never zero balances or a global failure.
- Sale verification measures native proceeds and classifies outflows on the sale's chain. Tests cover native ETH and ERC-20 proceeds on all three networks. Mixed-chain sale/KEEP legs are rejected. The existing attested fee settlement remains Robinhood-only.
- Connect, trade, webhook and scheduled full reconciliation read all supported networks. Only fully readable portfolios advance the global freshness marker. No SQL migration is required.
- The existing transfer-log scan remains an optimization for **Robinhood-only wallets**. It cannot advance the global checkpoint of a mixed-chain wallet. Base/Arbitrum and mixed-chain wallets use full balance reconciliation. The scheduled full check still runs when the Robinhood scan is unavailable.
- SDK 0.4.0 candidate builds with the Base and Arbitrum exports. No npm publication or release-gate override was performed.

## Actual environment observations

Read-only checks of the maintainer's local environment and configured Supabase:

| Check | Robinhood | Base | Arbitrum |
|---|---|---|---|
| Chain ID | 4663 | 8453 | 42161 |
| Verified asset rows in Supabase | 198 | 32 | 36 |
| Settlement asset | USDG | native USDC | native USDC |
| BagFactory configured locally | Yes | Placeholder | Placeholder |
| StrategyRegistry configured locally | No | No | No |
| StrategyCompositions configured locally | No | No | No |

Base's already deployed StrategyRegistry `0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920` was separately read and compared: **exact runtime match** with the compiled artifact. Its absence from the local environment does not mean it needs deploying again. Robinhood's production hosting configuration was not inspected or changed.

Base/Arbitrum RPC chain IDs and WETH/USDC metadata passed. Local contract/pin environment settings remain incomplete. The historical Base live SDK purchase and approved pin are recorded in `../SDK_DEPLOYMENT_PIN_BASE.md`; that evidence does not prove the app creation flow or Arbitrum execution. Arbitrum's candidate pin remains observed, not release-approved (`../SDK_DEPLOYMENT_PIN_ARBITRUM.md`).

## Prepared rollout, not broadcast

`scripts/prepare-app-rollout.mjs` prepares unsigned transactions. It reads the current Robinhood factory's owner, treasury, fee and immutable cap; checks each destination chain; verifies the reused Base registry; records current nonces and predicted deployment addresses; estimates gas. It has no wallet client, private-key loading, signing or broadcast path.

```powershell
npm run compile:contracts
node scripts/prepare-app-rollout.mjs --env-file "C:/Users/ilife/Desktop/BagProtocolv2/.env.local" --deployer 0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46 --out evidence/three-chain-app
```

The reviewed inputs and unsigned calldata are in `evidence/three-chain-app/`. Proposed settings, copied from the live Robinhood factory:

- Owner: `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46`.
- Treasury: `0x5186f0cCAB569dE1655922213074D97914378cd8`.
- Creation fee: **0.00015 ETH**; immutable maximum: **0.01 ETH**. These are BAG creation fees, not deployment gas costs.
- Base: deploy BagFactory and StrategyCompositions, reusing the verified registry (**2 transactions**).
- Arbitrum: deploy StrategyRegistry, BagFactory and StrategyCompositions (**3 transactions**).

The five creation calls obtained RPC gas estimates. Gas-price snapshots imply approximately 0.00002366 ETH for Base and 0.00010118 ETH for Arbitrum in execution charges, **excluding additional L1 data fees**. These are neither signed transactions nor final fee quotes. Re-estimate at signing time. Ordinary direct creation transactions are required; a wallet batch or different sender invalidates the predicted address sequence. An EIP-7702 delegation designator does not itself disqualify a sender (see the [transaction origination rule](https://eips.ethereum.org/EIPS/eip-7702#transaction-origination)); the script does not modify any delegation.

After approval/signing: verify each receipt, runtime code, owner/treasury/fee values and compositions' immutable registry binding; only then configure `FACTORY_ADDRESS_*`, `STRATEGY_REGISTRY_ADDRESS_*`, `STRATEGY_COMPOSITIONS_ADDRESS_*` and reviewed SDK Composer pins. **Never configure the predicted addresses as deployed contracts.** Rebuild/restart the application and test one complete create/register, purchase, partial sell and full sell per new chain with the user's wallet; verify receipts and ledger attribution. Production hosting changes and public wallet transactions are still pending.

## Validation and limits

- Repository typecheck: passed.
- SDK build and clean npm-tarball consumer import/NodeNext typecheck: passed.
- Next.js production build: passed.
- Local Hardhat contracts: **195/195 passed**. These are local EVM tests, not three new public deployments.
- Repository suite (`--maxWorkers=4`): **2686 passed, 1 failed**, across 280 files. The sole failure was an existing Windows path-separator assumption in the accounting source-authority guard. Normalized its paths without weakening the guard.
- Final focused run after that fix, including three-chain Composer flows, native/ERC-20 sale verification, creation UI and accounting guard: **58/58 passed**. The final wallet reconciliation/scan subset also passed **23/23**, including wrong-RPC and cross-chain freshness rejection. The entire 280-file suite was not repeated after these final fixes.
- Live read-only metadata, Supabase counts, existing Base registry comparison and deployment gas estimation are separate from synthetic app/SDK tests. This change did not execute a new public purchase or sale, apply database changes, publish a package, merge main, or deploy the application.

The new chain-aware accounting requires no table changes. The per-chain transfer-log optimization, public end-to-end wallet run, fee settlement outside Robinhood and DCA remain separately scoped work; none is presented as completed by these tests.
