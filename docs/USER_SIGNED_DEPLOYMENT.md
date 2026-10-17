# User-Signed Bag Deployment

The only production path for taking a Bag from `DRAFT` to a real on-chain
contract. The backend never holds a key that can create a Bag — the
creator's own connected wallet signs `BagFactory.createBag()`; the backend
only ever reads the chain afterward to verify what happened.

```
prepare  →  the creator's wallet signs + sends createBag  →  confirm
```

## 1. Prepare endpoint

`POST /api/bags/[id]/deploy/prepare`

- Auth: signed session cookie only. The request body is ignored entirely.
- Reads `bag.creatorId` (must equal the session user), `bag.chain` (the
  chain is **never** a request parameter), and the Bag's current
  composition.
- Returns unsigned `createBag(offChainRef, compositionHash, metadataURI)`
  calldata, the factory address, the numeric chain id, and the session
  wallet address (the only sender confirm will later accept).
- **Stateless.** No database row is created, no `DEPLOYING` state exists,
  nothing is signed or sent. Safe to call repeatedly; a rejected wallet
  prompt or a closed tab leaves nothing to clean up.
- Refuses to hand out calldata that would only revert: if a Bag for
  (session wallet, this Bag's `offChainRef`) is already registered
  on-chain (a previous transaction succeeded but was never confirmed),
  returns `ALREADY_CREATED_ON_CHAIN` — the fix is confirming the
  **original** transaction hash, not sending a new one.

## 2. Confirm endpoint

`POST /api/bags/[id]/deploy/confirm`

Body: `{ "txHash": "0x..." }` — the **only** client-supplied value in the
entire flow. Everything else (user, wallet, Bag ownership, chain, factory,
`offChainRef`, composition hash, on-chain id, block number, success) comes
from the authenticated session, the current database state, or on-chain
verification.

- Re-derives the expected `offChainRef` and composition hash **fresh from
  the database** at confirm time — never cached from prepare, never taken
  from the client. A recipe edited between prepare and confirm is caught
  here.
- Calls `verifyBagCreation()` (below) with those server-derived
  expectations.
- On success, calls the single atomic `confirm_bag_deployment` RPC, which
  writes the deployment row **and** finalizes the Bag (`DRAFT → ACTIVE`,
  registry pointer) in one database transaction.
- Idempotent: confirming the same transaction again (refresh, retry,
  double-click, any hex casing) returns the same success without writing
  again. A **different** transaction for an already-deployed
  `(bag, chain)` is a `CONFLICTING_DEPLOYMENT` — the original is never
  overwritten.
- `PENDING` (HTTP 202) is not a failure — it means "not verifiable yet",
  and the client is expected to retry the same request.
- `maxDuration = 60` on the route; the adapter's own wait is bounded by
  `BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS` (default 20s, max 55s) so no request
  can hang on a pending transaction.

## 3. Frontend flow

`hooks/use-deploy-bag.ts` + `components/bags/DeployBagPanel.tsx` (shown on
a `DRAFT` Bag's own page, owner-only — enforced by the page's existing
404-for-non-owner behavior on a non-ACTIVE Bag).

```
prepare
  → compare the CONNECTED wallet to the session wallet prepare returned
    (fails here, before ever prompting a signature, on a mismatch)
  → the wallet signs + sends the prepared transaction
    (lib/blockchain/lifi-wallet-client.ts's existing helper — no new
    wallet library)
  → persist the pending txHash to localStorage, keyed by Bag id
  → confirm, retried with backoff while PENDING
  → on success, clear the persisted hash
```

Handled explicitly: wallet mismatch (refused before signing), user
rejection (nothing was ever written — prepare is stateless, so there's
nothing to roll back), a page refresh or navigating away mid-flow (the
persisted hash lets a fresh mount resume confirming the **same**
transaction without re-prompting a signature), and a definitive
verification failure (surfaces the server's message, stops retrying).

The Bag is never marked `ACTIVE` client-side. The only way `bagStatus`
becomes `'ACTIVE'` in the hook's state is by reading it back from a
successful `confirm` response.

## 4. Session wallet source

`session.walletAddress`, read from the signed session cookie
(`lib/auth/session.ts`) — the same source `lib/server/purchase-execution.ts`
already uses for the authenticated wallet. Never the request body.

## 5. On-chain verification (`lib/blockchain/evm/adapter.ts`)

`verifyBagCreation()` re-reads the chain itself and enforces, in order:

1. the transaction exists (otherwise `PENDING`, not a failure)
2. it's sent **to** the configured `BagFactory`
3. it's sent **from** the session wallet (checked before waiting for a
   receipt, so a wrong sender is rejected immediately)
4. it's mined, successful, and has reached the configured confirmation
   depth (`CONFIRMATIONS_<CHAIN>`, default 1), within the bounded wait
5. exactly one `BagCreated` event exists, emitted **by** the factory (a
   spoofed lookalike event from another contract is ignored, not treated
   as a duplicate)
6. `BagCreated.creator` equals the session wallet
7. `BagCreated.offChainRef` equals the server-derived value
8. `BagCreated.compositionHash` equals the **current** database
   composition hash (not a value cached from prepare)
9. `BagCreated.bagId` equals `keccak256(abi.encode(creator, offChainRef))`
10. `factory.bagOf(bagId)` resolves back to the emitted Bag address
11. `Bag.creator()` (read directly from the deployed contract) equals the
    session wallet
12. `Bag.factory()` / `Bag.offChainRef()` / `Bag.bagId()` agree with the
    event and the expected values
13. `Bag.isMutable()` equals `bags.mutability === 'MUTABLE'` (immutability
    is enforced on-chain: an IMMUTABLE Bag can never record a new version)

None of these may be weakened. Every one is covered by a dedicated test
in `lib/blockchain/evm/__tests__/adapter.test.ts` (mocked viem client) and
by `lib/server/__tests__/integration/bag-deployment-local-evm.integration.test.ts`
(a real `BagFactory.sol` on a local EVM).

## 6. Database state transitions

```
DRAFT  --prepare-->  DRAFT  (no row created)
DRAFT  --confirm (verified)-->  DEPLOYED + ACTIVE   (one transaction)
DEPLOYED  --confirm (same tx, any retry)-->  DEPLOYED  (idempotent, no rewrite)
DEPLOYED  --confirm (different tx)-->  CONFLICT   (original untouched)
```

There is no `DEPLOYING` state in the new flow (legacy rows that carried it
are handled by migration 0024, never written by the current code).

## 7. Concurrency protection

`unique (bag_id, chain)` (already present in `schema.sql`, re-asserted
defensively by migration 0024) is the last-line guarantee. The RPC
additionally row-locks the **Bag** (which always exists, unlike a
not-yet-created deployment row) before deciding whether to insert or
update, so two simultaneous first confirmations serialize there rather
than racing an INSERT. Verified directly: N simultaneous confirmations of
the same transaction all succeed with exactly one row and one real
writer; N simultaneous confirmations of *different* transactions leave
exactly one winner and the rest as explicit conflicts, never a corrupted
or blended record.

## 8. Retry / idempotency behavior

Covered above (§2, §6). Additionally: an unmined transaction answers
`PENDING` on every retry without writing anything; once mined, the
**same** confirm request (no new call needed) succeeds.

## 9. Test results

Current numbers and the exact commands run are in
[`DEMO_READINESS.md`](archive/DEMO_READINESS.md) ("Verified" section). All suites
(unit, real-Postgres/local-EVM integration, Hardhat contracts), `tsc`, lint
and `next build` pass on Node 24. The receipt check is a bounded, per-call
poller (`lib/blockchain/evm/receipt-confirmation.ts`), so concurrent confirms
of one transaction are deterministic — no test retries.

### Running the tests

```bash
npm test                              # unit — no external dependencies
TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres \
  npm run test:integration            # real PostgreSQL 14+ superuser connection
                                       # required; also runs a Hardhat in-process
                                       # EVM (no extra setup needed for that part)
npm run test:contracts                # Hardhat
```

`TEST_DATABASE_URL` must point at a real, reachable PostgreSQL instance
(local install, `docker run postgres:16`, the Supabase CLI's local
database, …) — never a production project's database. Each integration
suite creates its own scratch database (`bag_it_<random>`) and drops it
afterward. No Docker is required for the local-EVM suite; Hardhat runs it
in-process.

## 9b. Factory rotation policy (operational invariant, not code)

**Status:** deliberately NOT solved with a new DB column or a runtime RPC
check. Recorded here as a deployment procedure instead — see the
reasoning below for why that's the right call at this stage.

**The gap:** `bag_deployments.factory_address` is written once, at confirm
time (`evm/adapter.ts` checks `Bag.factory()` against the then-configured
`FACTORY_ADDRESS_<CHAIN>` — see section 5), and never read again.
`getDeployedOnChainBagId()` (section on Bag Router eligibility,
`lib/server/bag-deployment-repo.ts`) hands `on_chain_bag_id` to the
execution layer without re-checking which factory produced it against
whatever `FACTORY_ADDRESS_<CHAIN>` is configured *now*. If a `BagFactory`
were ever replaced (`FACTORY_ADDRESS_<CHAIN>` repointed to a new
deployment, `BagExecutionRouter` redeployed against it), every Bag created
under the OLD factory would still look routable in the DB.

**Why this is not a fund-safety issue:** `BagExecutionRouter.execute()`
resolves `bagFactory.bagOf(planBagId)` on-chain before doing anything
else. A Bag id from the old factory is unknown to the new factory's
registry, so this reverts with `UnknownBag` — deterministically, before
any token custody or swap happens. Worst case is a wasted gas
attempt/wallet prompt for the user, not a fund-loss or wrong-recipient
risk.

**Why no DB/runtime fix now:** at this stage nothing is deployed to a
real chain yet (no `BagFactory`, no real Bag history, no
`BagExecutionRouter` in production — see docs/archive/FINAL_PRODUCTION_AUDIT.md
§E). Adding a `bag_deployments`-vs-`FACTORY_ADDRESS_<CHAIN>` cross-check
now would be solving for a rotation that has never happened, against a
factory that doesn't exist yet — real complexity for a hypothetical.

**The policy instead:** `BagFactory` is deployed exactly once per chain;
its address is treated as a fixed, immutable part of that chain's
production configuration (`FACTORY_ADDRESS_<CHAIN>`), the same way the
contract's own `bagFactory` field is immutable in Solidity. If a new
factory is ever genuinely needed:
1. Deploy the new `BagFactory`.
2. Deploy a new `BagExecutionRouter` pointed at it (its `bagFactory` is
   immutable — this is not optional).
3. Update `FACTORY_ADDRESS_<CHAIN>` / `BAG_EXECUTION_ROUTER_ADDRESS` together, as one atomic config change, never independently.
4. Run `scripts/verify-bag-router-factory.ts` against the new pair before flipping production traffic to it (section 3 above).
5. Any Bag created under the OLD factory keeps working for LI.FI-based
   execution (it never depended on the Bag Router path); it simply never
   becomes routable through the native Bag Router again. This is
   accepted, not migrated — no existing user flow requires that a Bag's
   Bag Router eligibility survive a factory rotation.

Revisit this policy (and only then consider a real `factory_address`
cross-check) if the product ever needs multiple factories live
concurrently on the same chain — not needed for the current one-factory-
per-chain model.

## 10. Remaining external configuration

- No `BagFactory` has been deployed to any real chain yet — run
  `DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-bag-factory.ts
  <chain>` once real RPC access and a funded key are available, then set
  `FACTORY_ADDRESS_<CHAIN>` (see `.env.example`).
- `BagExecutionRouter` must be redeployed pointing at the new factory
  (`scripts/deploy-bag-execution-router.ts`) — its `bagFactory` reference
  is immutable, and Bags deployed through the new factory are not
  recognized by an already-deployed router instance until then.
- Migrations 0024–0036 have not been applied to any real Supabase
  project (0033 fee lock, 0034 accounting reconciliation, 0035 on-chain
  versioning, 0036 accounting guards among them) — apply them in order, then re-run the privilege/RLS checks
  (`docs/archive/FINAL_PRODUCTION_AUDIT.md`'s addendum, section D) directly
  against that project rather than trusting the local emulation alone.

## Versioning a deployed MUTABLE Bag (on-chain path)

A deployed Bag's composition changes only through a **creator-signed** transaction:
`BagFactory.recordBagVersion(offChainRef, expectedCurrentVersion, compositionHash, metadataURI)`
calls the deployed `Bag.recordVersion`. The server never signs.

| Step | Where |
|---|---|
| 1. Creator submits the new recipe | `POST /api/bags/[id]/versions/prepare` → `prepareBagVersionUpdate()` |
| 2. Validation, composition hash and metadata URI; checks that the Bag is mutable, deployed, owned by the session user, created on-chain by the session wallet, fee-lock compatible, and that `Bag.version()` equals the recorded `bag_deployments.on_chain_version` | `lib/server/bag-versioning.ts` |
| 3. Returns unsigned calldata; the creator's wallet signs and sends it | browser wallet |
| 4. Creator re-submits the recipe with the `txHash` | `POST /api/bags/[id]/versions/confirm` → `confirmBagVersionUpdate()` |
| 5. Verifies the tx, the receipt (bounded wait, confirmation depth), and exactly one `BagVersionRecorded` plus exactly one `CompositionUpdated` matching the server-derived bagId, address, creator, version, hash and URI | `lib/blockchain/evm/version-adapter.ts` |
| 6. Records the version atomically, only after step 5 | `record_onchain_bag_version()` (migration 0035) |

**Security model.**

- **Creator binding.** The factory derives the Bag id from `msg.sender`, so a
  stranger cannot address another creator's Bag (`UnknownBag`).
- **Immutability holds on-chain.** `Bag.isMutable` is set at `createBag` and
  verified against `bags.mutability` at deploy-confirm. An IMMUTABLE Bag
  reverts `ImmutableBag`, and the database also refuses to version it.
- **Races are serialized twice.**
  - On-chain: `expectedCurrentVersion` is a compare-and-swap, so a second
    update built on the same version reverts `StaleVersion`.
  - In the database: `record_onchain_bag_version` compare-and-swaps
    `on_chain_version` under the Bag row lock.
- **No double recording.** One transaction hash records at most one version
  (a unique index), so repeated confirms are idempotent.
- **The database cannot run ahead of the chain.** `create_bag_version`
  (off-chain only) refuses a deployed Bag. Undeployed DRAFT Bags keep
  versioning off-chain; the deployment then commits to the latest version.
- **Fee lock.** If the performance fee locks between prepare and confirm, the
  already-mined version is recorded with the locked fee and flagged
  `feeLockedOverride`. The on-chain hash covers the composition only, so the
  chain and the database still agree.

**Contract ABI change.** `createBag` now takes a fourth argument,
`bool isMutable`. `BagCreated` is unchanged. Any already-deployed factory from
before this change must be redeployed.

**Not built.** There is no version-editing UI yet. The two routes and the
server functions are complete and tested
(`bag-versioning-local-evm.integration.test.ts`, contract tests in
`contracts/test/BagFactory.test.ts`).
