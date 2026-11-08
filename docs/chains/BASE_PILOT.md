# Base pilot: one complete user journey

2026-11-08. Scope chosen by the maintainer: finish Base's existing product journey and demonstrate the independent SDK before adding more networks, DCA, wallets or agents. Arbitrum public rollout remains deferred.

## The result we are trying to prove

An app user can create a basket, buy its allocation, sell half and sell the remainder, with receipts and positions agreeing. Separately, an external developer can quote and buy the same allocation from the SDK without BAG's application or database. These are distinct exercises: a standalone SDK purchase does not create a BAG app position.

## Application exercise

Use the local checkout configured with the verified Base contracts (`THREE_CHAIN_APP.md`). Open `/dashboard/create` in a browser with MetaMask or Rabby. A browser without an injected wallet can inspect the form but cannot complete it.

1. Connect the owner's chosen wallet and sign the normal login challenge. No backend private key is used for this flow.
2. Choose **Base**. Choose **WETH** and **CBBTC**, at **50% / 50%**. Set a unique name, **Manual**, zero creator performance fee, and **2 USDC** first buy. Keep the default 100 bps slippage; changing risk limits is not a remedy for a failed quote.
3. Review the creation charge: **0.00015 ETH plus gas** at the current factory setting. The first buy adds **2 USDC plus gas**. Registration/composition publication and any token approvals also require wallet confirmations and gas. Read the current wallet estimate; no fixed total gas promise is made.
4. Deploy, register the definition and publish its composition through the existing wallet flow. Save the BAG URL/id and transaction hashes. The application must show the mined deployment and matching strategy version; clicking a button is not proof.
5. Review the fresh first-buy quote and complete the wallet purchase. Save the purchase intent id and hash. Verify the receipt and that the app records only this wallet's delivered amounts, position and cost basis.
6. Sell **50%** of that app position into native USDC on Base. Verify proceeds, reduced holdings, remaining shares and reduced basis. Do not treat `PENDING`, `INDETERMINATE` or a quoted amount as completed settlement.
7. Sell the remaining position. Verify the second receipt and that the app position closes without selling unrelated wallet holdings. Record any dust explicitly. Refresh/reconnect and confirm the state is preserved.

The wallet owner reviews and sends all public transactions. No public trade is authorized merely by running a smoke test. A failed or delayed verification must not trigger a duplicate purchase or sale.

## Independent SDK exercise

Deliver `examples/sdk-consumer` with the packed SDK and its checksum. Use `BASE_PILOT.md` in that directory. It has no imports into the BAG application and requires no Supabase credentials. Its implemented scope is **validation, unsigned purchase preparation, simulation and receipt verification**. Application selling/position accounting has not been exported as SDK functionality.

Measure setup time, help needed, stable error codes, and whether the developer would integrate it into a real project. Recruit testers separately; do not claim independent adoption from the maintainer's own run. Feedback questions are in the starter's guide.

## Evidence status

| Step | Evidence required | Current status |
|---|---|---|
| Base contracts/config | Receipts, runtime, immutable values, app configuration | PASS: `evidence/three-chain-app/` |
| Create form | Actual Base assets, weights, fee, payment token, wallet boundary | Inspected locally; no draft saved or transaction sent |
| Network switching | No previous-chain tokens selectable while loading/failing | Fixed; create-page and three-chain adapter checks: 16/16 PASS |
| Standalone install | Package installed outside repo, strict build, offline demo/hash | PASS: `evidence/base-pilot/validation.json`; offline receipt is SYNTHETIC_ONLY |
| Fresh SDK quote | Live Composer reply through standalone package, no signing | Quote received for 2 USDC WETH/cbBTC, impact -26 bps. Simulation: INSUFFICIENT_BALANCE (maintainer account has 0 USDC); no swap execution proved. See `quote.json` and `check.json` |
| Public app lifecycle | Create/register/buy/partial sell/full sell hashes + ledger checks | PENDING wallet-owner run |
| Independent integration | A different developer completes setup and reports feedback | NOT_RUN |

Passing the first rows does not automatically pass the remaining rows. This pilot is a way to decide what to improve from actual usage, not a claim that the SDK has product-market fit.
