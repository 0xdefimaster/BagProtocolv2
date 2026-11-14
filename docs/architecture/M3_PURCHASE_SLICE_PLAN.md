# M3: the first purchase slice BAG App shares with the SDK

Status 2026-11-14: **M3a IMPLEMENTED locally** on branch `feat/m3a-sdk-compile` (stacked on
`audit/m2-security-closure`), **not merged, not enabled** (`BAG_SDK_COMPOSER_COMPILE` default off); see §3.5. M3b not
started. Earlier status line, kept: Prerequisite M2 work is local and unmerged (F-01 fix in the default binding;
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

### 3.5 As implemented (2026-11-14)

- **SDK:** `compilePlannedPurchase(planned, { provider, trust })` (`packages/bag-sdk/src/execution.ts`, exported). It
  was necessary: `compileBag` always plans with `planPurchase`, whose allocation differs from the app's (KNOWN
  DIFFERENCE) and whose legs it orders itself. The caller's plan is validated (lowercase distinct leg tokens, whole-bp
  shares summing to 10000, positive amounts, slippage and impact bounds, definition hash or null) before any provider
  call; the response goes through the same `checked(...)` as `compileBag`. `compileBag` now calls the same
  internal `compileChecked`. `checked(...)` also refuses a structurally malformed result (null, missing arrays) as
  `PROVIDER_RESPONSE_INVALID` instead of a TypeError. `definitionHash: null` maps to the zero hash: the app's
  strategy identity stays the intent's own.
- **App:** `lib/blockchain/composer-sdk-compile.ts`, wired into `tryBuildComposerSteps`. The legacy compile runs
  through a recording fetch; the SDK's `lifiComposer` gets a replay fetch that answers only a request equal to the
  recorded one (same URL and method; same JSON body except the flow's display id, and `run.maxPriceImpactBps` when the
  app sent none). A probe of both adapters showed exactly these differences. No second Composer call.
- **Trust:** `resolveLifiComposerAccount` with the reviewed pin from `COMPOSER_FACTORY_<CHAIN>` /
  `COMPOSER_FACTORY_CODE_HASH_<CHAIN>` and the chain's RPC client; the trust policy is the resolved account's
  (target: factory before first use, proxy after; spender: proxy). Nothing comes from the API response.
- **Comparison:** transaction to/data/value/chain, user proxy, approvals, and each leg's expected and enforced minimum
  output. Verdicts `MATCH` / `MISMATCH` (reason codes) / `REFUSED` (SDK error code) / `UNAVAILABLE`
  (`NO_REVIEWED_DEPLOYMENT`, `NOT_RECORDED`, `ERROR`). Log line `[sdk-compile-<mode>] chain=… legs=… verdict=…`.
- **on:** proceeds only on `MATCH` (byte-identical result to `off`); otherwise the purchase fails with an
  `UNAVAILABLE` notice (`kind: 'sdk_compile_check'`), **native-ETH included**: the per-asset fallback a native
  purchase keeps after a Composer refusal would sign LI.FI-supplied targets no reviewed pin covers, so an unconfirmed
  (possibly hostile) compile must not reach it. The cross-check has a 10 s deadline (`UNAVAILABLE: TIMEOUT`).
  **shadow:** legacy result always.
- **Unchanged:** the signed program (no delivery proof), allocation, accounting, verification, strategy identity,
  standalone vs BAG-accounted boundary.
- **Tests:** `packages/bag-sdk/test/compile-planned.test.ts` (caller order kept, malicious target/spender/approval
  token/amount, wrong or reordered legs, low minimums, chain/value, price impact, malformed responses, invalid plans
  never reach the provider, empty or wrong-chain trust); `lib/blockchain/__tests__/composer-sdk-compile.test.ts`
  (real legacy + real SDK adapters over a fake API: MATCH first use and deployed proxy, accepted impact limit, target /
  spender / user proxy outside the resolved account, missing or low minimum, factory runtime ≠ pin, request mismatch,
  tampered legacy bytes, no pin, RPC failure); `composer-sdk-compile-modes.test.ts` (off / shadow / on through
  `buildPurchaseIntentSteps`).
- **Before shadow in production (approval):** set the per-chain pins (Robinhood, Base, Arbitrum) in the deployment
  environment from the reviewed `docs/SDK_DEPLOYMENT_PIN_*.md`; then `BAG_SDK_COMPOSER_COMPILE=shadow` on staging;
  acceptance per §3.3. Not done.

## 4. M3b — delivery proof (changes what users sign; approval and live runs required)

`lifiComposer({ deliveryProof: true })` adds `BagDelivered` balance checks inside the program. The app then verifies
with the SDK's delivery evidence instead of Transfer sums, which removes the remaining accounting dependency the M2
review lists as unverified (Composer-internal refunds or transfers). Gates: M3a on; M2 shadow evidence; a live
smart-account and EOA purchase on each served chain with `DELIVERY_LOG` verified and booked amounts equal to the
delivered deltas; rollback by flag.

## 5. Then

M4: resolve the zero-allocation KNOWN DIFFERENCE and move allocation to `planPurchase`. M5: validation through
`validateBag`. The SDK 0.4.0 release decision is independent and stays with the maintainer.
