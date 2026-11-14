# SDK ↔ app dependency map

Traced 2026-11-14 on `audit/sdk-first-hardening` (from `1ac0520`). Imports are from source; "SDK" means
`packages/bag-sdk/src` (the app imports it as `@/packages/bag-sdk/src`, not from npm).

## 1. What the app already takes from the SDK (production code)

| App file | SDK import | Purpose |
|---|---|---|
| `lib/domain/basket-protocol/bag-json.ts` | `canonicalJson`, `computeDefinitionHash`, `definitionHashPreimage`, `normalizeDefinition` (re-exported) | the app's bag.json hashing **is** the SDK's |
| `types/strategy.ts` | `BAG_JSON_HASH_DOMAIN` | same hash domain |
| `lib/blockchain/registry-browser-verify.ts`, `hooks/use-registry-browser-verification.ts` | `parseBag`, `verifyRegistryCommitment`, `STRATEGY_REGISTRY_DEPLOYMENTS`, `RegistryClient` | in-browser registry verification (Strategy Registry panel) |
| `lib/blockchain/lifi-composer-adapter.ts`, `lib/blockchain/lifi-purchase-quote.ts`, `lib/execution/providers/lifi-composer-provider.ts` | `planPartition`, `planPartitionLegs`, `PartitionError` | Composer `core.partition` planning |
| `lib/server/rebalance-quote.ts` | `largestRemainderBps` | weight rounding |
| `lib/blockchain/wallet-sweep-client.ts` | `hasAtomicBatchCapability` | EIP-5792 capability check |

## 2. Purchase flow, stage by stage

| # | Stage | Entry point → function | Security checks | SDK equivalent | Tests |
|---|---|---|---|---|---|
| 1 | UI | `components/app/PurchasePreviewModal.tsx` → `usePurchaseExecution` (`hooks/use-purchase-execution.ts`), `usePurchaseOptions`, `usePurchasePrefetch` | `deriveSigningExpectation` (`lib/execution/signing-expectation.ts`) shows what will be signed | none (presentation) | hook tests in `hooks/__tests__/` |
| 2 | Wallet + session | `lib/wallet-context`; SIWE `app/api/auth/{nonce,verify,session}` → `requireSession` | session-bound wallet; rate limits per route | none (app-specific) | auth tests |
| 3 | Preview | `app/api/bags/[id]/purchase-preview/route.ts` → `computePurchasePreview` (`lib/server/purchase-preview.ts`) | registry identity check `validateRecipeAssetsAgainstRegistry` | `planPurchase`, `quoteBag` | preview tests |
| 4 | Options | `…/purchase-options` → `getPurchaseOptionsForUser` (`lib/server/purchase-execution.ts:920`) | candidate ranking refuses "best" with < 2 candidates or ties (`lib/execution/candidate-ranking.ts`) | `selectExecutionPath` (path only, no providers) | ranking tests |
| 5 | Intent | `…/purchase-intent` → `createPurchaseIntentForUser` (`:626`): `calculateDepositAllocation`, `buildExecutionPlan`, `computeExecutionPlanFingerprint`, stock-token guard, route check, fee-sale lock | weights must sum to 10000; registry-verified assets; no purchase while a fee sale is open | `parseBag` + `validateBag` + `planPurchase` (**duplicated**, parity-tested, one KNOWN DIFFERENCE) | `sdk-app-partition-parity`, `bag-sdk-consistency` |
| 6 | Compile | legacy path (live): `buildPurchaseIntentSteps` → `buildComposerPurchase` (`lib/blockchain/lifi-composer-adapter.ts`). Compiler path (`BAG_EXECUTION_COMPILER_ENABLED`, **off**): `compileBagExecution` (`lib/execution/compiler.ts`) | minimum outputs, price-impact limit, trusted targets | `compileBag` + `lifiComposer` (**duplicated**; same Composer program and same transaction proven) | `sdk-app-composer-flow-parity`, `sdk-app-purchase-verification-parity` |
| 7 | Prepare | `/api/purchase-intent/[id]/execute` → `prepareExecution` (`:1026`) | re-quote; transaction stored on the intent | `compileBag` | purchase-execution tests |
| 8 | Authorization | hook: `ensureErc20AllowanceOnChain` (exact amount), `simulateTransactionOnChain` (eth_call), `walletClient.sendTransaction` (`lib/blockchain/lifi-wallet-client.ts`) | bounded approval; dry run before signing; the user's wallet signs | `simulateBag`; the SDK never signs | hook tests |
| 9 | Report | `…/step/[i]/report` → `recordStepEvent` (`:1250`), `claimNewlyVerifiedTxHashes` | one transaction hash per intent (replay) | none (app state) | report route tests |
| 10 | Verify | `…/verify` → `verifyExecution` (`:1391`) → `trackComposerTransaction` (`lib/blockchain/composer-status.ts:120`) | sender, target, calldata, value binding; wallet batches by calldata containment; Transfer-log outputs ≥ `minOutputRaw` | `verifyPurchaseReceipt` (**duplicated, different trust model**, see §3) | `composer-status.test.ts`, parity test |
| 11 | Accounting | `verifyExecution` → `admin.rpc('apply_purchase_execution')` (`:1850`, migration 0004), `apply_partial_purchase_execution` (`:1756`), `recordNavSnapshot` | service-role DB, atomic booking | none: SDK results say `accounting: 'NOT_BAG_ACCOUNTED'` | integration tests (Postgres) |
| 12 | Result | hook state → modal | — | — | — |

## 3. Verification: same verdict, different trust model

Proven equal (`lib/blockchain/__tests__/sdk-app-purchase-verification-parity.test.ts`): for a direct call, both
verifiers return success with identical per-token amounts; both refuse another calldata, sender, native value, or a
revert.

Different on purpose or by gap:

- **D-1** (envelope): a smart-account batch carrying the exact call is DONE for the app (containment,
  `isWalletRoutedBatch`) and INDETERMINATE for the SDK unless the reader supplies a call trace.
- **T-1** (gap, both): other calls in the same batch are not excluded; the app credits all Transfers to the wallet,
  and the SDK's batched balance delta includes them (`DELIVERY_LOG` does not). Details in
  `../security/EXECUTION_TRUST_BOUNDARY_REVIEW.md`.
- The SDK can prove delivery inside the Composer program (`DELIVERY_LOG`) and balance deltas; the app compiles
  without delivery proof, so it cannot use that evidence today.

## 4. Other flows (summary)

| Flow | App implementation | SDK |
|---|---|---|
| Sale / redeem | `lib/server/redeem-execution.ts`, `redeem-composer.ts`, same `trackComposerTransaction` | none |
| Fee settlement | `lib/server/redeem-settlement-attestation.ts` (attestor signs) | none (privileged) |
| Strategy registration | `lib/server/strategy-registration.ts` prepare/confirm (user signs, server verifies receipt) | read-only `verifyRegistryCommitment`, `readRegistryRecord` |
| Asset capability | Supabase registry (`lib/server/asset-repo.ts`) | `createAssetCapabilityRegistry`, `screenPurchaseAssets` with reviewed lists |
| Rebalance | `lib/server/rebalance-*.ts` | none |
| MCP | `app/api/mcp/route.ts` (read-only) | — |
