# Positive-fee live proof plan

The procedure is `docs/runbooks/POSITIVE_FEE_SALE.md` (owner-run, stop conditions, verification, recording).
This page adds the gates that must hold before it is run and the approval record it needs. Nothing here has been
executed.

## Gates

| Gate | Status 2026-11-14 | Evidence |
|---|---|---|
| G1 Contract = reviewed source | PASS: v2 runtime equals the current artifact outside immutables and metadata | `../security/SETTLEMENT_ACCOUNTING_AUDIT.md` §1 |
| G2 v2 configured, attestor key matches on-chain attestor | owner check (`deploy-redeem-settlement.ts --verify`); on-chain attestor `0xFf60…dff2` read 2026-11-14 | runbook §1.1 |
| G3 No unbooked earlier settlement | owner check (`scripts/audit-settlement-events.ts`) | runbook §1.3 |
| G4 Price confidence decided | OPEN: PR #147 is Draft, 30 commits behind `main`; merge it or record a waiver for this one run | `PRICE_AUTHORITY_QUALIFICATION.md` |
| G5 Owner custody | OPEN: owner is the hot EOA; acceptable only if the maintainer accepts it for a ≤ 10 USDG proof, in writing | `../security/CREDENTIAL_HARDENING_PLAN.md` |
| G6 Wallets | creator C ≠ investor I; neither is `0xa1BA…`; C not frozen by USDG | runbook §2 |

## Approval record (fill before running; required by the release policy)

```text
Network:            Robinhood Chain (4663)
Contract:           RedeemSettlement v2 0x3eCD734eb53370c2795DB6Ca3CB2B1de0BEdF8A3
Creator wallet C:   0x…            Investor wallet I: 0x…
Bag:                id …, fee rate … bps, assets …
Purchase amount:    … USDG (≤ 10)   Expected sale: … USDG, expected fee: … USDG (from the app preview)
Transactions:       create+deploy (C), purchase (I, + approval), sale (I, + approvals) = … total
Stop conditions:    runbook §0 accepted
Approved by:        … (maintainer), date …
```

## Success criteria

`Settled` event for the redemption id with `fee > 0`; transfers equal the event; the ledger books gross legs plus
`FEE_CHARGED`; `scripts/verify-money-flows.ts` checks pass; STATUS updated from NOT VERIFIED with the hashes.
A revert with the user keeping holdings is a safe failure, not a pass.
