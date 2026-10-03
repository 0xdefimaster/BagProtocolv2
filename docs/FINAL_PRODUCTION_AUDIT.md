# BAG Protocol — Final Production Audit

> **Correction (this pass, Sept 22):** items B.1, B.2, and B.5 below (and
> the matching rows in section E / the summary in section F) are **stale**
> — all three were resolved by the later V11 hardening pass
> (`docs/V11_HARDENING_REPORT.md`), which post-dates this document. Left
> in place unedited below for the historical record, each with an inline
> `[SUPERSEDED — see V11]` note rather than being rewritten, since deleting
> a wrong claim silently is worse than marking it wrong. **V11_HARDENING_REPORT.md's
> own section 10 ("REMAINING BLOCKERS") is the current, authoritative list**
> — not this document's section B. In short, as of V11: `RedeemFeeRouter`
> IS wired into the real redemption UX, the Uniswap swap-target address IS
> independently verified (cross-checked against a second, unrelated
> source this session), and multi-asset redemptions ARE supported through
> it. What V11 confirms is still genuinely open: nothing is deployed to a
> real chain yet (unchanged), and — a real gap this pass did not catch —
> `signFeeAttestation()` hardcodes `minUserProceeds` to 0, i.e. no live
> slippage protection on the redeem-side swap legs yet (needs a `QuoterV2`
> integration).

Date of this pass: 2026-09-09 (sandbox clock; conversation date 2026-09-10).
Scope: full repository audit + implementation of the production-critical
gaps that were both genuinely missing and safely fixable without external
infrastructure access (no live Robinhood Chain RPC, no live Supabase
instance, no Google Fonts network access from this sandbox). Every claim
below was checked against the actual code and, where possible, against a
real local Postgres 16 instance and a real Hardhat/viem chain — not
inferred from documentation or comments.

---

## A. Completed this pass

1. **Vercel Cron routes were non-functional — fixed.** Verified against
   Vercel's own docs that Cron Jobs trigger registered paths with an HTTP
   **GET** request, not POST. Both `app/api/cron/settle-creator-rewards`
   and `app/api/cron/reconcile-creator-rewards` only exported `POST` —
   a real Vercel Cron invocation would have gotten a 405 and never run.
   Added `GET` handlers (delegating to the same logic) to both routes.
   `POST` is kept for manual/alternate-scheduler use.

2. **New fork royalties were never reaching `creator_reward_settlements`
   — fixed atomically.** Migration 0016 (already in the repo before this
   pass) added `royaltyActivityId`/`royaltyAmount` to
   `apply_purchase_execution()`'s return value, but nothing in
   `lib/server/purchase-execution.ts` ever read it — every fork royalty
   earned after 0014 shipped was silently falling through to the same gap
   only migration 0015's legacy backfill covered. Fixed by adding
   migration `0017_atomic_fork_royalty_settlement_row.sql`, which moves
   the `creator_reward_settlements` insert INTO the same SQL transaction
   as the royalty's own `activities` row — closing a real crash-window
   bug an earlier two-statement (SQL then separate TypeScript insert)
   version would have had. Verified end-to-end against a real local
   Postgres 16: atomic insert, idempotency on retry (0 duplicate rows),
   self-fork exemption (creator buying their own root bag pays no
   royalty and creates no settlement row) — all confirmed by direct RPC
   calls, not just read from the SQL.

3. **Full-repository audit performed and cross-checked against actual
   code** (not just `docs/CREATOR_REWARDS_SETTLEMENT.md`, which was
   already stale in places — e.g. it didn't mention 0016/0017 existing).
   Confirmed genuinely complete and working, with real tests run (not
   assumed): `CreatorRewardsVault.sol`, `RedeemFeeRouter.sol` (in
   isolation), the Supabase-backed `RewardSettlementRepo` /
   `ReconciliationRepo` implementations, the real viem-backed
   `VaultChainClient` / `VaultReadClient` implementations, the EIP-712
   fee-attestation signing service, and the Create Bag performance-fee UI
   (already present, `performanceFeeBps` 0–30%, server-authoritative).

---

## B. Remaining blockers (genuine — not fixable from this pass)

1. **`[SUPERSEDED — see V11]` `RedeemFeeRouter` is not wired into the real redemption UX.**
   `hooks/use-redeem-execution.ts` still drives redemption entirely
   through LI.FI's `executeRoute()` + the legacy `apply_redeem_execution()`
   RPC. The backend half (`/api/redeem-intent/:id/attest-fee`,
   `signFeeAttestation()`) is real and correct, but nothing calls it.
   **Why this can't be safely finished right now:** `RedeemFeeRouter.redeem()`
   takes a caller-supplied `swapTarget` + raw `swapCallData` — the actual
   DEX route/calldata construction is a genuine client-side responsibility
   this codebase has no code for (LI.FI served this role for the
   multi-chain purchase flow, but that's a different execution model; a
   single-chain router call needs either a Uniswap SDK integration or a
   swap-routing API this app doesn't call anywhere). Building that against
   a swap target that isn't verified yet (see #2) would mean either
   inventing an address or building unusable dead code.
   **Exact action required:** (a) resolve #2 below, (b) implement a
   client-side swap-route builder for the specific allowlisted DEX
   (Uniswap v3/v4 on Robinhood Chain, per third-party volume reports —
   never independently confirmed as canonical by this pass), (c) replace
   `use-redeem-execution.ts`'s LI.FI call with a direct
   `RedeemFeeRouter.redeem()` viem call using the attestation + swap
   calldata, (d) have the owner call `RedeemFeeRouter.setAllowedSwapTarget`
   once a real target is confirmed.

2. **`[SUPERSEDED — see V11]` `ROBINHOOD_UNISWAP_SWAP_TARGET_ADDRESS` / router address — still
   not verified.** Robinhood's own `docs.robinhood.com/chain/protocol-contracts`
   page lists Permit2 but no canonical Uniswap router/factory address for
   Robinhood Chain. Third-party sources report Uniswap pools exist on the
   chain, which is not the same as an official canonical router address.
   `lib/config/robinhood-chain.ts` correctly encodes this as `null` with a
   fail-closed contract (verified — every call site that would need this
   throws rather than guessing). **Exact action required:** confirm
   directly against Uniswap's own deployment registry
   (`docs.uniswap.org/contracts/v3/reference/deployments` or the v4
   equivalent) or a second, independent Robinhood-side confirmation, then
   fill in `UNISWAP_ROUTER_ADDRESS` and have the vault/router owner
   allowlist it on-chain.

3. **Real deployment has never been broadcast.** `scripts/deploy-creator-rewards.ts`
   compiles and typechecks; this sandbox has no network route to
   `rpc.mainnet.chain.robinhood.com` (not in the container's egress
   allowlist), so `CREATOR_REWARDS_VAULT_ADDRESS` / `REDEEM_FEE_ROUTER_ADDRESS`
   remain unset. Every downstream consumer (settlement worker, reconciliation
   job, dashboard claim button) already fails closed on this — verified
   by reading each one's `null` handling, not assumed.

4. **`npm run build` could not be completed in this sandbox** — it fails
   at the `next/font/google` fetch step (`fonts.googleapis.com` is not in
   the container's network allowlist), not on any application code. `tsc
   --noEmit` (which covers the same type-level surface `next build` would
   hit first) is clean. **Exact action required:** run `npm run build`
   once in an environment with normal internet access before deploying;
   nothing in this pass gives a reason to expect it to fail there.

5. **`[SUPERSEDED — see V11]` Multi-asset redemptions cannot use `RedeemFeeRouter` at all** (by
   design — `signFeeAttestation()` fails closed with
   `MultiAssetRedemptionNotSupportedError` rather than attesting a fee for
   only part of such a redemption). This protocol has no pooled custody,
   so a redemption can genuinely span several distinct underlying assets.
   Not a bug — a documented, correct scope limit — but it means even once
   #1/#2 are resolved, single-asset redemptions are the only ones that can
   go through the fee-enforced path; multi-asset redemptions still need
   either N separate signed calls or a multi-leg router redesign, neither
   built.

6. **No automated scheduler is actually running the cron routes anywhere
   yet.** `vercel.json` declares the schedule; nothing in this sandbox can
   confirm Vercel (or any other scheduler) is actually deployed and
   invoking it. This is an infrastructure/deployment step, not a code gap.

---

## C. Security findings

| Severity | Finding | Detail |
|---|---|---|
| **HIGH** (fixed) | Cron routes silently non-functional | See A.1 — would have meant NO reward ever settles or gets reconciled in production, with no error surfaced (Vercel would just log 405s an operator might never check). |
| **HIGH** (fixed) | New fork royalties permanently stuck as paper credit | See A.2 — every post-0014 royalty was invisible to the settlement worker with no automatic recovery path. |
| **LOW** | `creator_reward_settlements`'s RLS policy is dead code | `using (creator_id = auth.uid())` — this app has no Supabase Auth session (custom wallet-signature JWT model, confirmed via `durum-raporu-v2.md` and by grepping for any browser-side Supabase client — none exists), so `auth.uid()` is always `null` and this policy never matches any row for anyone. Not currently exploitable (the browser never talks to Supabase directly; every access goes through Next.js API routes using the service-role key, which bypasses RLS by design, and those routes were checked to filter by the authenticated session's own user id). Recommend either removing the misleading policy or documenting plainly that RLS is not this app's security boundary, so a future engineer doesn't mistake it for one. |
| **LOW** | Cron secret comparison is not timing-safe | `require-cron-secret.ts` uses `!==` string comparison. Low practical risk (the secret is high-entropy and this isn't a user-facing auth path), but a constant-time comparison is cheap and removes the concern entirely. |
| **INFO** | No rate limiting observed on `/api/redeem-intent/:id/attest-fee` | Each call re-derives the fee from authoritative server state (no client-controlled amount), so spamming it can't manipulate accounting — but it does re-run a DB round trip + a signature per call. Low priority; note for later if abuse is observed. |

No other client-trust violations were found in the routes and RPCs
inspected this pass (purchase, redeem, creator rewards, deployment):
price, fee amount, creator id, and settlement status are all
server-derived in every path checked.

---

## D. Test results (actually run this pass, not assumed)

```
npx hardhat test        → 40 passing (40 nodejs)
npx vitest run           → 46 test files, 477 tests passed
npx tsc --noEmit         → clean (only scripts/spike/deploy-19x-a.ts's
                            pre-existing BigInt-literal/ES2017-target
                            errors remain — unrelated spike script, not
                            touched by any phase of this work)
npm run build            → NOT completed — fails at next/font/google's
                            fetch step due to this sandbox's network
                            egress allowlist (fonts.googleapis.com is not
                            reachable). Not an application defect.
```

Plus, verified directly against a real local Postgres 16 instance (not
just read for syntax): migrations 0015/0016/0017's atomicity,
idempotency, and self-fork-exemption behavior, via direct RPC calls with
real fixture data.

---

## E. Production configuration checklist

| Item | Status |
|---|---|
| Robinhood Chain RPC (`ROBINHOOD_RPC_URL`) | ✅ verified, hardcoded in `lib/config/robinhood-chain.ts` |
| USDG reward token address | ✅ verified against `docs.robinhood.com/chain/contracts` |
| USDG decimals (6) | ✅ third-party cross-confirmed (Robinhood's own page doesn't print it) |
| Uniswap/DEX swap target | `[SUPERSEDED — see V11]` ✅ now verified — SwapRouter02/UniversalRouter/QuoterV2 confirmed against `developers.uniswap.org`'s Robinhood Chain deployments page, cross-checked against an independent source |
| `CreatorRewardsVault` address | ❌ not deployed — `CREATOR_REWARDS_VAULT_ADDRESS` unset |
| `RedeemFeeRouter` address | ❌ not deployed — `REDEEM_FEE_ROUTER_ADDRESS` unset (code-side wiring is done as of V11; this row is purely "hasn't been broadcast to a real chain yet") |
| Settlement signer (`CREATOR_REWARDS_SETTLEMENT_PRIVATE_KEY`) | ❌ not provisioned |
| Fee attestor (`REDEEM_FEE_ATTESTOR_PRIVATE_KEY`) | ❌ not provisioned |
| Owner/multisig (`CREATOR_REWARDS_OWNER_ADDRESS`) | ❌ not provisioned |
| Supabase project (URL + service role key) | ❌ not connected in this sandbox — code fails closed (`isSupabaseConfigured()`) when absent, verified |
| `CRON_SECRET` | ❌ not provisioned — routes correctly return 503 when absent, verified |
| Vercel Cron schedule | ✅ declared in `vercel.json`; not verified as actually running (needs a real deployment) |
| Historical reward migration (0015 backfill functions) | ✅ implemented, idempotent, tested against real Postgres |

---

## F. Final production readiness

> **NOT READY — but for a narrower reason than this section originally said.**
> `[SUPERSEDED — see V11]` The paragraph immediately below is stale (it
> predates the V11 pass, which wired `RedeemFeeRouter` into the real
> redemption UX and independently verified the swap-target address — see
> the correction note at the top of this document). The current, accurate
> reason this is still NOT READY: nothing has been deployed to a real
> chain yet, and the redeem-side swap legs have no live slippage
> protection (`minUserProceeds` hardcoded to 0 — see V11's own remaining-
> blockers list). Kept below unedited for the historical record.

Real on-chain execution for the performance-fee path
(`RedeemFeeRouter`) is still disconnected from the actual user-facing
redeem flow, and the swap-target address it depends on has not been
independently verified — per this brief's own final rule, that alone is
disqualifying regardless of how much else is solid. The fork-royalty
settlement pipeline (purchase → `creator_reward_settlements` → cron
worker → `CreatorRewardsVault.settleReward` → creator claim) is now
genuinely complete and internally consistent end-to-end in code and
locally-verified behavior, but has never run against a real deployed
vault or a real Supabase instance, since neither exists yet outside this
sandbox.

---

# Addendum — User-Signed Bag Deployment (§11–17)

Date of this pass: 2026-09-22 (sandbox clock). Scope: finish and integrate
the user-signed Bag deployment architecture end to end into the real
repository — contracts, migrations, server, tests, and the frontend flow.
Full detail (flow diagram, endpoint contracts, trust boundary, how to run
the tests) is in `docs/USER_SIGNED_DEPLOYMENT.md`; this section is the
audit summary in the same format as the rest of this file.

## A. Completed this pass

1. **`BagFactory.createBag()` made permissionless and user-signed.** It
   previously had an `owner`/`deployer` role (`onlyDeployer`) — a real
   user's wallet calling it would have reverted. Rewritten with no
   constructor args, no owner, and `bagId = keccak256(abi.encode(msg.sender,
   offChainRef))`, so the Bag's on-chain identity is bound to whichever
   wallet actually signs — no server key can call it, and nobody can
   squat another creator's `offChainRef` (a different sender derives a
   different id). `Bag.sol` updated to match (`offChainRef` field added,
   constructor takes it). `scripts/deploy-bag-factory.ts` updated (no
   constructor args); `contracts/test/BagFactory.test.ts` rewritten
   (anti-squatting, no-owner, event-shape cases) and
   `BagExecutionRouter.test.ts` adapted to deploy through the new factory.

2. **New migrations 0024–0026** (the repo's migrations stopped at 0023):
   - `0024_user_signed_bag_deployment.sql` — adds `on_chain_bag_id` /
     `on_chain_creator`, canonicalises existing hex to lowercase, backfills
     legacy DEPLOYED rows, **fails loudly** (not silently) on any
     pre-existing duplicate/malformed row, asserts `unique (bag_id, chain)`
     really exists (defensively — it's already in `schema.sql`), adds
     `unique (chain, tx_hash)` / `unique (chain, on_chain_bag_id)`, format
     checks, "DEPLOYED ⇒ has an on-chain id", and a deferred constraint
     trigger enforcing "a Bag with a DEPLOYED deployment is never DRAFT"
     (repairing any pre-existing violation first). Drops the legacy
     `start_bag_deployment()`.
   - `0025_confirm_bag_deployment_rpc.sql` — `confirm_bag_deployment()`,
     the only writer of a DEPLOYED row: one transaction, row-locks the
     **Bag** (which always exists, unlike a not-yet-created deployment
     row) so concurrent first confirmations serialize there; idempotent on
     the same tx, `CONFLICT` on a different one, `STALE_VERSION` if the
     composition changed since the verified tx, atomic Bag finalization
     (registry pointer + DRAFT→ACTIVE) in the same transaction. Execute
     revoked from `PUBLIC`/`anon`/`authenticated`, granted to
     `service_role` only.
   - `0026_restrict_rpc_execute_privileges.sql` — the same lockdown for
     **every** existing public-schema RPC (`apply_purchase_execution`,
     `commit_investment_transaction`, …), because Supabase grants EXECUTE
     on new functions directly to `anon`/`authenticated` and
     `revoke … from public` alone does not remove that. Confirmed
     empirically (see D) that without this, `anon`/`authenticated` had
     EXECUTE on every RPC in the schema.

3. **Server: one production deployment path**, replacing the old
   single-step, backend-signed one:
   - `lib/blockchain/adapter.ts` — new `BagDeploymentAdapter` interface
     (`prepareBagCreation` / `hasBagOnChain` / `verifyBagCreation`),
     deliberately separate from the NFT/mock `BlockchainAdapter` so no mock
     can ever be selected for Bag deployment.
   - `lib/blockchain/evm/adapter.ts` — the only production implementation:
     read-only, no wallet client at all. `verifyBagCreation()` enforces all
     12 invariants from the spec (tx exists/succeeded/right target/right
     sender/event exists/right factory/right creator/right offChainRef/
     right compositionHash/right bagId/`factory.bagOf` agrees/`Bag`'s own
     getters agree), with an explicit, bounded receipt wait and a
     configurable confirmation depth (`CONFIRMATIONS_<CHAIN>`,
     `BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS`) — no HTTP request can hang on a
     pending transaction.
   - `lib/blockchain/evm/client.ts` — the server-side wallet client
     (`createEvmWalletClient`, backed by `DEPLOYER_PRIVATE_KEY`) removed
     entirely; confirmed by repo-wide grep that no remaining application
     code (only one-off `scripts/`) references `DEPLOYER_PRIVATE_KEY` or
     `createEvmWalletClient`.
   - `lib/server/deploy-bag.ts` — `prepareBagDeployment()` (stateless:
     ownership + session wallet + Bag-derived chain, returns unsigned
     calldata, writes nothing) and `confirmBagDeployment()` (re-derives
     every expectation from the database/session, calls
     `verifyBagCreation()`, then the one atomic finalizing RPC). The chain
     is **always** `bag.chain` — never a client/request value. Fails closed
     (`CHAIN_UNAVAILABLE`) if a chain isn't configured, in every
     environment — no mock fallback.
   - `POST /api/bags/[id]/deploy/prepare`, `POST …/deploy/confirm` (body:
     `{ txHash }` only — the ONLY client-supplied value), `GET
     …/deploy` (owner-only state read). The old single-step `POST …/deploy`
     that sent the transaction server-side is gone.
   - `lib/server/purchase-execution.ts` — the Bag Router execution path
     now reads the **persisted** on-chain id
     (`bag_deployments.on_chain_bag_id`) rather than re-deriving one; a Bag
     with no confirmed deployment is simply not routed through the Bag
     Router (falls back to LI.FI), restricted to `chain === 'robinhood'`
     since the router trusts exactly one immutable factory address.

4. **New Bags (and forks) now start `DRAFT`, not `ACTIVE`.**
   `lib/mappers/bag-mapper.ts` and `app/api/bags/[id]/fork/route.ts`
   previously created every Bag as already-ACTIVE with no deployment at
   all — contradicting "ACTIVE only after a verified on-chain deployment"
   and making a fresh Bag publicly visible/forkable with no contract
   behind it. Both now create `DRAFT`; `listBags()`'s public/Explore
   default (`status = 'ACTIVE'`) already excluded these correctly once the
   flag changed.

5. **Frontend: `hooks/use-deploy-bag.ts`** — prepare → verify the
   *connected* wallet matches the session wallet the server will require
   (fails before ever prompting a signature) → the person's own wallet
   sends the transaction (reusing the existing
   `lib/blockchain/lifi-wallet-client.ts` wallet-client helper, not a new
   library) → confirm, retried with backoff while PENDING. The pending tx
   hash is persisted to `localStorage` keyed by Bag id so a refresh mid-flow
   resumes confirming the SAME transaction rather than re-prompting a
   signature. `components/bags/DeployBagPanel.tsx` wired into the bag
   detail page (shown only for a DRAFT bag — the route already 404s a
   DRAFT bag for anyone but its owner, so no separate ownership check is
   needed there) and the create-flow's post-creation redirect updated to
   go to the new Bag's page instead of claiming it's already "published."

6. **Tests — unit, integration (real Postgres), local-EVM, and
   contract — all passing, and mutation-checked** (removing a guarantee
   makes the corresponding test fail; see `D` below for the exact
   mutations tried).

## B. Remaining blockers (genuine — not fixable from this pass)

1. **No `BagFactory` has ever been deployed to a real chain.**
   `scripts/deploy-bag-factory.ts` compiles and typechecks; this sandbox
   has no network route to any real chain's RPC (same egress-allowlist
   limitation as the prior pass's Robinhood Chain / Creator Rewards
   deployment). `FACTORY_ADDRESS_ROBINHOOD` (and ETHEREUM/BASE/ARBITRUM)
   remain unset — every code path that needs one fails closed
   (`CHAIN_UNAVAILABLE`), verified by the tests in section D, not assumed.

2. **`BagExecutionRouter` must be redeployed against the new factory once
   one exists.** `BagExecutionRouter.bagFactory` is immutable, so Bags
   created through the new `BagFactory` are not recognized by whichever
   router instance is currently deployed until it's redeployed pointing at
   the new factory address (same script dependency the original delivery
   note flagged).

3. **Legacy Bags created under the old (backend-signed, owner-restricted)
   factory, if any exist in a real deployed environment, are not
   registered in the new factory's registry.** Nothing in this pass
   migrates on-chain state — only the database's legacy-row backfill
   (migration 0024) is handled, and only for `bag_deployments` rows, not
   for re-deploying actual contracts.

4. **`npm run build` could not be completed in this sandbox** — same
   `fonts.googleapis.com` egress-allowlist limitation as the prior pass.
   `npx tsc --noEmit` is clean across the whole tree. `npx next lint` ran
   clean (only pre-existing `<img>` warnings, unrelated to this work).

5. **Real-chain verification was not performed** — no RPC access, no
   deployed factory. The closest available proof is the local-EVM
   integration suite (a real `BagFactory.sol` on Hardhat's in-process
   chain, a real wallet signing, the real read-only adapter) — see D.

## C. Security findings

| Severity | Finding | Detail |
|---|---|---|
| **HIGH** (fixed) | Every public-schema RPC was callable by `anon`/`authenticated` | Confirmed empirically against Supabase's documented default privileges (emulated in the sandbox, not a real Supabase project — see D): `revoke … from public` alone left EXECUTE granted. Fixed by migration 0026 for every existing RPC, and by 0025 for the new one. |
| **HIGH** (fixed) | `BagFactory.createBag()` was `onlyDeployer` | A real user's wallet could never have called it — the user-signed architecture was not actually reachable before this pass. |
| **MEDIUM** (fixed) | New Bags were created `ACTIVE` with no deployment | Publicly visible/forkable with nothing behind them; see A.4. |
| **LOW** | RLS on `bag_deployments` (and generally) is not this app's real security boundary | Same finding as the prior pass's addendum for `creator_reward_settlements`: this app has no Supabase Auth session, so any `auth.uid()`-based policy never matches; the real boundary is (a) the service-role client only ever being used server-side and (b) migration 0026's RPC privilege lockdown. Verified this pass directly against a real Postgres: `anon`/`authenticated` can neither call the RPC nor write/read `bag_deployments` directly (see D). |
| **INFO** | Confirmation depth defaults to 1 | `CONFIRMATIONS_<CHAIN>` is configurable per chain but defaults to 1 (mined + successful only) — appropriate for a fast/low-reorg chain, a deliberate deployment decision for whoever configures a given chain, not something this code can infer. |

## D. Test results (actually run this pass)

```
npx tsc --noEmit                                  → clean, whole tree
npx next lint                                      → clean (pre-existing <img> warnings only)
npx vitest run                                      → 59 files, 706 tests passed
                                                       (baseline before this pass: 55 files, 582 tests)
npx vitest run --config vitest.integration.config.ts (real local Postgres 16)
                                                     → 3 files, 77 tests passed
                                                       (39 DB/RPC/privilege/concurrency,
                                                        25 orchestrator w/ fake chain,
                                                        13 real local-EVM end-to-end)
npx hardhat test                                    → 84 passing (84 nodejs)
                                                       (baseline before this pass: 81)
npm run build                                       → NOT completed — next/font/google fetch
                                                       step, same network limitation as the prior
                                                       pass's addendum. Not an application defect.
```

**Mutation-checked, not just written-and-passing** — each of the following
was individually reverted/weakened and confirmed to make the
corresponding integration test(s) fail, then restored:
row-locking the Bag before a first confirm (without it, two concurrent
first confirmations can both attempt an insert); the `unique (bag_id,
chain)` constraint; the RPC privilege lockdown; the RPC's atomic Bag
finalization; the confirm route's ownership check; the adapter's
composition-hash check, target-factory check, and confirmation-depth
enforcement (checked against the REAL local EVM, not a mock) — every one,
reverted individually, broke a test; restored, all pass again.

Real Postgres was created fresh per suite run (scratch database, dropped
after) with a Supabase-emulation bootstrap
(`supabase/test-fixtures/supabase-emulation.sql`) that installs the
`anon`/`authenticated`/`service_role` roles, an `auth.uid()` stub, and
Supabase's documented default function privileges — an emulation of the
platform, not a real Supabase project or Docker.

## E. Production configuration checklist (this addendum's scope only)

| Item | Status |
|---|---|
| `FACTORY_ADDRESS_<CHAIN>` (any chain) | ❌ not deployed anywhere — see B.1 |
| `RPC_URL_<CHAIN>` | ❌ not provisioned (ETHEREUM/BASE/ARBITRUM have no fallback; ROBINHOOD falls back to the hardcoded `ROBINHOOD_RPC_URL`) |
| `CONFIRMATIONS_<CHAIN>` / `BAG_DEPLOYMENT_RECEIPT_TIMEOUT_MS` | ✅ optional, sensible defaults (1 confirmation / 20s) |
| `BagExecutionRouter` redeployed against the new factory | ❌ not done — see B.2 |
| Migrations 0024–0026 applied to the real Supabase project | ❌ not applied — verified only against a local Postgres emulation |
| `DEPLOYER_PRIVATE_KEY` (one-time, `scripts/` only) | N/A — used only to broadcast the one-time `BagFactory` deployment transaction, never read by the running application (verified by repo-wide grep) |

## F. Final production status (this addendum)

> **NOT READY**

The application, database, and contract code for user-signed Bag
deployment are complete, internally consistent, and verified — including
against a real local EVM and a real local Postgres, with mutation-checked
guarantees — but per the same standard as the rest of this document, code
correctness without a real deployed factory and a real chain
confirmation is not production readiness. `docs/USER_SIGNED_DEPLOYMENT.md`
lists the exact remaining external steps.
