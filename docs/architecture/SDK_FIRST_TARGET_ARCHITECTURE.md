# SDK-first target architecture

Goal: whenever BAG App performs a **public** operation (strategy validation, execution preparation, transaction
verification), an independent developer can do the same through the published SDK with the same security
guarantees. Accounting, attestation and user management stay outside the SDK. Decision record: `SDK_FIRST_DECISION.md`.

## 1. Components

```text
                         BAG PROTOCOL ECOSYSTEM
                                   │
            ┌──────────────────────┴──────────────────────┐
            │                                             │
        BAG APP (reference app)                  THIRD-PARTY APPS
  UI, SIWE session, portfolio views,       wallets, fintech, agents,
  intents, notifications                   portfolio tools
            │                                             │
            │   public operations (same code, same tests) │
            └──────────────────────┬──────────────────────┘
                                   │
                     @bagprotocol/sdk (npm, viem-only core)
      ┌──────────────────┬─────────┴─────────┬─────────────────────┐
      │ Strategy core    │ Execution prep    │ Verification        │
      │ parse/validate/  │ planPurchase,     │ verifyPurchaseReceipt│
      │ hash, registry   │ compileBag,       │ DIRECT / CALL_TRACE /│
      │ verify, chain    │ quoteBag,         │ wallet-batch (M2)    │
      │ profiles, asset  │ simulateBag,      │ DELIVERY_LOG,        │
      │ screening        │ selectExecPath    │ BALANCE_DELTA        │
      └──────────────────┴─────────┬─────────┴─────────────────────┘
                                   │ adapters: /lifi (Composer), /evm, /http
                                   │ future providers only after qualification
                                   │
                      Chains: Robinhood · Base · (Arbitrum) ─── user's wallet signs every transaction
                                   │
   ┌───────────────────────────────┴───────────────────────────────────┐
   │ Contracts: StrategyRegistry, StrategyCompositions, BagFactory,     │
   │ RedeemSettlement (+ CreatorRewardsVault, RedeemFeeRouter, Router:   │
   │ not deployed)                                                     │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │
   BAG services (server only, never in the SDK): purchase/redeem intents, ledger
   (positions, cost basis, P&L), settlement attestor, creator rewards, reconciliation
   crons, price authority, MCP (read-only, hosted)
```

## 2. Two execution contexts

| | `STANDALONE_EXECUTION` | `BAG_ACCOUNTED_EXECUTION` |
|---|---|---|
| Who | any app with the SDK | BAG App (or a future authenticated hosted API) |
| Preparation | SDK | the same SDK functions, called by the server for an intent |
| Authorization | the user's wallet | the user's wallet |
| Verification | SDK, caller's own chain reader | the same SDK verification, plus intent binding (session wallet, stored transaction, tx-hash claim) |
| Result | `accounting: 'NOT_BAG_ACCOUNTED'` | booked by `apply_purchase_execution`; position, cost basis, redemption, fees, royalties |
| Fees and royalties | never | only through the existing settlement rules |

A standalone purchase never turns into an accounted position by being observed later. Adopting it into BAG
accounting would be a separate, explicit, authenticated operation with its own trust model; none exists today and
none is proposed here.

## 3. Rules

1. The SDK never signs or sends (enforced by `packages/bag-sdk/test/boundary.test.ts`).
2. No backend credential, service-role key, attestor or plan signer appears in the SDK or in browser bundles.
3. The app replaces a private implementation with the SDK's only when an equivalence test proves the same output or
   pins every difference, and when a change of signed transaction has its own live verification.
4. Verification may only get stricter when shared; never weaker (the app's containment check is not exported as is).
5. New providers (Enso, CoW, 0x, …) enter through the existing provider interface, after a qualification run per
   chain; nothing speculative is implemented.

## 4. What changes, in order

The migration is staged in `SDK_FIRST_MIGRATION_PLAN.md`: shared exact wallet-batch binding (fixes T-1 in both),
delivery-proof compilation in the app, then purchase planning, then validation. The strategy core, partition
planning and registry verification are already shared.
