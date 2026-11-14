# SDK public capability matrix

Classification of each protocol operation, from the exports of `packages/bag-sdk/src/index.ts` (0.4.0 candidate;
npm `latest` is 0.3.0) and the app code traced in `SDK_APP_DEPENDENCY_MAP.md`.

Classes: `ALREADY_PUBLIC` · `PUBLIC_BUT_INCOMPLETE` · `INTERNAL_REUSABLE` · `SERVER_ONLY` · `APP_SPECIFIC` ·
`PRIVILEGED` · `DUPLICATED` · `LEGACY` · `MISSING` · `NOT_RECOMMENDED`.

| Operation | SDK export(s) | App | Class | Belongs in |
|---|---|---|---|---|
| Parse, validate, normalize, hash bag.json | `parseBag`, `validateBag`, `normalizeBag`, `computeDefinitionHash`, `hashBag`, `canonicalJson` | re-exports SDK hashing (`bag-json.ts`); own app-side validation for its form and registry | ALREADY_PUBLIC (hash shared; validation partly DUPLICATED) | SDK |
| Registry verification | `verifyRegistryCommitment`, `checkRegistryCommitment`, `readRegistryRecord`, `registryStrategyId` | uses SDK in the browser | ALREADY_PUBLIC, shared | SDK |
| Chain profiles | `CHAIN_PROFILES`, `getChainProfile` | `lib/config/chains.ts` | PUBLIC_BUT_INCOMPLETE (Arbitrum only on branch) | SDK |
| Asset screening | `createAssetCapabilityRegistry`, `screenPurchaseAssets`, reviewed lists | Supabase registry (198/32/36 rows) | DUPLICATED by design (app has a larger verified set) | SDK interface + app-provided registry |
| Partition / split | `planPartition`, `planPartitionLegs`, `splitByWeight`, `largestRemainderBps` | uses SDK | ALREADY_PUBLIC, shared | SDK |
| Purchase plan | `planPurchase` | `calculateDepositAllocation` + `buildExecutionPlan` | DUPLICATED (parity-tested; KNOWN DIFFERENCE for zero-allocation legs) | SDK, after the open decision |
| Quote / compile unsigned purchase | `quoteBag`, `compileBag`, `lifiComposer` adapter | `buildComposerPurchase` | DUPLICATED (same program, same transaction, tested) | SDK |
| Simulate | `simulateBag` | `simulateTransactionOnChain` (client) | DUPLICATED | SDK |
| Execution path selection | `selectExecutionPath`, `hasAtomicBatchCapability` | uses `hasAtomicBatchCapability` | ALREADY_PUBLIC, partly shared | SDK |
| Delivery proof | `DELIVERY_PROOF_SIGNATURE`, compile option | not used | MISSING in app | SDK (app should adopt) |
| Receipt verification | `verifyPurchaseReceipt` (`DIRECT`/`CALL_TRACE`; `TRANSFER_LOGS`/`BALANCE_DELTA`/`DELIVERY_LOG`), `withReceiptEvidence` | `trackComposerTransaction` | DUPLICATED, different trust model (D-1, T-1) | SDK (shared binding function, milestone M2) |
| Smart-account batch binding without trace | none | `batchContainsCall`, `isWalletRoutedBatch` (containment) | MISSING in SDK; app version NOT_RECOMMENDED as-is (T-1) | SDK, exact-batch decoding |
| Error classification | `BagSdkError`, `getSdkErrorInfo`, `SDK_ERROR_MESSAGES` | `PurchaseIntentFailureCode` | APP_SPECIFIC mapping on top of SDK codes | both |
| Provider-independent compiler, candidate ranking | none | `lib/execution/*` (disabled live) | INTERNAL_REUSABLE | later SDK adapter, after live qualification |
| Signing / broadcasting | never | user's wallet only | — | wallet; a signing helper in the SDK is NOT_RECOMMENDED |
| Purchase intents, positions, cost basis, P&L | none | Supabase + `apply_purchase_execution` | SERVER_ONLY | app / optional hosted service |
| Fee settlement attestation | none | attestor key | PRIVILEGED | server only |
| Registration prepare/confirm with booking | read-only verify | server flow | APP_SPECIFIC | app |
| Creator rewards, vault settlement | none | cron + settler key | PRIVILEGED | server only |
| BAG Router plan signing | none | `createBagRouterPlanSigner` | PRIVILEGED, DISABLED | server only, if ever enabled |
| Read-only MCP | — | `app/api/mcp` | APP_SPECIFIC (hosted) | optional hosted service |
| DCA executor and keeper | `/dca` on PR #145 only | PR #145 | DESIGNED/IMPLEMENTED, NOT MERGED | separate, after review |

## Boundary rules that hold today (verified)

- The SDK never signs or sends (`compileBag` returns an unsigned transaction; no wallet client in the package).
- `packages/bag-sdk/test/boundary.test.ts` and the packed consumer smoke keep the package free of app imports.
- Every SDK receipt result carries `accounting: 'NOT_BAG_ACCOUNTED'`: a standalone purchase never becomes a
  BAG position, fee or royalty by itself.
