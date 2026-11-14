# SDK-first migration plan

Each milestone is one reviewable PR, keeps existing hashes and public exports, and does not mix a refactor with a
settlement or security behavior change. Complexity: S (≤ 1 day), M (2–4 days), L (≥ 1 week).

## M0: baseline, guards and evidence (DONE locally, this session)

Scope: secret-scan template fix, Vitest drive-letter guard, authority snapshot script, T-1 characterization tests,
documentation. Commits `6e603cf`, `e22d937`, `8d636c9`, `4ad5041` on `audit/sdk-first-hardening`.
Acceptance: full suite green (baseline 2691/195), CI secret scan passes. Rollback: revert commits. Complexity: S.

## M1: end-to-end equivalence harness (DONE locally)

Scope: `lib/blockchain/__tests__/sdk-app-purchase-verification-parity.test.ts`: bag.json → plan → both compilers
→ same transaction → same receipt → same verdict and amounts; D-1 pinned. Commit `2dbae5b`. Test-only.
Complexity: S.

## M2: shared exact wallet-batch binding (YELLOW: review, then live check)

**Status 2026-11-14: IMPLEMENTED locally, default OFF, not deployed, not verified with a BAG user's live
transaction.** SDK: `packages/bag-sdk/src/wallet-envelope.ts` (`bindWalletEnvelope`, `checkWalletExecutionState`,
`verifyWalletExecution`) and `verifyPurchaseReceipt({ smartAccountBinding: 'EXACT' })`. App: `BAG_WALLET_BATCH_BINDING`
= `off` | `shadow` | `enforce` in `trackComposerTransaction`, wired for purchase, redeem and rebalance. Pins verified
on-chain for Robinhood, Base and Arbitrum; three real MetaMask EIP-5792 batches on Base bind
(`evidence/smart-account/`). Next: the shadow runbook (`docs/runbooks/WALLET_BATCH_BINDING_SHADOW.md`). The original
plan below differs in two places, both stricter: the wallet's pre-block code must be the pinned delegate, and
`executeBatch(Call[])` is refused (not an entry point of the MetaMask account).

- Scope: an SDK function that decodes the wallet envelopes the app already supports (ERC-7579 batch and single,
  `executeBatch(Call[])`, MetaMask `DelegationManager.redeemDelegations`) and accepts a batch only when its calls
  are exactly the expected set: the compiled call plus approvals to allowed spenders for at most the input amount.
  `verifyPurchaseReceipt` uses it as a third binding (`WALLET_BATCH_EXACT`); the app replaces `isWalletRoutedBatch`
  with it for purchases, sales and rebalances.
- Files: `packages/bag-sdk/src/receipt.ts` (+ new `wallet-envelope.ts`), `lib/blockchain/composer-status.ts`,
  `lib/blockchain/composer-tx-search.ts`, tests.
- Acceptance: every accepting case in `composer-status.test.ts` still accepts; T-1 tests flip to refusal; D-1 becomes
  agreement; new negative cases (extra call, extra approval, approval above input, reordered duplicate call).
- Security gate: a MetaMask smart-account purchase and sale on Robinhood verified with the new binding in shadow
  mode (log both verdicts) before it decides anything. Feature flag; default off until then.
- Rollback: flag off restores containment. Complexity: M.

## M3: app compiles with delivery proof through the SDK (RED for the live step)

**Refined 2026-11-14 from the source:** `docs/architecture/M3_PURCHASE_SLICE_PLAN.md` splits this into M3a (compile through the SDK adapter and trust checks, no signed-transaction change; also closes T-2) and M3b (delivery proof, changes what users sign).

- Scope: the app's legacy purchase path calls `compileBag` with the `lifiComposer` adapter and `deliveryProof`,
  stores the SDK `CompiledPurchase`, and verifies with `DELIVERY_LOG` (falling back to the M2 binding).
- Dependencies: M2; Composer pins per chain; resolution of nothing else.
- Acceptance: the program-parity test is replaced by a direct test of the SDK path; purchase, partial and full sale
  verified live on Robinhood and Base from the app, with ledger checks (Base pilot steps 5–7).
- Gate: changes the signed transaction → explicit approval for the live runs; a new flag (proposed name
  `BAG_SDK_COMPILE_ENABLED`, does not exist yet), default off.
- Rollback: flag off returns to `buildComposerPurchase`. Delete the old adapter only after two weeks of live use.
  Complexity: L.

## M4: purchase planning through `planPurchase`

- Scope: resolve the open decision pinned by `sdk-app-partition-parity.test.ts` ("a deposit that gives an asset
  nothing": the app drops the leg, the SDK refuses), then replace `calculateDepositAllocation` +
  `buildExecutionPlan` for Composer purchases.
- Acceptance: parity suite passes with no KNOWN DIFFERENCE; intent fingerprints of existing intents unchanged
  (`computeExecutionPlanFingerprint` regression fixtures). Complexity: M.

## M5: validation through `validateBag`

- Scope: the app's create/edit validation calls `validateBag`, adding only app-specific checks (registry identity,
  unique names, UI limits).
- Acceptance: `bag-sdk-consistency.test.ts` extended to every app validation message; no hash change for stored
  versions. Complexity: M.

## M6: SDK 0.4.0 release decision (RED)

- Preconditions: `release-gates.json` gates closed except `publicationApproved`; owner decision recorded; M2 either
  shipped or explicitly excluded from 0.4.0.
- Action: owner publishes; CI's packed-consumer and starter smoke stay green. Complexity: S.

## Ordering and blockers

M2 → M3 → M4 → M5 can each ship independently; M3 needs live wallet runs. Settlement work
(`../security/SETTLEMENT_ACCOUNTING_AUDIT.md`) and owner custody
(`../security/CREDENTIAL_HARDENING_PLAN.md`) run in parallel and block fee-path production use, not this migration.
