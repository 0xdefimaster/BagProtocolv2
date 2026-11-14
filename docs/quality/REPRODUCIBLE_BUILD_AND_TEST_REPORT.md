# Reproducible build and test report

## 1. Environment

| Item | Value |
|---|---|
| OS | Windows 10 Home 10.0.19045.6466 |
| Node / npm | v24.22.0 / 11.19.1 (`engines.node >=24`, `.nvmrc` 24) |
| Commit under test | `1ac0520ddf77a5ac1d795310734ec009aa7379ab` (`codex/three-chain-bag-flows`, unchanged) |
| Lockfile | `package-lock.json` sha256 prefix `d532c7acc94992db`; installed `vitest` 5.0.2, single copy (`npm ls vitest`) |
| Working directory | `C:\Users\ilife\Desktop\BagProtocolv2` (uppercase drive, see §3) |
| Env files present | `.env.local` (Next.js loads it during `next build`) |

## 2. Baseline (2026-11-14, sequential, one PowerShell script)

| # | Command | Exit | Time | Result |
|---|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 19 s | pass |
| 2 | `npm run lint` | 0 | 19 s | no warnings or errors |
| 3 | `npm test` | 0 | 304 s | **280 files, 2691 tests passed**, 0 skipped, 0 failed |
| 4 | `npm run test:contracts` | 0 | 26 s | **195 passing** (Hardhat, local EVM) |
| 5 | `npm run typecheck --prefix packages/bag-sdk` | 0 | 5 s | pass |
| 6 | `npm run build --prefix packages/bag-sdk` | 0 | 6 s | pass |
| 7 | `npm run smoke:consumer --prefix packages/bag-sdk` | 0 | 57 s | packed `bagprotocol-sdk-0.4.0.tgz` installed in a temp project; `consumer.mjs` OK; `consumer.ts` typechecks (NodeNext) |
| 8 | `npm run smoke:starter --prefix packages/bag-sdk` | 0 | 75 s | `PASS`, `dependencySource: SDK_TARBALL`, offline demo `SYNTHETIC_ONLY`, `signedOrSubmitted: false` |
| 9 | `SDK_RELEASE_SKIP_CONSUMERS=1 npm run release:check … --mode package` | 0 | 8 s | candidate packed; `releaseReady: false`, open gate `publicationApproved`; `published: false` |
| 10 | `npm run build` (Next.js) | 0 | 154 s | production build succeeded |
| — | `npm run test:integration` | **not run** | — | **BLOCKED**: no PostgreSQL and no Docker on this machine; `TEST_DATABASE_URL` unset. CI runs it against a disposable Postgres 16 service |

This closes a gap recorded in `docs/chains/THREE_CHAIN_APP.md` ("the entire 280-file suite was not repeated after
these final fixes"): it now passes in full on that exact commit. These are local and synthetic results; none of them
is chain evidence.

After this session's commits (test and tooling only), the affected suites were re-run: composer status (23 passed),
SDK receipt (50), new SDK↔app verification parity (7), guard + test discovery (17), typecheck and lint clean.

## 3. Windows: lowercase drive letter breaks every Vitest file

Reproduced 2026-11-14 with `lib/__tests__/format.test.ts`:

| Shell and cwd as Node sees it | Result |
|---|---|
| PowerShell `Set-Location 'c:\…'` (PowerShell normalizes to `C:\…`) | passed |
| Git Bash started by VS Code, `process.cwd()` = `c:\Users\…` | **failed**: "Vitest failed to find the runner" |
| Git Bash after `cd "C:/Users/…"`, `process.cwd()` = `C:\Users\…` | passed |

Root cause, as far as verified: the trigger is the lowercase drive letter in the process working directory; Vitest
then fails to find its runner in every file (consistent with the runner module being loaded under two paths).
Normalizing `process.cwd()` or `root` inside `vitest.config.ts` does **not** fix it (tried; the CLI is already
loaded). No dependency was changed.

Change (`e22d937`): both Vitest configs call `assertWindowsDriveLetterCase()`, which stops with one message naming the
uppercase path, instead of 280 failures that read like regressions. Unit-tested
(`lib/__tests__/vitest-drive-letter-guard.test.ts`); no effect on Linux CI. Workaround: run from `C:\…`.

## 4. CI observations

- The repository's first CI step, `scripts/check-no-secrets.sh`, **failed** on this branch because the branch tracks
  `examples/sdk-consumer/.env.base.example`. Fixed in `6e603cf` (named templates allowed; real env files and key
  literals still refused, fixture-tested). Without the fix the branch's PR would have been red at step one.
- CI already covers what this report ran (packed SDK smoke, starter smoke, release check, unit, build, integration
  with Postgres; contracts in `contracts.yml` on contract changes). Branch protection could not be inspected
  without GitHub credentials (`gh` is not installed): UNVERIFIED.
- Draft PRs #145 and #147: CI green at their heads (2026-11-03); both 30 commits behind `main`.

## 5. Re-running

```powershell
Set-Location 'C:\Users\ilife\Desktop\BagProtocolv2'
npm run typecheck; npm run lint; npm test; npm run test:contracts; npm run build
npm run build --prefix packages/bag-sdk; npm run smoke:consumer --prefix packages/bag-sdk; npm run smoke:starter --prefix packages/bag-sdk
```
