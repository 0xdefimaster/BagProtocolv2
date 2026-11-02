# DCA v1: typed-adapter executor, SDK verifier, keeper

Status: **code, local/integration tests and one Robinhood fork run.** Not deployed, not audited, nothing sent to
Robinhood Chain mainnet. The keeper has no live mode.

## 1. What a user does

1. Signs one EIP-712 `DcaAuthorization` (domain `BagDcaExecutor` / `1`, chain id, executor address).
2. Approves the executor for exactly `totalBudget` of the input token (USDG). Funds stay in the wallet.
3. Can stop it any time: `revoke(id)` (or a signed `Revocation` anyone submits with `revokeBySig`), and/or set the
   token allowance to 0.

The signed fields: owner, recipient, input token, BAG reference (bagId, bagVersion, compositionHash, definitionHash,
strategyId, strategyVersion), the asset list with a per-asset price **ceiling** (`maxPriceRaw`, input raw units per
whole token), the schedule (amountPerRun, totalBudget = amountPerRun × maxRuns, maxRuns, startsAt, periodSeconds,
expiresAt), the route (adapter, SwapRouter02, allowed fee tiers) and a nonce.

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
- Write-ahead before every send, in one transaction with the nonce: nonce = max(chain pending count, highest
  unresolved write-ahead nonce of the account + 1); a unique index forbids two unresolved records with one nonce.
- Reconcile before anything else: purchase logged → record (and verify with the SDK); receipt reverted, nonce used
  elsewhere, or not in the mempool after a timeout → clear and log; still pending → wait. Never re-sent blind.
- Back-fill runs other keepers sent; re-check recent runs for reorgs (block hash) and let the chain counters decide.
- Every run is verified with `verifyDcaReceipt`; anything but VERIFIED raises an alert.
- Funding, gas and RPC failures are visible states with alerts; health on `/healthz` and `/status` (127.0.0.1).
- Modes: PAPER (default, no key, no sends) and FORK (sends only to a local dev node, guarded by client version and
  chain id). There is no LIVE mode.
- The keeper needs an RPC that serves `eth_getLogs` (Alchemy's Robinhood endpoint refuses it; QuickNode and the public
  RPC serve it) and its own Postgres database (not the app's Supabase schema).

Known behaviour: because a run must also be ≥ one period after the previous one, each run's inclusion latency shifts
the earliest next run by that much. The keeper stops sending `inclusionSlackSeconds` (60 s) before a window ends.

## 7. Evidence classes

| Class | What | Status |
|---|---|---|
| LOCAL | Hardhat in-process EVM, real BagFactory/Bag/StrategyRegistry code, mock Uniswap and hostile tokens | run, passing |
| INTEGRATION | keeper store against a real local PostgreSQL 16 | run, passing |
| FORK | `contracts/test/fork/BagDcaExecutor.fork.test.ts`: real USDG/TSLA/NVDA, SwapRouter02, v3 factory, QuoterV2, StrategyRegistry on a Robinhood fork (BagFactory deployed on the fork) | **run once, passing** (2026-11-02, see below) |
| MAINNET | — | none; out of scope |

Fork run, 2026-11-02 (maintainer's machine, QuickNode Robinhood RPC, commit `12561ea`, latest block at run time; the
block number was not pinned or recorded): `1 passing` in 317 s. Run 1 of 10 USDG bought NVDA +24674165895231619 and
TSLA +12369447494712936 raw (≈ 202.6 and ≈ 404.2 USDG per token), both through the 0.05 % tier QuoterV2 picked, gas
610178; `verifyDcaReceipt` returned VERIFIED with the executor code hash; a second run in the same window reverted
`NotDue`; the next day's run passed; a run with TSLA's ceiling at half the market reverted (`Too little received`)
with no balance or counter change. The transaction hash `0x9783767d…eb6f3` exists only on the local fork. Evidence
class: TEST_KEY_FORK (Hardhat test accounts, impersonated pool for USDG funding), not a mainnet transaction.

Run the fork test where the RPC is reachable (`ROBINHOOD_FORK_BLOCK` pins a block so re-runs use Hardhat's disk cache):

```bash
ROBINHOOD_MAINNET_RPC_URL=<rpc> npx hardhat test nodejs contracts/test/fork/BagDcaExecutor.fork.test.ts
```

## 8. Before any deployment (not done)

1. Fork test: done once (above). Still open: a pinned-block re-run for a reproducible record, a fork run against the
   real deployed BagFactory and real BAGs, and a fork soak of the keeper (`npx hardhat node --fork <rpc>`, worker in
   FORK mode).
2. Independent audit of `contracts/dca/*` (no audit has been done).
3. Decide the BagFactory and StrategyRegistry addresses from deployment records (main has no verified BagFactory
   address record) and the `chainLabel` (`robinhood`).
4. Deploy adapter then executor from a reviewed build; verify runtime bytecode; pin the executor code hash for
   `verifyDcaReceipt({ expectedExecutorCodeHash })`.
5. Signing page that shows `summarizeDcaAuthorization` (ceiling semantics, approval amount) and decodes the typed data.
6. Keeper production decision: funded keeper account and its key management, a LIVE mode with its own review,
   monitoring/alert routing, Postgres backups.
7. Publish SDK 0.4.0 from its own merge commit before this PR merges, or release `@bagprotocol/sdk/dca` in a later
   version; nothing here may be published as part of 0.4.0.
