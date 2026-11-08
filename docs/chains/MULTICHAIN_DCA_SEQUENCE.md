# Base + Arbitrum SDK, then DCA

Initial baseline: `feat/base-sdk-path` at `b57eb51042f3f57a458a6706efb514d5f833a1d3`. The SDK changes were subsequently integrated with `main` at `4774ac9` in `codex/three-chain-bag-flows`. This is not an npm release or a public deployment. The current priority is the ordinary three-chain app flow (create, buy, sell), documented in `THREE_CHAIN_APP.md`; DCA follows it.

## Product scope

One SDK, separate execution on each chain. A strategy and its authorization belong to exactly one chain. Base and Arbitrum initially use native USDC/ETH/WETH; Robinhood's USDG and stock addresses cannot be copied. A basket does not bridge assets between chains.

The intended user choice is chain, basket, amount per purchase, interval and purchase count. Example: 5 USDC once a week, five purchases, total cap 25 USDC. The keeper submits due purchases while the wallet is offline; contract checks still enforce the signed rules. The SDK prepares and reads plans; persistent job storage and a running keeper are separate services.

## Implementation sequence

| Order | Work | Completion evidence |
|---|---|---|
| 1 | Shared SDK chain profiles, native token identities, asset screening, compile/simulate/receipt path | Parameterized Base/Arbitrum tests; built package import/typecheck; no reused Robinhood receipt reader |
| 2 | Qualify the purchase path on each chain | Chain-specific Composer pin; fresh quote; successful eth_call/fork purchase; live wallet receipt separately identified. Do not treat missing funds as simulation success |
| 3 | Resolve DCA contract dependencies | Inspect the current DCA branch's BagFactory/Bag/StrategyRegistry requirements. Either deploy those required contracts per chain or explicitly design a registry-only DCA variant; never remove BAG binding checks to pass a test |
| 4 | Adapt the DCA funding/route layer | Chain-bound EIP-712 domain, executor deployment, token addresses, typed route targets, per-asset minima, fixed signed policy; liquidity quotes validated on the target chain |
| 5 | SDK plan lifecycle and keeper | Create/read/due/status/cancel operations; events and confirmed chain counters are authority. Persist work by chain + executor + plan id; recover after restart; per-chain confirmation/reorg handling |
| 6 | Per-chain lifecycle qualification | Valid purchase; early duplicate rejected; next period accepted; total/run limit rejected; cancellation with budget remaining; withdrawal where applicable; no balance/counter changes on failure. Real-wallet signatures and public transactions remain separate evidence |

Steps 1–2 come before DCA rollout. Keeper persistence and SDK API design can proceed after the authorization interface is stable. None of these steps require publishing a new wallet.

## DCA architecture found in the repository

The local research branch `feat/dca-v1-typed-adapter` at `419520a89bd7f0a93697b38465ddd1a3ffb4fce5` documents `BagDcaExecutor` + `UniswapV3ExactInAdapter` (`docs/dca/DCA_V1_TYPED_ADAPTER.md`). It is a different funding model from the earlier MultiSigDeleGator prototype:

- The current typed-adapter proposal uses **EOA allowance plus signed DCA authorization**. Funds stay in the EOA, but the total remaining allowance trusts the executor; a token-level independent periodic delegation limit is not provided. ERC-20 approval may be an additional transaction.
- The older B prototype uses a **separate user-owned smart account** and delegation enforcers. Its periodic limit is enforced outside the plan, but funding, cancellation and withdrawal require that account path.
- The tested MetaMask native-permission failure is not proof that the separate account model or normal ERC-20 approval is unavailable.

Adding a chain profile selects neither funding model. Do not silently present EOA allowance as the B model or as ERC-7715. Reuse schedule and budget logic only after the chosen funding interface is explicit.

The typed-adapter branch depends on `BagFactory.bagOf` and BAG composition/version checks. Base's SDK StrategyRegistry deployment alone does not satisfy that dependency. Its route currently uses direct Uniswap v3, while the SDK purchase path uses Composer: SDK chain support does not automatically qualify that route. Price ceilings signed by a user also are not an independent market-price oracle.

## Current evidence limits

- Base: existing 2026-11-04 maintainer purchase verified using delivery logs, as recorded in `docs/SDK_DEPLOYMENT_PIN_BASE.md`; pin approved by the maintainer on 2026-11-04. The app's additional contracts/configuration remain separate requirements.
- Arbitrum: token metadata and candidate factory/VM observed at block 522387172. Fresh Composer quotes compiled; a 0.5 USDC → WETH eth_call passed with a verified approval override. The full default matrix is INCOMPLETE due to balances. No signed live purchase or BAG registry deployment claimed by this change.
- Both chains: shared synthetic SDK tests are implementation checks, not real-wallet transactions.
- `DELIVERY_LOG` measures output delivery, not funding-source debit. DCA must separately prove exact authorized spend and bind the inner call/recipient; do not reuse the direct-call result as full forwarded-DCA verification.
- DCA production keeper, chain-specific contract rollout, real authorization lifecycle and public execution are not completed by this SDK change. No release gate or existing live flow is relaxed.

## Validation of this change (2026-11-08)

- SDK suite: **390/390 tests passed**, 22 files. The Base/Arbitrum-focused subset passed 58/58. These are synthetic provider/RPC tests.
- Repository `npm run typecheck`: passed.
- SDK `npm run build --prefix packages/bag-sdk`: passed.
- `npm run smoke:consumer --prefix packages/bag-sdk`: passed; npm tarball installed in a clean temporary consumer, Node ESM imports and NodeNext TypeScript checked with `skipLibCheck: false`, including the new Arbitrum exports.
- `git diff --check`: passed.
- Fresh Arbitrum read-only results are recorded in `docs/SDK_DEPLOYMENT_PIN_ARBITRUM.md`. There were no public writes and no package publication.
