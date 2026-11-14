# Chain capability and evidence matrix

The reference for release decisions per chain. Prepared 2026-11-14 on `audit/sdk-first-hardening` (from
`codex/three-chain-bag-flows` `1ac0520`). Each cell carries one evidence level; levels never substitute for each
other. Where this page and an older document disagree, re-check the cited evidence; do not average them.

Levels: `DESIGNED` · `IMPLEMENTED` · `LOCAL_TESTED` · `INTEGRATION_TESTED` · `MERGED` · `PUBLISHED` · `DEPLOYED` ·
`LIVE_VERIFIED` · `PRODUCTION_QUALIFIED` · `NOT_VERIFIED` · `NOT_AUDITED` · `DISABLED` · `BLOCKED` · `—` (not applicable / absent).
Code on `codex/three-chain-bag-flows` is **IMPLEMENTED + LOCAL_TESTED, not MERGED** until that branch is merged.

## 1. Matrix

| Capability | Robinhood 4663 | Base 8453 | Arbitrum 42161 | Ethereum 1 |
|---|---|---|---|---|
| bag.json v1 chain slug (SDK) | PUBLISHED (0.3.0) | PUBLISHED (0.3.0) | PUBLISHED (0.3.0) | PUBLISHED (0.3.0) |
| SDK chain profile (`CHAIN_PROFILES`) | IMPLEMENTED in 0.4.0 candidate | IMPLEMENTED in 0.4.0 candidate | IMPLEMENTED (branch only, `9a532cc`) | — |
| StrategyRegistry | DEPLOYED `0x907c…09a8` · LIVE_VERIFIED registration · NOT_AUDITED | DEPLOYED `0xcAD8…5920`, runtime = artifact (2026-11-14) · no app registration yet | — (predicted `0xcAD8…5920`, deployer nonce still 0) | — |
| StrategyCompositions | — (not deployed; migration 0060 not run) | DEPLOYED `0x7D4A…4Fc8` 2026-11-08 · runtime = journal | — (predicted) | — |
| BagFactory | DEPLOYED `0x7Ce5…6f72` · LIVE_VERIFIED `createBag` · NOT_AUDITED | DEPLOYED `0x9F66…df4a` 2026-11-08 · no `createBag` yet | — (predicted) | — |
| BAG App on the chain | LIVE (bagprotocolv2.netlify.app, STATUS §1) | configured in the maintainer's local env only; production hosting not configured | not configured | — |
| LI.FI Composer pin | approved 2026-10-30 · factory hash = pin (2026-11-14) | approved 2026-11-04 · factory hash = pin (2026-11-14) | OBSERVED, NOT APPROVED (2026-11-08) | — |
| Asset registry (verified rows, Supabase read 2026-11-08) | 198 | 32 | 36 | — |
| SDK asset screening list | — (app registry) | `BASE_PHASE1_REVIEWED_ASSETS` | `ARBITRUM_PHASE1_REVIEWED_ASSETS` (branch) | — |
| Quote | LIVE | LIVE quote via standalone SDK (2026-11-08, `evidence/base-pilot/quote.json`) | fresh compiles PASS (pin doc) | — |
| Unsigned purchase compile | LIVE | LIVE (SDK) | PASS; `eth_call` only with assumed approvals | — |
| Receipt verification | LIVE_VERIFIED (app; SDK 0.3.0 and 0.4.0 candidate, DELIVERY_LOG + BALANCE_DELTA) | LIVE_VERIFIED (SDK 0.4.0 candidate, DELIVERY_LOG, tx `0x21e2…80ee`, 2026-11-04) | — | — |
| Real user-signed purchase | app LIVE_VERIFIED; SDK LIVE_VERIFIED | SDK LIVE_VERIFIED; app NOT run | — | — |
| Redemption / sale | LIVE_VERIFIED (Composer, 50% sale) | IMPLEMENTED (branch), NOT run live | IMPLEMENTED (branch), NOT run live | — |
| Accounting (positions, basis, P&L) | LIVE; realized P&L after partial sale NOT_VERIFIED live | IMPLEMENTED chain-aware (branch), NOT_VERIFIED live | same as Base | — |
| Performance fee settlement | RedeemSettlement v2 DEPLOYED and configured · fee > 0 NOT_VERIFIED · v2 never used live · NOT_AUDITED | — (Robinhood-only by design) | — | — |
| Fork royalty | in v2 · NOT_VERIFIED live | — | — | — |
| Rebalancing | IMPLEMENTED; no live record in STATUS | — | — | — |
| DCA | IMPLEMENTED on Draft PR #145 · NOT MERGED · DISABLED · NOT_AUDITED | — | — | — |
| BAG Router (`BagExecutionRouter`) | MERGED · NOT DEPLOYED · DISABLED (plan-signer trust unresolved) | — | — | — |
| Owner custody | single hot EOA (`../security/PRIVILEGED_AUTHORITY_MATRIX.md`) | same EOA | — | — |
| **Production qualification** | purchases and fee-free sales: in production use; **fee-path NOT qualified** | **NOT qualified**: app lifecycle unrun, SDK 0.4.0 unpublished, owner custody | **NOT qualified** | **NOT qualified** |

## 2. Blockers per chain

- **Robinhood (fee path):** live fee > 0 sale and fork royalty (runbooks exist), PR #147 price confidence, price
  authority live check, owner custody (`SETTLEMENT_ACCOUNTING_AUDIT.md`, `POSITIVE_FEE_LIVE_PROOF_PLAN.md`).
- **Base (app):** the pilot's create → register → buy → partial sell → full sell run with ledger checks
  (`docs/chains/BASE_PILOT.md`); production hosting configuration; SDK 0.4.0 publication decision; owner custody
  before real volume.
- **Arbitrum:** Composer pin approval; contract deployment (re-plan with a fresh deployer, see
  `../security/CREDENTIAL_HARDENING_PLAN.md` §4); a signed live purchase; then the Base list.
- **Ethereum:** format only; nothing scheduled.

## 3. Evidence sources

`evidence/authority/authority-snapshot-2026-11-14.json` (on-chain roles and hashes), `evidence/three-chain-app/`,
`evidence/base-pilot/`, `docs/STATUS.md` §0–§1, `docs/SDK_DEPLOYMENT_PIN_{ROBINHOOD,BASE,ARBITRUM}.md`,
`docs/chains/THREE_CHAIN_APP.md`, `packages/bag-sdk/release-gates.json`, npm registry (`@bagprotocol/sdk` latest
0.3.0, versions 0.0.0-stage, 0.2.0, 0.2.1, 0.3.0; read 2026-11-14).
