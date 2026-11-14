# M3: the first purchase slice BAG App shares with the SDK

Status 2026-11-14: **PLAN, not started.** Prerequisite M2 work is local and unmerged (F-01 fix in the default binding;
exact binding behind `BAG_WALLET_BATCH_BINDING`, default off). Historical replay is blocked on database access, and
no BAG user's smart-account transaction has been observed under the exact binding yet. M3a below changes no signed
transaction and may start after the F-01 fix merges; M3b changes what users sign and waits for M2's shadow evidence.

## 1. Two execution contexts, kept apart

| | STANDALONE_EXECUTION | BAG_ACCOUNTED_EXECUTION |
|---|---|---|
| Entry | `@bagprotocol/sdk` `compileBag` (`packages/bag-sdk/src/execution.ts`) | `createPurchaseIntentForUser` → `prepareExecution` (`lib/server/purchase-execution.ts`) |
| Signing | the user's wallet | the user's wallet |
| Verification | `verifyPurchaseReceipt` (`packages/bag-sdk/src/receipt.ts`), result `accounting: 'NOT_BAG_ACCOUNTED'` | `recordStepEvent` → `verifyExecution` → `trackComposerTransaction` (`lib/blockchain/composer-status.ts`) |
| Position, cost basis, fees, royalties | none | `apply_purchase_execution` (migration 0004) after verification; fees and royalties only through the existing settlement rules |
| Binding to an account | none | a session-owned intent with the server-built `composerTransaction`; one transaction hash per intent (`claimNewlyVerifiedTxHashes`, `lib/server/intent-tx-claims.ts`) |

Rules that keep them apart (true today, kept by M3): the SDK never writes accounting; no app route books a transaction
that was not compiled for a session-owned intent; an SDK-verified standalone purchase cannot be imported as a position
(no such API exists, and none is planned in M3). Sharing code is about compile and verify, never about accounting.

## 2. What is already shared and what is not

| Concern | BAG App (exact path) | SDK (exact path) | State |
|---|---|---|---|
| bag.json hash, normalization | `lib/domain/basket-protocol/bag-json.ts` re-exports | `packages/bag-sdk/src/definition.ts` | shared |
| Partition planning | `lib/blockchain/lifi-purchase-quote.ts` (`planPartitionLegs`) | `packages/bag-sdk/src/partition.ts` | shared |
| Transaction binding (envelopes, wallet state) | `lib/blockchain/composer-status.ts` (`verifyWalletExecution` under enforce) | `packages/bag-sdk/src/wallet-envelope.ts` | shared (M2) |
| Decision vocabulary | `composerOutcomeDecision` | `packages/bag-sdk/src/decision.ts` | shared (M2) |
| Composer program building | `lib/blockchain/lifi-composer-adapter.ts` `buildComposerPurchase`, called from `tryBuildComposerSteps` (`lifi-purchase-quote.ts`) | `packages/bag-sdk/src/adapters/lifi.ts` `lifiComposer` | duplicated; same program proven (`sdk-app-composer-flow-parity.test.ts`) |
| Compile-result trust checks | approvals: format and amount ≤ input only (`lifi-composer-adapter.ts`); **no per-transaction allowlist for the target or the approval spender** | `compileBag` → `checked(...)` against `ExecutionTrustPolicy` (`allowedTransactionTargets`, `allowedApprovalSpenders`), account from `resolveLifiComposerAccount` (`adapters/composer-account.ts`) | **gap in the app** (see 3.1) |
| Allocation | `lib/domain/basket-protocol/deposit/allocation.ts`, `deposit/execution-plan.ts` | `planPurchase` (`purchase.ts`) | duplicated; one KNOWN DIFFERENCE (zero-allocation legs) |
| Delivery evidence | Transfer-log sums | `DELIVERY_LOG` (`deliveryProof`) | app lacks it |
| Simulation before signing | `simulateTransactionOnChain` (`lib/blockchain/lifi-wallet-client.ts`, client) | `simulateBag` | duplicated; not in M3 |

Out of scope, unchanged: StrategyRegistry, Passport, hashing, the provider-independent compiler (`lib/execution/`),
redemption and rebalance compilation, settlement.

## 3. M3a — compile through the SDK adapter and trust checks (no signed-transaction change)

### 3.1 Why first

The app signs whatever transaction target and approval spender the Composer API returns: they are not compared with
a reviewed deployment per transaction (the factory code hash is only a chain-readiness gate,
`lib/blockchain/chain-readiness.ts`). The SDK already enforces caller-owned allowlists and tells integrators not to
derive the account from `transactionRequest.to` / `userProxy` (`packages/bag-sdk/README.md`). Sharing that check is
the highest-value, lowest-risk step: same program, same bytes, one more refusal path.

### 3.2 Changes

1. **SDK (additive API, review):** split `compileBag` into `planPurchase` + a new export
   `compilePlannedPurchase(plan: PurchasePlan, options: { provider; trust })` containing today's
   `trustedContracts` → `provider.compile(requestFor(plan))` → `checked(...)`. `compileBag` keeps its signature and
   calls it. Tests: every existing `compileBag` test unchanged; direct tests of the new export.
2. **App (behind `BAG_SDK_COMPOSER_COMPILE` = `off` | `shadow` | `on`, default off):** in `tryBuildComposerSteps`,
   build a `PurchasePlan` from the app's own `partitioned.legs`, `totalInputRaw`, input kind, slippage and
   price-impact limit (so the KNOWN DIFFERENCE in allocation does not block this slice), resolve the wallet's
   Composer account with `resolveLifiComposerAccount` from the reviewed per-chain deployment
   (`COMPOSER_FACTORY_<CHAIN>`, `COMPOSER_FACTORY_CODE_HASH_<CHAIN>`), and call `compilePlannedPurchase` with
   `lifiComposer({ deliveryProof: false })` and a trust policy derived from that resolution. Map `CompiledPurchase`
   to the fields the steps use today (`transactionRequest`, `approvals`, per-leg expected and minimum outputs,
   `priceImpact`, `fees`, `userProxy`), and SDK errors to the existing `composerFallbackFrom` notices.
3. **Shadow:** compile both ways; log only whether the transaction bytes, approvals and per-leg minimums are
   identical (they must be) and any SDK trust refusal. Two compile calls per purchase in shadow: staging first.

### 3.3 Acceptance

- Identical `composerTransaction` (to, data, value) and step records for the parity corpus (2 to 100 legs, ERC-20
  and native input) under `on` vs `off`.
- An injected Composer response with an unexpected target or spender is refused under `on` (new adversarial tests).
- Shadow in staging: zero byte differences, zero unexplained trust refusals over a sample of real compiles.
- Full checks green; no change to verification, accounting or the signed transaction.

### 3.4 Rollback

Flag `off`. Nothing persisted changes shape.

## 4. M3b — delivery proof (changes what users sign; approval and live runs required)

`lifiComposer({ deliveryProof: true })` adds `BagDelivered` balance checks inside the program. The app then verifies
with the SDK's delivery evidence instead of Transfer sums, which removes the remaining accounting dependency the M2
review lists as unverified (Composer-internal refunds or transfers). Gates: M3a on; M2 shadow evidence; a live
smart-account and EOA purchase on each served chain with `DELIVERY_LOG` verified and booked amounts equal to the
delivered deltas; rollback by flag.

## 5. Then

M4: resolve the zero-allocation KNOWN DIFFERENCE and move allocation to `planPurchase`. M5: validation through
`validateBag`. The SDK 0.4.0 release decision is independent and stays with the maintainer.
