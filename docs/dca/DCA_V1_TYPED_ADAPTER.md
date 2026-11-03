# DCA v1: typed-adapter executor, SDK verifier, keeper

Status: **code, local/integration tests, a keeper soak on a local node with real Postgres, and one Robinhood fork run
of an earlier build.** Not deployed, not audited, nothing sent to Robinhood Chain mainnet. The keeper has no live mode.
The executor changed after that fork run (signed `allowedCaller`, §1): the pinned fork evidence in §7 must be re-run.

## 1. What a user does

1. Signs one EIP-712 `DcaAuthorization` (domain `BagDcaExecutor` / `1`, chain id, executor address).
2. Approves the executor for exactly `totalBudget` of the input token (USDG). Funds stay in the wallet.
3. Can stop it any time: `revoke(id)` (or a signed `Revocation` anyone submits with `revokeBySig`), and/or set the
   token allowance to 0.

The signed fields: owner, recipient, input token, BAG reference (bagId, bagVersion, compositionHash, definitionHash,
strategyId, strategyVersion), the asset list with a per-asset price **ceiling** (`maxPriceRaw`, input raw units per
whole token), the schedule (amountPerRun, totalBudget = amountPerRun × maxRuns, maxRuns, startsAt, periodSeconds,
expiresAt), the route (adapter, SwapRouter02, allowed fee tiers), a nonce, and `allowedCaller`: the only address that
may call `execute` (the owner's keeper), or zero for anyone. The SDK builder makes the caller an explicit choice
(`allowedCaller: <keeper> | 'ANY'`) and the summary flags ANY as `ANY_CALLER_CAN_EXECUTE_UP_TO_CEILING`.

## 2. What happens on each run

A keeper (anyone) calls `execute(authorization, runParams, ownerSignature)`. The executor, in order:

| Check | Where |
|---|---|
| id = EIP-712 digest; `runParams.authorizationId` must equal it | `execute` |
| not revoked; owner signature valid now (EOA or ERC-1271, re-checked every run) | `execute` |
| static terms (budget identity, ≤10 assets, weights = 10000, decimals ≤ 36, no duplicates, recipient/assets are not the executor/adapter/router, fee tiers ⊆ {100,500,3000,10000}, route = the executor's adapter and its router) | `_checkTerms` |
| BAG exists in BagFactory, `Bag.version()` and `compositionHash()` equal the signed values, and the signed asset rows rebuild that composition string; optional StrategyRegistry `matches` | `_checkRegistry` |
| calendar: inside [startsAt, expiresAt), the keeper's planned window is the current one, deadline not passed, one run per window, ≥ one period since the last run, runs and budget left | `_reserve` (counters updated before any external call) |
| per-leg input = bag.json v1 largest-remainder split; minimum = max(ceil(leg × 10^dec / maxPriceRaw), keeper floor); token `decimals()` re-read and must equal the signed value; fee tier ∈ signed list | `_runMinimums` |
| owner debited exactly `amountPerRun` and the executor received exactly that | `_fund` |
| per asset: exact approval to the adapter, typed swap, approval must be fully used, recipient balance delta measured by the executor ≥ minimum, `AssetDelivered` | `_buyLeg` |
| no input token left behind | `_purchase` |

Any failure reverts the whole run: nothing moves, no counter changes. **If one asset is above its ceiling the whole run
is skipped.** A window that closes without a run is lost; there is no catch-up. Missed windows are recorded by the
keeper (`dca_keeper.events`, kind `MISSED_WINDOW`, with the last reason seen: `WAITING_PRICE`, `FUNDING_SHORTAGE`,
`GAS_SHORTAGE`, `SIMULATION_REVERTED`, `TX_NOT_INCLUDED`, `RPC_ERROR`, `NOT_OBSERVED`) and can be recomputed by anyone
from the chain (`dcaMissedWindows` over the `PurchaseExecuted` windows). Nothing is written on chain for a missed
window: a keeper cannot be trusted to report its own failures, and a skip transaction would cost gas for nothing.

`UniswapV3ExactInAdapter` (pinned SwapRouter02 + v3 factory; the constructor requires `router.factory() == factory`):
`routeData` is one fee tier; the pool must exist; it pulls exactly `amountIn` from the caller (fee-on-transfer input
reverts), approves the router exactly, calls `exactInputSingle` with the recipient and minimum, resets the approval to
0, requires its own input balance unchanged (pre-sent tokens are never spent) and the recipient's measured delta to
equal the router's reported output (fee-on-transfer or rebasing output reverts). No owner, no arbitrary call, no
delegatecall.

## 3. Reviewed PRs and what was reused

| Source | Kept | Replaced or dropped |
|---|---|---|
| #130 `RecurringPurchaseExecutor` | EIP-712 hashing pattern, revoke/revokeBySig, `_checkRegistry` + `_compositionHash` (Bag registry binding), `_reserve` calendar, `_legAmounts`, ceil minimum + decimals re-check | BagExecutionRouter + planSigner plan path (`_checkPlan`, `_checkSwapCall`, `_swapAndDeliver`) → typed adapter; DELEGATION funding kind and the try-permit path → ALLOWANCE only; `sourceAccount`/`fundingKind`/`fundingContract` fields removed |
| #130 SDK `recurring.ts` | builder from bag.json (registered composition sorted by symbol, v1 rules), typed data, split/minimums/calendar helpers | plan check and `verifyRecurringPurchase` (balance-trace based) → `verifyDcaReceipt` over the executor's own `AssetDelivered` events |
| #130 SDK `adapters/uniswap-v3.ts` | — (QuoterV2 tier selection re-written in `planRun`) | router-plan building and signing |
| #131 keeper | state machine (deriveState, write-ahead, reconcile-before-resend, back-fill, missed-window accounting, attempts) | file/JSON store → Postgres store (SKIP LOCKED claims, DB-clock leases, atomic write-ahead + nonce allocation, append-only events); planSigner removed; reorg re-check, alerts, health, worker added |
| #144 ADR | typed `IDcaSwapAdapter`, AssetDelivered fields, ALLOWANCE, no Composer, no planSigner, missed windows skipped, Postgres keeper | the 2612 permit is not implemented (smaller surface; users approve once); `ceil` minimum via `Math.mulDiv` (no intermediate overflow) |

Stack check: #130/#131 are based on an old main (82b3b292) and #131 merges #130's branch. Neither was merged here; the
code above was ported onto current main (177a36e). #144 is docs only.

## 4. Composition binding (trusted on-chain source)

The trusted source is the Bag contract: `BagFactory.bagOf(bagId)` → `Bag.version()` / `Bag.compositionHash()`, which
only the BAG's creator can change (`recordBagVersion`, compare-and-swap). The executor rebuilds the composition string
`chain:address:symbol:decimals:weightBps` joined by `|` from the signed rows and requires its keccak256 to equal the
Bag's hash, so the signed list *is* the registered composition. `StrategyCompositions` is not deployed and is not used.

Known limits: the executor lowercases addresses (as in #131's fork evidence for real BAGs). A BAG whose composition
was hashed with mixed-case addresses cannot be bought (fails closed; re-record the version). The SDK sorts rows with
`localeCompare` like the app; a mismatch also fails closed (the SDK refuses to build). A new version recorded by the
creator stops every authorization for the old one (`BagChanged`); the owner must re-sign.

## 5. Price ceilings

`minOut = max(ceil(leg × 10^decimals / maxPriceRaw), keeperFloor)`. The ceiling is the owner's own choice, **not a
fair price**: a keeper (or a searcher sandwiching the keeper's transaction) can execute at any price up to it. The
keeper narrows this in practice with a floor at the fresh QuoterV2 quote minus `slippageBps` (default 100), but the
contract only guarantees the ceiling. At exactly the ceiling a run may fail by one raw unit (venue floors, the
contract ceils). Zero price is refused; decimals above 36 are refused; arithmetic is full-precision (`mulDiv`).

## 6. Keeper

`lib/dca/keeper` + `scripts/dca-keeper-worker.ts`. The chain is the source of truth; the store is a cache plus the
write-ahead record.

- Claims: `FOR UPDATE SKIP LOCKED`, leases on the database clock, `save` refused without the lease.
- Write-ahead before every send, in one transaction with the nonce, under a per-account row lock: nonce = the lowest
  nonce ≥ the account's mined count that no other unresolved write-ahead record holds (a nonce freed by a dropped
  transaction is reused, so no gap blocks later ones); a unique index forbids two unresolved records with one nonce.
  One store per keeper account: replicas share the key AND the database.
- Reconcile before anything else: purchase logged → record (and verify with the SDK); any broadcast hash mined and
  reverted, or the nonce used without a run → clear and log; a broadcast the node still holds (looked up by hash) →
  wait, then REPLACE it with the same nonce at +25 % gas price after `replaceAfterMs`, and once the run's deadline has
  passed CANCEL it (0-value self-transfer, same nonce); after `maxReplacements` raise STUCK_NONCE and keep waiting;
  a broadcast the node no longer holds → DROPPED after `dropGraceMs`. Never re-sent blind, never cleared while held.
- Back-fill runs other keepers sent; re-check recent runs for reorgs (block hash) until they are final: final means
  below BOTH the RPC's `finalized` tag (when served) and `reorgDepth` (64) blocks, so an RPC that reports `latest` as
  finalized does not end the checks early. A reorged run is marked, alerted, and the chain counters decide (re-buy).
- Every run is verified with `verifyDcaReceipt` at `minConfirmations` and, in SEND mode, against the reviewed executor
  code hash (mandatory, see §9); INDETERMINATE runs are re-verified on later ticks; anything but VERIFIED alerts.
- SEND mode also requires an output-token policy (`assetAllowed`, `DCA_ASSET_ALLOWLIST`); `addJob` refuses other
  assets, a different executor build, and an authorization whose `allowedCaller` is another address.
- Funding, gas and RPC failures are visible states with alerts; health on `/healthz` and `/status` (127.0.0.1).
- Modes: PAPER (default, no key, no sends) and FORK (sends only to a local dev node, guarded by client version and
  chain id). There is no LIVE mode.
- The keeper needs an RPC that serves `eth_getLogs` (Alchemy's Robinhood endpoint refuses it; QuickNode and the public
  RPC serve it) and its own Postgres database (not the app's Supabase schema).

Known behaviour: because a run must also be ≥ one period after the previous one, each run's inclusion latency shifts
the earliest next run by that much. The keeper stops sending `inclusionSlackSeconds` (60 s) before a window ends.

## 7. Evidence

| Class | What | Status |
|---|---|---|
| LOCAL | Hardhat in-process EVM, real BagFactory/Bag/StrategyRegistry code, mock Uniswap and hostile tokens | run, passing |
| INTEGRATION | keeper store against a real local PostgreSQL 16 | run, passing |
| LOCAL_NODE soak | `scripts/dca-keeper-soak.ts` on a Hardhat node (mock Uniswap) with PostgreSQL 16 and real restarts | run 3×, 49/49 checks each (below) |
| FORK | `contracts/test/fork/BagDcaExecutor.fork.test.ts` (synthetic BAG) | **pinned block 104733042, run twice, passing, identical** (2026-11-03, below) |
| FORK, real BAG | `contracts/test/fork/BagDcaRealBag.fork.test.ts`: the real BagFactory, BAGs and StrategyRegistry | run 2026-11-03: **stopped at the first check** (factory bytecode comparison, below); comparison fixed, **re-run pending** |
| FORK soak | `scripts/dca-keeper-soak.ts` against `npx hardhat node --fork …` | written; **not run yet** |
| MAINNET | — | none; out of scope |

**Pinned fork evidence.** `npx tsx scripts/dca-fork-evidence.ts` pins a block (`ROBINHOOD_FORK_BLOCK`, or the
chain's `finalized` block), runs both fork tests twice at it, compares the two runs field by field (except timings)
and writes `fork-evidence/<block>/summary.json` (block, block hash, commit, per-test evidence, gas, token deltas,
error names; the RPC URL is never written). The harness proves the pin (first local block = pinned + 1, parent hash
= pinned block hash).

**Pinned run, 2026-11-03** (maintainer's machine, `scripts/dca-fork-evidence.ts`, commit `4df146c`; block
104733042 from the `finalized` tag, hash `0x177a3a28…41b1`, timestamp 1793675328; the harness confirmed the pin).
Synthetic BAG test: `passing` in both runs (337 s cold, 41 s with the fork cache), and the two runs agree on every
recorded field (`reproducible: true`): run 1 spent 10 USDG and delivered NVDA +24461366238836552 and TSLA
+12362881132413682 raw, gas 611129, SDK `VERIFIED` with the executor code hash; the same window again `NotDue`; the
next day's run gas 538324; TSLA's ceiling at half the market reverted `Too little received` with nothing moved.
Real-BAG test: failed at its first assertion in both runs: the code at the configured BagFactory has the artifact's
length (11231 bytes) but differs after masking immutables and the trailing metadata. BagFactory embeds Bag's creation
code, so its runtime also carries Bag's 53-byte metadata hash (at offset 11125); the comparison masked only the last
one. It now masks every embedded metadata blob and reports the byte ranges that still differ, so a remaining
difference is either confirmed as metadata-only or shown exactly. Re-run pending.

**Real BAG infrastructure.** main has no BagFactory address record (the app reads `FACTORY_ADDRESS_ROBINHOOD` from
its environment, kept as a secret in Netlify, whose build scans the repository for its value; the repository
therefore stores only `keccak256` of the research candidate and the test reads the address from
`FACTORY_ADDRESS_ROBINHOOD`, in the environment or `.env.local`). Independent signal (2026-11-03): that scan found the
configured value in this branch's earlier candidate file, so the research candidate is the address the deployed app
is configured with (deploy-preview context). That ties it to the app's configuration, not to a deployment
transaction; the on-chain checks below still decide. The address is not trusted: the test requires the code at the address to be this repository's BagFactory (immutables and metadata
masked), every candidate Bag to be this repository's Bag with `factory()` pointing back, `bagId` =
`deriveBagId(creator, uuid)`, a `BagCreated` log where the RPC serves the range, and the bag.json document to
reproduce the on-chain composition hash; it compares the address with `FACTORY_ADDRESS_ROBINHOOD` and
`BagExecutionRouter.bagFactory()` when they are configured (`.env.local`). It then checks, against the executor
deployed on the fork: authentic BAGs pass the registry checks (a full purchase where every asset routes); a wrong BAG
id (`UnknownBag`), version or composition hash (`BagChanged`), and an altered asset, order, weight or symbol
(`CompositionMismatch`) are refused. StrategyRegistry with a non-zero id (a3caff05 v2, registered): valid passes;
next version, version 0, another definitionHash and an unregistered id → `StrategyNotRegistered`; zero id with
version 0 passes without consulting the registry; zero id with a version → `InvalidTerms(13)`.

**Keeper soak (LOCAL_NODE, 2026-11-03).** `scripts/dca-keeper-soak.ts`, Hardhat node 3.14 (EDR), PostgreSQL 16 with
real `pg_ctl restart -m fast`, three jobs (A, B buy; C has ceilings at half the market). Scripted phases: scheduled run
(VERIFIED with code hash); keeper crash with a transaction in flight (dead process's leases honoured, the restarted
keeper waits for the same nonce/hash, recorded once); no second purchase in a window (keeper sends nothing, a direct
`execute` reverts `NotDue`); next period; dropped transaction (re-sent, one run); reverted transaction (owner pulled
the allowance in the same block; recorded, re-bought once); RPC outage (every job RPC_ERROR, nothing sent, recovered);
Postgres restart with a write-ahead record (record unchanged, reconciled once); two workers on one account and store
(each window once); two unobserved windows and C's windows recorded missed, never made up; reorg via
`evm_snapshot`/`evm_revert` (run marked reorged, REORG alert, re-bought once); stuck transaction replaced at the same
nonce. Then randomized cycles. Final invariants per job: one `PurchaseExecuted` per window, keeper record = chain,
`getState().runs` = event count, every live run VERIFIED with the code hash, no unresolved write-ahead record, every
closed window bought or missed and never both, append-only events hold the runs and missed windows.

| Seed | Random cycles | Faults drawn | Checks | Duration |
|---|---|---|---|---|
| 1 | 12 | drop 2, rpc 3, replace 2, revert 2, none 2, twoWorkers 1 | 49 / 49 | 63 s |
| 3 | 26 | twoWorkers 6, drop 4, restartKeeper 4, replace 3, pgRestart 3, rpc 3, revert 2, none 1 | 49 / 49 | 124 s |
| 11 | 26 | rpc 5, none 5, replace 5, twoWorkers 4, drop 3, restartKeeper 3, revert 1 | 49 / 49 | 112 s |

Reports: `docs/dca/evidence/soak-local-seed{1,3,11}.json`. The soak found two keeper bugs, fixed in this branch: the
log scan used viem's cached block number (a just-mined purchase was not found for ~4 s, so the keeper kept waiting),
and the nonce allocator did not reuse a dropped transaction's nonce (a gap that would block every later transaction).

**Older fork run (earlier executor build, unpinned; superseded):**

2026-11-02 (maintainer's machine, QuickNode Robinhood RPC, commit `12561ea`, latest block at run time; the
block number was not pinned or recorded): `1 passing` in 317 s. Run 1 of 10 USDG bought NVDA +24674165895231619 and
TSLA +12369447494712936 raw (≈ 202.6 and ≈ 404.2 USDG per token), both through the 0.05 % tier QuoterV2 picked, gas
610178; `verifyDcaReceipt` returned VERIFIED with the executor code hash; a second run in the same window reverted
`NotDue`; the next day's run passed; a run with TSLA's ceiling at half the market reverted (`Too little received`)
with no balance or counter change. The transaction hash `0x9783767d…eb6f3` exists only on the local fork. Evidence
class: TEST_KEY_FORK (Hardhat test accounts, impersonated pool for USDG funding), not a mainnet transaction.

Run (where the Robinhood RPC is reachable):

```bash
ROBINHOOD_MAINNET_RPC_URL=<rpc> npx tsx scripts/dca-fork-evidence.ts
```

```bash
npx hardhat node --fork <rpc> --fork-block-number <block>
```

```bash
DCA_SOAK_MODE=FORK DCA_SOAK_DATABASE_URL=<throwaway postgres> DCA_SOAK_PG_RESTART_CMD="docker restart dca-pg" npx tsx scripts/dca-keeper-soak.ts
```

Without a PostgreSQL on the machine, `DCA_SOAK_STORE=memory` runs the same soak with the in-memory store; the
Postgres restart and append-only checks are then reported SKIPPED (they are covered by the LOCAL_NODE runs above).
A LOCAL memory-store run (seed 5, 12 cycles) passed 47/47.

## 9. Security follow-ups (status)

| # | Issue | Status | What was done / what remains |
|---|---|---|---|
| 1 | Executor runtime code hash in keeper receipt validation | **FIXED (keeper)** | SEND mode refuses to start without `executorCodeHash`; `addJob` refuses an executor whose on-chain code differs; every run is verified with it (`codeChecked` recorded). In the SDK `expectedExecutorCodeHash` stays an OPTIONAL parameter: a direct SDK user who omits it gets `executorCodeChecked: false`, not a code check. |
| 2 | Anyone can `execute` with empty `minOutFloors`, skipping the keeper's quote floor (only the signed ceiling binds) | **MITIGATED** (when `allowedCaller` is set) / **ACCEPTED RISK** (when ANY) | New signed `allowedCaller`: only the owner's keeper can execute, so no third party can pick the moment, move the pool in the same transaction and execute up to the ceiling. Tests: `CallerNotAllowed`, and the ANY case executing at a worse-than-market price under the ceiling (documented risk). The keeper itself is trusted not to do this within the ceiling; the ceiling remains the only on-chain price bound. |
| 3 | Output-token trust (a malicious `balanceOf` can fake deliveries) | **ACCEPTED RISK (contract)** / **MITIGATED (keeper)** | The executor and adapter measure deliveries through the token's own `balanceOf`; a token that lies consistently cannot be detected on chain. Tokens are fixed by the BAG's registered composition (creator's choice, shown before signing). The keeper requires a token allowlist in SEND mode and refuses other assets. No reviewed on-chain token registry exists in the repo; the allowlist is operator configuration. |
| 4 | Confirmation, finality and reorgs | **MITIGATED** | `minConfirmations` (default 1) with re-verification of INDETERMINATE runs; reorg checks until a run is below both the `finalized` tag and `reorgDepth`; a reorged run is marked, alerted and re-bought only if the chain counters say so (soak P11). Finality on Robinhood (Arbitrum Orbit) follows the parent-chain batch; `reorgDepth` should be set from the chain's actual batch-posting lag before LIVE. |
| 5 | Pending timeout, replacement, nonce recovery | **FIXED** | Mempool presence by hash; replacement at the same nonce with a fee bump; cancel after the run deadline; STUCK_NONCE alert after the limit; lowest-free nonce allocation (no gap after a drop); DROPPED only after a grace period. Unit tests (stuck, cancel, gap) and soak (P5, P12, randomized drop/replace). Not yet exercised against Robinhood's sequencer, which has no public mempool. |

## 8. Before any deployment (not done)

1. Run `scripts/dca-fork-evidence.ts` (pinned, twice, both fork tests) and the FORK soak; record the summaries here.
2. Independent audit of `contracts/dca/*` (no audit has been done).
3. Record the BagFactory address in a deployment record on main (deploy tx, block, deployer), cross-checked by the
   real-BAG fork test; until then its only provenance is the app environment and the research branch.
4. Deploy adapter then executor from a reviewed build; verify runtime bytecode; pin the executor code hash for
   `verifyDcaReceipt({ expectedExecutorCodeHash })`.
5. Signing page that shows `summarizeDcaAuthorization` (ceiling semantics, approval amount) and decodes the typed data.
6. Keeper production decision: funded keeper account and its key management, a LIVE mode with its own review,
   monitoring/alert routing, Postgres backups.
7. Publish SDK 0.4.0 from its own merge commit before this PR merges, or release `@bagprotocol/sdk/dca` in a later
   version; nothing here may be published as part of 0.4.0.
