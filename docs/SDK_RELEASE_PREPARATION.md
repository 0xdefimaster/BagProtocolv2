# SDK release preparation

Candidate: @bagprotocol/sdk 0.3.0. Status: **published 2026-10-30** (below).

## Published package observation

**0.3.0 published 2026-10-30** by the maintainer (`npm publish`, web authentication). Registry read back the same day:

| Field | Value |
|---|---|
| `latest` | `0.3.0` |
| `gitHead` | `e1a8ed4cc943b4eedfefc68c88ed8db116856d53`, the commit whose `release:check` reported `releaseReady: true` |
| `dist.integrity` | `sha512-3CYDWoOmjZZcM3fkMjbQGYKXLp3nHRpWsVY8g0psixuIEwXjdwQC6oouFkgR4t4DXka8/vpKncY2aDsjQ5CBgw==`, identical to the candidate tarball |
| `dist.shasum` | `ba4abf216bff64a6ef400d1158b52aa379fee05c` |

Earlier observation (before 0.3.0):

The public npm registry was queried on 2026-10-22. latest is 0.2.1, published 2026-10-20, with gitHead 545dd77c073f8c5ac0df040a6fc0753097fc58ff and integrity sha512-7KFGgcFzv0NlypJyx3Tk1wC+6u+X8gconJHQ+iy9wW4NcuWVqXCK484PyjsN/xTByMuWwGfkFuwihKFUjEzGUg==.

Recheck at release time. Registry metadata were read; this is not an audit of the unpacked published package. Never overwrite the existing version or equate a source package version with publication.

## Compatibility and evidence

| Surface | Qualified target | Evidence / scope |
|---|---|---|
| Node ESM | Node 24.22.0 | Packed-package imports and independent offline consumer |
| TypeScript | 5.9.3, NodeNext, strict, skipLibCheck=false | Fresh consumer compilation |
| viem | 2.56.0 | Pinned clean installation |
| Composer SDK/spec | 0.11.3 | Adapter contract, peer line >=0.11.0 <0.12.0, prior unsigned live evidence documented in SDK_COMPOSER_TRUST.md |
| Newer Node/peer versions | NOT TESTED | Declared ranges do not mean every version was separately qualified |
| Browser bundlers | NOT TESTED | EIP-1193 integration helper is provided; no browser bundler compatibility claim |
| CommonJS require | NOT SUPPORTED | The package exports ESM imports |
| Format chains | ethereum/base/arbitrum/robinhood | Frozen EVM format profile; this does not establish provider routes or registry deployments everywhere |
| Solana / cross-chain baskets | NOT SUPPORTED | Separate versioned format/adapter work |
| Robinhood historical evidence | Qualified reader/build | Read-only evidence documented in SDK_COMPOSER_TRUST.md |
| Purchase receipt verification on Base / Arbitrum | NOT QUALIFIED | The Nitro balance reader accepts only Robinhood's chain id and the Geth reader requires `Geth/v1.16.`; the remaining single-transaction-block mode refuses multi-transaction blocks, so results are INDETERMINATE in practice. Composer compilation on these chains is also untested |
| New signed SDK purchase | VERIFIED (2026-10-30) | See "Live signed purchase" below |

The synthetic consumer result is not live transaction evidence. SDK executions remain NOT_BAG_ACCOUNTED.

## Live signed purchase (release gate 3)

On 2026-10-30 the 0.3.0 candidate, installed from its packed tarball into the independent consumer
(`examples/sdk-consumer`, `npm run sign`), compiled and verified a real purchase:

| Field | Value |
|---|---|
| Strategy | `feetest` v1 (TSLA 50% / NVDA 50%), `definitionHash` `0x089fc9ba…a4fa` |
| Input | 3 USDG (`3000000`), pinned Composer factory `0xaceb…bdae` (VM 1.2) |
| Wallet | `0x3690895b48cea6f1f6c8e66fa9b332858f8eb1b7`, MetaMask, plain EOA |
| Approval | exact 3 USDG to the predicted proxy `0x05bb424a1c46dc7d1e5333b218c1142b5b2ec27a`, tx `0xd3a46dd5…5ba7` |
| Purchase | tx `0xec6df6cf44fd4c0758896dcf3184033ca937280c1c9da16eb0c6da5641100209`, block 101506977 |
| Original intent hash | `0x559f4b6d2003a740a61d0dac61c1b715decc887e7c2419e9fa2cb86b72cfe068` |
| Result | `VERIFIED`: `DIRECT` binding, `TRANSACTION` balance scope, input spent 3000000 |

Outputs, all above the reviewed wallet minima:

| Token | Received (raw) | Minimum (raw) | Balance before → after |
|---|---|---|---|
| TSLA `0x322f…3b2d` | 3795634691032666 | 3757678344122339 | 0 → 3795634691032666 |
| NVDA `0xd060…9eec` | 7169079509197212 | 7123304250276130 | 0 → 7169079509197212 |

**Reader requirements observed on the same transaction:**
- **Alchemy Robinhood endpoint (Nitro v3.12.1):** rejects `debug_traceCall` (and `eth_getLogs`) with "JSON is not a valid request object".
- **Public RPC:** runs Nitro v3.12.2, which the reader does not accept yet, and does not expose `debug_traceCall`.
- **QuickNode endpoint:** Nitro v3.12.1+70fa99a with `debug_traceCall` and `txIndex`. This is where the verification ran.

A wallet minimum is checked only with transaction-scoped balance evidence. Without a qualified reader the result
is `INDETERMINATE`, not a failure.

## Reproducible candidate checks

From a clean checkout, use Node 24 and the repository's locked dependencies. A reviewable candidate is prepared with:

```
npm ci
npm run release:check --prefix packages/bag-sdk -- --out <absolute-new-artifact-directory>
```

The command builds the SDK, checks two fresh tarball consumers, validates every export against packed files, refuses unexpected files/version reuse, records public npm metadata, then packs the candidate and writes candidate-report.json with SHA-256/SHA-512 integrity. It never runs npm publish, creates a Git tag, reads private keys or submits a transaction.

SDK_RELEASE_SOURCE_COMMIT can identify the reviewed commit in CI or an archive checkout. The report labels that value as caller-provided, not cryptographic source provenance. In CI GITHUB_SHA supplies the identifier. SDK_RELEASE_SKIP_CONSUMERS=1 is only for a job that has just run both consumer checks; the report labels them separately as SKIPPED_IN_THIS_COMMAND. Do not present skipped checks as new measurements.

No generated artifact/report or credential is committed to the source package.

Ongoing CI uses --mode package after both consumer checks. This validates the tarball without requiring an unused npm version, so later CI remains usable after a release. It records versionAvailability=NOT_CHECKED and always releaseReady=false. Only the default candidate mode checks public npm version availability. Even in candidate mode, releaseReady requires fresh consumers, a source identifier and all four gates.

## Final release gates

packages/bag-sdk/release-gates.json records four independent approvals/evidence items:

1. Confirm LI.FI's intended production factory and migration/retirement policy.
2. Review and approve the deployment pin: chain, factory runtime hash, signer/proxy resolution, review date and rollout response.
3. Complete a newly signed purchase using the original saved compiled intent and explicitly reviewed wallet minima. Persist the transaction hash before collecting evidence and verify it with a qualified reader.
4. Obtain explicit publication authorization after reviewing version, changelog, compatibility evidence and package contents.

Candidate checks can PASS while releaseReady remains false. The checker does not approve or change these gates. They are factual records to update only after evidence/authorization exists.

After gates close, rerun against the exact reviewed commit and retain the final tarball, integrity, consumer output and source identifier. Decide the npm tag and provenance/tagging procedure at that time; publishing and tagging are separate authorized actions.
