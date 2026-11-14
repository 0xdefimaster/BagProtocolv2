# Git recovery and source of truth

Recorded 2026-11-14 from the maintainer's Desktop checkout. Read-only inspection, then one new local branch. Nothing
was pushed, reset, rebased, stashed, cleaned or deleted.

## 1. Branch state

| Ref | SHA | Relationship |
|---|---|---|
| `origin/main` (fetched 2026-11-14) | `4774ac9de444728df54b6bd2bf7971b02d373f67` | Ancestor of `codex/three-chain-bag-flows` (0 behind) |
| `codex/three-chain-bag-flows` | `1ac0520ddf77a5ac1d795310734ec009aa7379ab` | 5 commits ahead of `origin/main`, **on no remote ref** |
| `audit/sdk-first-hardening` (new, this session) | starts at `1ac0520`, see §5 | Local only; preserves the branch above untouched |
| local `main` | `cfeab64` | 12 behind `origin/main`; nothing local-only |

The five local-only commits (`git log --branches --not --remotes`; no other local branch has local-only commits):

| Commit | Date | Content | Upstream by patch-id (`git cherry`) |
|---|---|---|---|
| `9a532cce0411d997eb5a1ecbc39d227cc6369a42` | 2026-11-08 | SDK Arbitrum profile, shared Base purchase checks | no |
| `6266f398161aa1cd54e0e67e2a0129ec12db0cbf` | 2026-11-08 | Merge of `origin/main` `4774ac9` (parents `9a532cc`, `4774ac9`) | merge |
| `6fd983a588d666d717bb14234bb92faf86f32b8e` | 2026-11-08 | Chain-aware portfolio and redemption (three networks) | no |
| `1910e9b2a93a6b6a74fd1aa90c22025d71d8228e` | 2026-11-08 | **Base deployment evidence**, rollout scripts | no |
| `1ac0520ddf77a5ac1d795310734ec009aa7379ab` | 2026-11-08 | Independent Base SDK pilot, network asset selection | no |

`git diff --check origin/main...HEAD`: clean. Integrity of these commits is therefore fine; the risk is loss, because
they exist on one disk only.

## 2. Local-only state outside the branch

| Item | Where | Content | Remote copy |
|---|---|---|---|
| `stash@{0}` (`4b87873`, 2026-10-24, made on `feat/sdk-partition-planner`) | this checkout | `packages/bag-sdk/src/execution.ts` (+3/−1) and 14 untracked report files | none |
| Worktree `C:/Users/ilife/.codex/worktrees/sdk-base-arbitrum/BagProtocolv2` | other folder | detached at `b57eb51`, clean | `b57eb51` is on `origin/main` |
| Worktree `C:/Users/ilife/Desktop/BagProtocolv2-usdg-demo` | registered, **folder missing** | detached `3442281` | on `origin/codex/*` branches; only Git metadata is stale (`git worktree prune` is safe, not run) |
| `fork-evidence/`, `soak-evidence/` | untracked | DCA fork and keeper-soak evidence for commit `419520a` (PR #145), including one failed, non-reproducible run (`104710833`) | none; preserve (see `../quality/REPOSITORY_HYGIENE_REVIEW.md`) |
| Root and `docs/` untracked reports (14 files) | untracked | pre-move copies of `docs/archive/*`; differ only in relative links | archive copies are on `origin/main` |

## 3. Evidence that exists only in the local commits

Committed in `1910e9b` / `1ac0520`, absent from every remote ref until pushed:

- `evidence/three-chain-app/deployments-base.json`: Base `BagFactory` `0x9F66fA3F7a70281eB4F598EfE763B3f83379df4a`
  (tx `0x7291dd815cd4f2077428dcd86efb880a573dccc04efa9b9a081a0d9b47ac509b`, block 54802636) and `StrategyCompositions`
  `0x7D4A75a7F196eA90Cf96021ADAC83a0DE93A4Fc8` (tx `0xf9ff41673f788e772a015a8a4fa9dfd12ec50ebf76c743477c51925ea89af0a9`,
  block 54802650), receipts, runtime hashes and read-back settings.
- `evidence/three-chain-app/base-post-deploy-readiness.json`, `base-composer-pin-recheck.json`,
  `deployment-inputs.json`, `unsigned-deployments.json` (Arbitrum predictions), `settings-base.env` (public values).
- `evidence/base-pilot/{validation,quote,check}.json`.
- `docs/chains/THREE_CHAIN_APP.md`, `docs/chains/BASE_PILOT.md`, `docs/SDK_DEPLOYMENT_PIN_ARBITRUM.md`.

Re-verified on 2026-11-14 against Base block 57172316: both runtime hashes still match the journal
(`evidence/authority/authority-snapshot-2026-11-14.json`).

## 4. Secret screening (values never printed)

| File path | Category | Git state | Exposure | Required action |
|---|---|---|---|---|
| `.env.local` | `DEPLOYER_PRIVATE_KEY` (valid key → `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46`); service-role, session, cron, Alchemy, LI.FI secrets present | ignored | local plaintext; no evidence of remote exposure | `../security/CREDENTIAL_HARDENING_PLAN.md` |
| `.env.pre-base-rollout-20261108.local` | same deployer key (same address) | ignored | second plaintext copy | remove after the key is migrated (approval) |
| Other signer variables (`CREATOR_REWARDS_*`, `REDEEM_FEE_ATTESTOR_*`, `BAG_ROUTER_PLAN_SIGNER_KEY`) | placeholders, not keys | ignored | none | none |
| Tracked tree, branch diff, untracked files, stash | private-key literals, JWTs, authenticated RPC URLs, DB credentials, npm/GitHub tokens | — | none found; the only matches are the CI service container password and documentation placeholders | none |
| `examples/sdk-consumer/.env.base.example` | template: empty RPC/API key, public addresses | tracked (branch) | none | the repository secret scan refused its name, so **CI would have failed on push**; fixed in `6e603cf` |

## 5. Work branch for this session

`audit/sdk-first-hardening`, created from `1ac0520` with `git switch -c` (untracked files untouched). Commits:

| Commit | Change | Behavior change |
|---|---|---|
| `6e603cf` | Secret scan accepts `.env.<name>.example` templates; still refuses real env files and key literals (fixture-tested) | CI tooling only |
| `e22d937` | Vitest stops with one clear error on a lowercase Windows drive letter | test tooling only |
| `8d636c9` | Characterization tests for known gap T-1 (app and SDK) | none |
| `2dbae5b` | SDK ↔ app end-to-end purchase verification parity test | none |
| `4ad5041` | `scripts/audit/authority-snapshot.mjs` + first snapshot | none (read-only script) |
| later commits | documentation under `docs/architecture`, `docs/security`, `docs/quality`, `docs/release` | none |

## 6. Safe push and PR plan (approval required, not executed)

1. Push the original branch unchanged: `git push -u origin codex/three-chain-bag-flows`. Preserves the Base
   deployment evidence remotely. Verify with `git branch -r --contains 1ac0520`.
2. Open a PR `codex/three-chain-bag-flows` → `main`. CI will now pass its secret-scan step only if step 3 lands
   first or together; otherwise expect the `.env.base.example` failure.
3. Push `audit/sdk-first-hardening` and open its PR against `codex/three-chain-bag-flows` (or against `main` after
   the first PR merges). It contains the secret-scan fix, so merging it into the first PR's branch makes that PR green.
4. Preserve `fork-evidence/` and `soak-evidence/` in PR #145's branch (`docs/dca/evidence/`), not in these PRs.
5. Optional cleanup after 1–4: `git worktree prune`; drop the duplicate untracked reports; keep `stash@{0}` until its
   one-line SDK change is reviewed (`git stash show -p stash@{0} -- packages/bag-sdk/src/execution.ts`).

Never: force-push, `git reset --hard`, `git clean`, or deleting `codex/three-chain-bag-flows` before step 1 is
verified.
