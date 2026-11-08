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
| BagFactory configured locally | Yes | Deployed and configured, 2026-11-08 | Placeholder |
| StrategyRegistry configured locally | No | Existing deployment verified and configured | No |
| StrategyCompositions configured locally | No | Deployed and configured, 2026-11-08 | No |

Base's already deployed StrategyRegistry `0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920` was separately read and compared: **exact runtime match** with the compiled artifact. It was reused and added to the local environment; no duplicate registry was deployed. Production hosting configuration was not changed.

Base/Arbitrum RPC chain IDs and WETH/USDC metadata passed. Base's local contract and approved Composer pin settings are now configured. Arbitrum settings remain incomplete. The historical Base live SDK purchase and approved pin are recorded in `../SDK_DEPLOYMENT_PIN_BASE.md`; that evidence does not prove the app creation flow or Arbitrum execution. Arbitrum's candidate pin remains observed, not release-approved (`../SDK_DEPLOYMENT_PIN_ARBITRUM.md`).

## Rollout: Base deployed, Arbitrum deferred

The maintainer approved the five-transaction rollout. Base completed on 2026-11-08. Arbitrum had no native gas balance; the maintainer then explicitly requested **Base only for now**. No Arbitrum transaction was signed or broadcast.

| Base contract | Address | Public transaction |
|---|---|---|
| BagFactory | `0x9F66fA3F7a70281eB4F598EfE763B3f83379df4a` | [0x7291…509b](https://basescan.org/tx/0x7291dd815cd4f2077428dcd86efb880a573dccc04efa9b9a081a0d9b47ac509b), block 54802636 |
| StrategyCompositions | `0x7D4A75a7F196eA90Cf96021ADAC83a0DE93A4Fc8` | [0xf9ff…f0a9](https://basescan.org/tx/0xf9ff41673f788e772a015a8a4fa9dfd12ec50ebf76c743477c51925ea89af0a9), block 54802650 |

Both receipts succeeded. Runtime bytecode matches the compiled artifacts exactly after substituting the approved constructor immutables (metadata was **not** masked in this deployment check). Factory owner, treasury, creation fee, fee cap and zero pending owner were read back. Compositions' immutable registry matches the reused Base registry. Receipt execution gas plus L1 fees totaled **0.000023499463850167 ETH**. This is deployment gas, not the BAG creation fee.

The three Base contract variables and the previously approved Composer pin were added to the maintainer's Desktop `.env.local`, preserving all unrelated settings. The pre-change file is backed up as `.env.pre-base-rollout-20261108.local` (gitignored). `evidence/three-chain-app/settings-base.env` contains public settings only. Base Composer factory and VM code hashes were rechecked against the 2026-11-04 approval. The application configuration handler reports `deployable: ["base", "robinhood"]`.

`scripts/execute-app-rollout.mjs` defaults to a read-only check. The explicit `--send` path validates the approved arguments and every byte of deployment data, enforces nonce/gas/balance checks, records each transaction hash before broadcast, and verifies the result. Re-running Base after completion confirmed **zero remaining deployments**, without signing or broadcasting again. Public receipts and verification records are in `evidence/three-chain-app/deployments-base.json`.

### Original unsigned preparation

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

The Base deployment and local configuration steps above are complete. The Arbitrum entries in the unsigned manifest remain predictions, **not deployments**; regenerate/review their nonce and fee snapshot when that rollout resumes. **Never configure predicted addresses as deployed contracts.** A complete public application create/register, purchase, partial sell and full sell remains pending per new chain, including receipt and ledger attribution. Production hosting deployment and SDK publication are separate pending steps.

## Validation and limits

- Repository typecheck: passed.
- SDK build and clean npm-tarball consumer import/NodeNext typecheck: passed.
- Next.js production build: passed.
- Local Hardhat contracts: **195/195 passed**. These are local EVM tests, not three new public deployments.
- Repository suite (`--maxWorkers=4`): **2686 passed, 1 failed**, across 280 files. The sole failure was an existing Windows path-separator assumption in the accounting source-authority guard. Normalized its paths without weakening the guard.
- Final focused run after that fix, including three-chain Composer flows, native/ERC-20 sale verification, creation UI and accounting guard: **58/58 passed**. The final wallet reconciliation/scan subset also passed **23/23**, including wrong-RPC and cross-chain freshness rejection. The entire 280-file suite was not repeated after these final fixes.
- Live read-only metadata, Supabase counts, existing Base registry comparison and deployment gas estimation are separate from synthetic app/SDK tests. This change did not execute a new public purchase or sale, apply database changes, publish a package, merge main, or deploy the application.

The new chain-aware accounting requires no table changes. The per-chain transfer-log optimization, public end-to-end wallet run, fee settlement outside Robinhood and DCA remain separately scoped work; none is presented as completed by these tests.
