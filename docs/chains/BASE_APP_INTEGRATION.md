# Base in BAG App: smallest integration into `main`

Branch `integration/base-app`, two commits on `main` `4774ac9`. Status 2026-11-14: **local only, not merged, Base not
live in BAG App.** Base contracts are already deployed (`docs/chains/THREE_CHAIN_APP.md`); nothing here redeploys them.

## 1. What `main` already has

- SDK Base path (#152): chain profile, Base purchase checks, approved Composer pin (`docs/SDK_DEPLOYMENT_PIN_BASE.md`).
- Generic creation: `GET /api/deploy/chains` lists Base as deployable as soon as `FACTORY_ADDRESS_BASE` is set
  (`isEvmChainConfigured`).
- Strategy registration reads `STRATEGY_REGISTRY_ADDRESS_BASE` / `STRATEGY_COMPOSITIONS_ADDRESS_BASE`.

**Hazard on `main` today:** setting `FACTORY_ADDRESS_BASE` in production would let users create Base BAGs while
portfolio valuation, sale preview/verification and wallet reconciliation still read only Robinhood. Do not set any
Base variable in production before this branch is merged.

## 2. What this branch adds (and only this)

| Commit | Source | Content |
|---|---|---|
| `8408e07` | cherry-pick of `6fd983a` (`codex/three-chain-bag-flows`) | Per-chain clients for portfolio valuation and sale previews (RPC chain id checked; same address on two chains kept apart; an outage gives unknown, never zero); sale verification on the sale's chain (native and ERC-20 proceeds); mixed-chain legs refused; reconciliation of every supported chain, global freshness only when all chains read; Robinhood-only transfer-log scan kept as an optimisation; Composer multi-buy/sell refuse a wrong-chain transaction instead of rewriting its chain id; Windows path fix in the A4 accounting guard (guard not weakened). Unsigned rollout preparation script (no key, no send path). One conflict resolved: `docs/chains/MULTICHAIN_DCA_SEQUENCE.md` (DCA, out of scope) left out. |
| `2de6675` | app part of `1ac0520` | Create page: asset pool filtered to the selected network and cleared on network change. |

Left out on purpose: `9a532cc` (SDK Arbitrum profile; Arbitrum not approved), `1910e9b` (Base deployment evidence
and the send-capable rollout executor; the evidence belongs with the audit/docs stack, the executor needs its own
review), the SDK pilot files of `1ac0520`. No SQL migration. No settlement change: the attested fee settlement stays
Robinhood-only, so **Base sales carry no performance fee** until a separate change.

## 3. Local verification on this branch

- Typecheck: pass. Base-flow test files touched by the two commits plus purchase-execution and Composer quote tests:
  13 files, 231/231 pass (Windows), including the A4 guard that fails on `main` on Windows.
- Full-suite and build results: see the final report of 2026-11-14 for this branch.

## 4. Independent end-to-end verification still required (each step signs; owner approval needed)

On a staging deployment of this branch with the Base variables set (§5), with a small amount, one wallet:

1. Create and register: user-signed `createBag` on `0x9F66…df4a`, receipt verified, registration in
   `0xcad8…5920` / compositions in `0x7D4A…4Fc8`; the app shows the BAG on Base.
2. Buy (USDC and native ETH): one Composer transaction, verified and booked; holdings on chain 8453.
3. Portfolio: positions valued from Base balances; a Robinhood BAG in the same wallet stays separate.
4. Partial sale, then full sale: proceeds measured on Base, positions reduced, no fee settlement attempted.
5. Reconciliation after an RPC outage: Base balances unknown, never zero.

Only after all five pass may `docs/STATUS.md` call Base "production-qualified" in BAG App.

## 5. Production settings (owner applies after merge and §4; not applied here)

```
FACTORY_ADDRESS_BASE=0x9F66fA3F7a70281eB4F598EfE763B3f83379df4a
STRATEGY_REGISTRY_ADDRESS_BASE=0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920
STRATEGY_COMPOSITIONS_ADDRESS_BASE=0x7D4A75a7F196eA90Cf96021ADAC83a0DE93A4Fc8
EXPLORER_URL_BASE=https://basescan.org
CONFIRMATIONS_BASE=1
BASE_RPC_URL=<provider URL>   # plus BASE_RPC_URL_SECONDARY
```

Contract state re-read on 2026-11-14 (block 57386945): runtime hashes unchanged since deployment; BagFactory owner
`0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46`, pending owner zero, treasury `0x5186f0cCAB569dE1655922213074D97914378cd8`,
creation fee 0.00015 ETH. No redeploy is needed.

## 6. Rollback

Unset `FACTORY_ADDRESS_BASE` (Base no longer deployable; existing Base BAGs stay readable). Code rollback: revert
the two commits.
