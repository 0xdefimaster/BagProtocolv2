# Repository hygiene, draft PRs and large files

2026-11-14. Recommendations only; nothing was deleted, moved, merged or closed.

## 1. Untracked and duplicate files

Method: content hash searched in all refs (`git log --all --find-object`), compared with `docs/archive/`, secret
patterns scanned (none found), references checked.

| Path | Tracked | Unique content | Recommendation |
|---|---|---|---|
| `DEMO_READINESS.md`, `SPIKE-NOTE-lifi-quote.md`, `durum-raporu-v2.md`, `docs/{FINAL_PRODUCTION_AUDIT,PHASE_14_REPORT,PHASE_19X_REPORT,V10_HARDENING_REPORT,V11_HARDENING_REPORT}.md` | no (copies exist only in `stash@{0}`) | **none**: identical to `docs/archive/*` except relative links rewritten when the files were archived (2–4 lines each) | REMOVE after approval; the archived versions on `origin/main` are authoritative |
| `docs/{CHANGES_SUMMARY,COWBOY_COLLECTION,INVENTORY_ASSET_PASS,INVENTORY_FIT_UPDATE,INVENTORY_QUICK_START,INVENTORY_SETUP}.md` | no | none: byte-identical to `docs/archive/*` | REMOVE after approval |
| `fork-evidence/104710833/`, `fork-evidence/104733042/` | no | **yes**: DCA fork runs (`bag-dca-fork-evidence/v1`), one failed and non-reproducible at `4df146c`, one passing at `419520a` | RETAIN; commit to PR #145's branch under `docs/dca/evidence/` (historical, including the failure) |
| `soak-evidence/fork-2026-11-03T04-01-35-540Z.json` | no | **yes**: keeper soak, 12 cycles, 47 passed / 0 failed at `419520a` | RETAIN; same destination as above |
| `vercel.json` | yes | 3 cron entries (Netlify schedules all 6 through `netlify/functions/*.mts`) | RETAIN until the maintainer confirms no Vercel project or fallback exists (cannot be verified from the repository; route comments still mention Vercel Cron). If Vercel is a fallback, add the 3 missing crons; if not, remove |
| `stash@{0}` | stash | one SDK line change + the report copies above | review the `execution.ts` change, then drop (approval) |

## 2. Rollout scripts (`scripts/prepare-app-rollout.mjs`, `scripts/execute-app-rollout.mjs`, branch only)

Hard-coded: owner and treasury addresses, factory constructor arguments, Robinhood reference factory, Base registry,
expected deployment sequence, source commit `6fd983a`, fee budgets, chain IDs. These are reviewed constants, and the
script fails closed if the chain disagrees (reference factory settings, nonce, runtime bytes, immutables, gas,
balance), journals each hash before broadcast, and never prints secrets. Do **not** turn them into runtime
configuration. For the next rollout (Arbitrum), move them into a reviewed, immutable manifest file (chain identity,
parameters, artifact and init-code hashes, source commit, predicted addresses), keep the read-only default and the
journal, and add an external-signer option so `DEPLOYER_PRIVATE_KEY` is not needed
(`../security/CREDENTIAL_HARDENING_PLAN.md` §3.6).

## 3. Draft pull requests

| PR | State (GitHub API, 2026-11-14) | Recommendation |
|---|---|---|
| #145 DCA v1 (`feat/dca-v1-typed-adapter`, head `abf90fd`) | Draft; 19 ahead, 30 behind `main`; GitHub `mergeable_state: clean`; CI green at head (2026-11-03); 46 files, +8845; overlaps this branch only in `packages/bag-sdk/{CHANGELOG,README}.md` | **KEEP_DRAFT**, then **SPLIT** when resumed (executor + adapter contracts; SDK `/dca` receipt verifier; keeper) and **REBASE**. Roadmap ranks automation last; live mode stays off; fork evidence predates the current executor bytecode; needs its own security review |
| #147 fee-sale price confidence (`fix/settlement-price-confidence`, head `173b4a0`) | Draft; 3 ahead, 30 behind; `clean`; CI green at head; 20 files, +1832 | **REBASE** → review → **MERGE_READY_AFTER_REVIEW**, before the positive-fee proof. It narrows fee sales to source-qualified price states; its feed-coverage gate needs a real run first |

## 4. Large files (`../security/EXECUTION_TRUST_BOUNDARY_REVIEW.md` for their security role)

| File | Lines | Exported / approx. functions | Tests referencing it | Longest functions |
|---|---|---|---|---|
| `lib/server/purchase-execution.ts` | 1879 | 16 / 27 | 20 | `verifyExecution` ~308, `createPurchaseIntentForUser` ~294, `prepareExecution` ~224 lines |
| `components/app/PurchasePreviewModal.tsx` | 1429 | 2 / 12 | 3 | — |
| `lib/server/redeem-execution.ts` | 1109 | 14 / 21 | 15 | — |
| `lib/blockchain/lifi-composer-adapter.ts` | 894 | 33 / 22 | 14 | — |

No split is recommended for size alone. The two that would reduce risk:
`verifyExecution` (extract the per-provider outcome mapping so M2's binding change touches one place), and
`lifi-composer-adapter.ts`, which M3 retires in favor of the SDK adapter. Each as its own PR, never together with
a verification or settlement behavior change.
