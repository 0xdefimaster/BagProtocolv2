# USDG + Composer: local fork experiment

Run one time-gated basket purchase using actual Robinhood token and Composer contracts copied into a local EVM. The basket is **40% WETH / 30% cbBTC / 30% USDG**, funded with **100 USDG on the fork**. This is an opt-in research tool, outside the SDK package and app flows.

The owner approves an exact Composer target/calldata hash once. A session signature then executes that purchase through a local account and the upstream SmartSession module. The guard temporarily approves 70 USDG, executes the real Composer program, revokes the allowance, and checks actual input/output balances. The SDK verifies the original inner call using a trace and historical balances.

## Run from this PR's repository root

Use Node 24 and the committed dependency lockfile. No separate dependency install is needed in this directory.

```powershell
npm ci
npm run build --prefix packages/bag-sdk
node scripts/research/usdg-composer/run.mjs
```

The runner reads only the Composer/RPC entries from the root `.env.local`: `LIFI_API_KEY`, `ROBINHOOD_RPC_URL`, `ROBINHOOD_RPC_URL_SECONDARY` or `RPC_URL_ROBINHOOD`. It prefers a configured QuickNode URL. It never reads wallet private keys. A different configuration file can be selected with `--env-file C:/path/to/config.env`; pass a path, never a secret, on the command line.

For an existing detached demo worktree, update it from inside that folder:

```powershell
git fetch origin
git switch --detach origin/codex/usdg-composer-fork-demo
node scripts/research/usdg-composer/run.mjs --env-file ../BagProtocolv2/.env.local
```

Keep any tracked local edits before switching. The research-only fix changes neither dependencies nor SDK source, so an already successful SDK build can be reused. Do not run `git worktree add` again for a folder that already exists.

When using a separate prepared SDK checkout, pass `--repo C:/path/to/BagProtocolv2`. `--out C:/path/to/new-output-directory` selects a new result folder. Relative arguments resolve against the initial working directory. An existing output folder is refused.

Default output: `artifacts/usdg-composer/<timestamp>/`, ignored by the repository. Success ends with `REAL_USDG_COMPOSER_FORK_EXECUTION_VERIFIED` and all checks passing. The output contains:

- `results.json`: checks, block/hash, runtime/configuration, transaction hashes, actual amounts and SDK receipt result.
- `compiled.json` / `composer-response.json`: the unsigned real program and live API result.
- `execution-receipt.json` / `execution-call-trace.json`: local execution evidence.
- `local-build.json` / `cache/`: local contract compilation and fork cache.

No generated evidence is added to the source tree automatically. Keep output files local; do not commit configuration files or private RPC URLs. The compact recorded run in `evidence/` identifies its own timestamps and source hashes.

## Boundary and requirements

- **Public chain submission: blocked.** The upstream connection goes through a loopback proxy that permits only a fixed read-method list. Signing and submission use the in-process fork provider. A negative control confirms that `eth_sendRawTransaction` is rejected upstream. Composer API compilation is unsigned.
- **No real funds or user keys.** Only publicly known development accounts sign locally. USDG is transferred on the fork by locally impersonating one of the public holder addresses in `assets.json`; the public chain is unaffected. A holder must still have at least 100 USDG at the fork block. No token bytecode/storage replacement is used. Holder contracts and their modified local balances make this unsuitable as a market or gas-cost benchmark.
- **Real Composer, local account/EntryPoint.** `ResearchAccount.sol` contains minimal account, EntryPoint and signer-validation scaffolding. It does not reproduce production wallet conformance, full ERC-4337, bundler rules, ERC-7562 validation or gas charging. Upstream SmartSession/TimeFrame/Sudo creation bytecode is unchanged; provenance and licensing are in `vendor/NOTICE.md`.
- **One reviewed call.** `ReviewedPurchase` caps execution at one purchase and pins the complete target/calldata hash. Its recorded basket hash is an identifier, not a semantic verifier for arbitrary Composer programs. Fresh programs need another owner review. This does not implement unattended weekly DCA, price triggers, automatic rebalancing or a persistent keeper.
- **Research deployment pin.** The factory is `0xaceb3bb6c75488b5b806b9de4dcf78814465bdae`, runtime hash `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5`. Code is checked on the fork and marked `productionApproved: false`. LI.FI's factory/migration confirmation remains an open production gate. No SDK release gate is changed.
- **Fresh state and quotes.** A normal invocation selects a current block and compiles a fresh route. Prices, liquidity, route availability and outputs may change. The runner checks chain id, token symbols/decimals/runtime hashes and the factory hash. A changed deployment is refused rather than automatically trusted. Captured-program replay is a separate, explicitly labeled mode below.
- **SDK scope.** Tested against source SDK 0.3.0 from BAG baseline `82b3b2926da467e3530eba0c9f6c38452d8511ab`, Composer 0.11.3, Hardhat 3.14.0, viem 2.56.0 and solc 0.8.24. Runtime/file hashes are recorded; the baseline label alone is not proof of the caller's checkout. Build `dist/` first. This experiment does not publish npm or change production SDK behavior. Results stay `NOT_BAG_ACCOUNTED` and create no app position, cost basis or P&L.
- **Fork fidelity and ArbSys.** The engine models L1 Cancun with chain id 4663. It cannot natively execute Nitro's ArbSys precompile at `0x0000000000000000000000000000000000000064`. Some valid swap routes call `arbBlockNumber()` there; copying the chain's `0xfe` placeholder into an L1 EVM produces `INVALID` and burns the inner call's gas. The harness qualifies the native getter at the pinned upstream block against its L2 RPC height, then installs `LocalArbSysRead` **only on the local fork**. It models that one read using the local fork height; every other selector reverts. `results.json.precompileModel` records the native value, original code, model runtime hash and `gasEquivalent: false`. Token/Composer bytecode remains copied without modification. This is partial precompile emulation, not a full Nitro node, accurate parent-chain `block.number`, native gas model or qualification of all routes. Unsupported precompile behavior must still fail. RPC historical state access is required; the experiment is intentionally outside default CI.

### Replay a captured failure

Keep the complete original result directory, including `results.json` and `composer-response.json`. From the repository root:

```powershell
node scripts/research/usdg-composer/run.mjs --replay C:/path/to/original-result-directory
```

`--env-file` and `--repo` work as above. Replay selects the recorded block, checks its canonical hash, starts the local clock at that block, and reuses the captured unsigned Composer response. It asserts that the rebound signer and exact calldata match the saved program. Reports identify `executionMode: CAPTURED_PROGRAM_REPLAY`; the API revision is labeled `CAPTURED_REPLAY`. This mode does **not** make a fresh Composer quote request or claim a new API compilation. Historic RPC reads are still needed and no public transaction is sent. Subsequent local setup blocks/time are synthetic, so this is a controlled reconstruction rather than an exact transaction-by-transaction Nitro replay.

The 2026-10-22 user failure was reproduced at block 95311549 with the original program and `INVALID` at ArbSys selector `0xa3b1b31d`. The original source version and failed transaction remain identified in the regression evidence. The block-number facade follows [Offchain Labs' documented L2 block-number semantics](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time) and the same `return block.number` convention used by their [local ArbSys mock](https://github.com/OffchainLabs/nitro-mocks/blob/main/contracts/ArbSys.sol); only the single getter is supported here.

## Interpreting failures

`INCOMPLETE` and a nonzero exit code preserve the last completed checks and failed stage. A failed purchase also saves its receipt, complete call trace and failed call-frame summary. Internal quoting calls may revert intentionally; a failed frame alone is not proof that the whole purchase failed. A negative check inspects the inner `OperationResult`: an outer EntryPoint receipt can succeed while execution was rejected. Time, altered-program and repeat-execution rejection checks also require unchanged balances and counters.

An unsigned/unprotected legacy envelope may omit `chainId` when the fork RPC sends for an unlocked address. The SDK correctly refuses that evidence. This runner records the diagnostic and uses locally signed EIP-1559 envelopes carrying chain id 4663 for the actual session execution; it does not weaken SDK verification.

Upstream timeouts, lost routes, changing holder balances, rate limits or a code-hash mismatch should be investigated at their reported stage. They are not measurements of whether DCA is impossible. The next production qualification is a real wallet/EntryPoint integration plus a reviewed authorization design for refreshed quotes.
