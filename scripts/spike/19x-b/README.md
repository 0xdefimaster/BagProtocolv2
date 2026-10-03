# Phase 19.X-B — LI.FI Mainnet-Fork Composability Spike

## THIS SESSION'S NEW FINDINGS (materially change the confidence picture, do NOT change the BLOCKED verdict)

Two things this pass confirmed that prior passes (V9, V10) could not, because
`web_search`/`web_fetch` were themselves returning transient errors at the
time:

1. **LI.FI officially supports Robinhood Chain, mainnet, same-chain
   swaps included** — first-party confirmed via LI.FI's own blog post
   ("LI.FI Is Live on Robinhood Chain from Day One", li.fi/knowledge-hub)
   and their own `/v1/chains` API reference documentation example, which
   lists Robinhood Chain with `"id": 4663, "mainnet": true` verbatim. This
   was previously an open question ("is LI.FI support even real for this
   chain?") — it is now answered: **yes**.
2. **WETH/USDG has real, large, currently-active liquidity on Robinhood
   Chain** — independently confirmed via DexPaprika (third-party DEX
   aggregator, not affiliated with LI.FI or Uniswap): "WETH/USDG on
   Uniswap V3 is currently the highest-volume liquidity pool on Robinhood
   Chain, with $567.10M in 24-hour trading volume" (as of 2026-09-10). This
   is the exact Uniswap V3 deployment already verified in V11
   (`lib/config/robinhood-chain.ts`'s `UNISWAP_ROUTER_ADDRESS` etc.) — the
   liquidity claim and the router-address claim now cross-confirm each
   other from two independent source families.

**What is STILL blocked, unchanged from every prior pass**: this sandbox
still cannot make an actual `GET https://li.quest/v1/quote?...` call with
real, current parameters (bash's egress proxy returns 403 for `li.quest`;
`web_fetch` can only retrieve URLs that already appeared verbatim in a
prior search/fetch result — a dynamic quote endpoint's exact query string
for THIS pair never will), and still cannot fork Robinhood Chain mainnet
(`ROBINHOOD_MAINNET_RPC_URL` -> 403, confirmed again this session with the
exact same error as before). **Getting much more confident evidence that a
real attempt would likely succeed is not the same as actually running it**
— per this task's own explicit instruction, that distinction is preserved,
not blurred, in the verdict below.

---

## Why this couldn't be run to completion from the sandbox that wrote it

Two independent, confirmed network blocks — reproduced directly in this
session (again), not assumed:

```
$ curl -m 5 -o /dev/null -w '%{http_code}\n' https://li.quest/v1/chains
403
$ curl -m 5 -o /dev/null -w '%{http_code}\n' https://rpc.mainnet.chain.robinhood.com
403
```

`web_search`/`web_fetch` worked well THIS session (unlike the prior pass,
where they returned transient `Server error (500)` for every query) — they
were used to establish the two new findings above, and to independently
re-verify the Uniswap v3 addresses already in `lib/config/robinhood-chain.ts`
via DexPaprika's pool data, which references the same Uniswap V3
deployment. But neither tool can perform an authenticated, parameterized,
real-time API call the way `li.quest/v1/quote` requires, nor can either
reach an RPC endpoint to fork state from. No quote was fabricated. LI.FI
was not mocked.

## What IS ready, verified working, in this repo right now

1. **`hardhat.config.ts`'s `robinhoodFork` network** — connects cleanly.
   Verified two ways:
   - Without `ROBINHOOD_MAINNET_RPC_URL` set: connects, but to an EMPTY
     local chain (chainId 31337) — Hardhat does NOT error in this case,
     it silently gives you a normal non-forked chain. This is a real trap
     for anyone running this later without noticing — see the preflight
     check below, which exists specifically because of this.
   - With `ROBINHOOD_MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com`
     set: fails loudly and immediately with
     `The Http server returned error status code: HTTP status client self
     (403 Forbidden) for host (rpc.mainnet.chain.robinhood.com)` — proving
     the network block applies to Hardhat's fork mechanism too, not just
     raw curl.

2. **`scripts/spike/19x-b/run.ts`'s preflight check** — refuses to proceed
   unless the connected chain BOTH reports `chainId === 4663` AND has real
   contract bytecode at the known USDG address. Tested against the
   no-RPC-set case above; correctly throws
   `PREFLIGHT FAILED: connected chainId is 31337, not 4663` instead of
   silently continuing against nothing.

3. **`contracts/spike/BagRouterSpike.sol`** (from 19.X-A, unmodified) —
   already accepts an arbitrary `{ target, callData, value, approveToken,
   approveAmount }` for each leg. A real LI.FI `transactionRequest` slots
   in as Leg B with ZERO contract changes:
   `target = transactionRequest.to`, `callData = transactionRequest.data`,
   `value = transactionRequest.value`, `approveToken = fromToken.address`,
   `approveAmount = fromAmount`, using `estimate.approvalAddress` (if
   present and different from `to`) as the approval target instead. This
   was verified by re-reading the contract's `Leg` struct and
   `executeComposed` logic against the actual shape of a LI.FI
   `transactionRequest`, not assumed.

## Exact steps to actually run this (needs an environment with real network access)

1. Get a real quote:
   ```
   curl 'https://li.quest/v1/quote?fromChain=4663&toChain=4663&fromToken=<A>&toToken=<B>&fromAmount=<amt>&fromAddress=<any address>'
   ```
   Use a Robinhood Chain mainnet pair LI.FI actually supports — WETH
   (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`) <-> USDG
   (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) is the most likely to
   have real routes, per both tokens being Robinhood's own documented
   canonical assets.
2. Save the full response into `scripts/spike/19x-b/lifi-quote.json`
   (shape in `lifi-quote.example.json` — must be the REAL response, not
   hand-edited).
3. `ROBINHOOD_MAINNET_RPC_URL=<a real Robinhood Chain mainnet RPC>
   npx hardhat run scripts/spike/19x-b/run.ts --network robinhoodFork`
4. `run.ts` currently stops right after preflight + quote-loading with an
   explicit `NOT IMPLEMENTED PAST THIS POINT` error — funding the test
   wallet with a real `fromToken` balance needs an `impersonateAccount`
   call against a real, sufficiently-funded holder address, and which
   holder to impersonate depends on which token the real quote turned out
   to be for. This is a ~20-line addition once step 2's real quote exists
   (Hardhat's `test-helpers`' `impersonateAccount` + `setBalance`, same
   pattern as any standard fork test), deliberately not guessed at here.
5. Once funded, the actual compose-and-assert logic is a direct port of
   `contracts/test/spike/BagRouterSpike.test.ts`'s existing
   success/B-fails-after-A/A-fails-before-B scenarios, with Leg B now
   populated from the real quote instead of `TestSwapPool`. That test file
   already proves the assertions this spike needs (atomic revert, no
   stuck tokens, no leftover approvals) against a structurally-identical
   Leg B shape — only the CONCRETE calldata source changes for 19.X-B, not
   the test logic.

## Deliverable status (per the task's exact requested fields)

| Field | Status |
|---|---|
| Exact quote | **BLOCKED** — no LI.FI API access from this sandbox |
| Exact route | **BLOCKED** — depends on the quote |
| Target address | **BLOCKED** — depends on the quote |
| Calldata | **BLOCKED** — depends on the quote |
| Approval model | **PARTIALLY KNOWN**: LI.FI's own docs (from training-data knowledge, NOT re-verified this session since docs access failed) describe an `estimate.approvalAddress` field precisely because it can differ from `transactionRequest.to` — the exact real value for this specific pair is unconfirmed |
| Fork chain | **NOT ESTABLISHED** — RPC access blocked, confirmed via both curl and Hardhat's own fork mechanism |
| Execution trace | **NONE** — nothing executed past preflight |
| Success tx/result | **NONE** |
| Failure/revert results | **NONE** |
| One transaction: YES/NO | **UNKNOWN** — cannot be determined without a real quote + fork |
| One user confirmation: YES/NO | **UNKNOWN** for the LI.FI leg specifically. Known from 19.X-A: BagRouterSpike itself requires a separate `approve()` before `executeComposed()` (2 signatures, not 1) unless Permit2/EIP-2612 is layered on — not yet done for either phase. |
| Atomic rollback: YES/NO | **UNKNOWN for the LI.FI leg** — PROVEN YES for two BAG-controlled legs (19.X-A, real Hardhat test run, 11/11 passing). `BagRouterSpike`'s revert-propagation logic makes no distinction between leg types, so this SHOULD carry over, but "should" is not "proven" — the whole point of 19.X-B is confirming a real external aggregator's calldata doesn't have some assumption (e.g. `msg.sender` must equal the quote's `fromAddress`) that breaks this. |
| LI.FI composability: YES/NO | **NOT DETERMINED — NOT "FAILED"**. The task says to mark `LI.FI_COMPOSABILITY_FAILED` specifically if LI.FI requires `msg.sender` to be the user or its calldata can't be safely composed through a router — neither was tested, so marking either PASS or FAILED would be fabricating a result. Status is **BLOCKED / INCONCLUSIVE**. |
| Final recommendation | **Cannot responsibly choose A/B/C yet** — see below. |

## Final recommendation

**Do not select A, B, or C.** Selecting an authorization model now would be
guessing dressed up as a recommendation. What IS a defensible statement
from the evidence actually gathered (19.X-A, real, and this session's
confirmed infra limits):

- Plain `approve()` + separate execute call (Option A) is the ONLY
  authorization model actually proven working end-to-end so far (19.X-A,
  11/11 real tests) — but it is 2 signatures, and the task requires 1.
- Getting to 1 signature needs either Permit2 (Robinhood Chain has a
  canonical Permit2 deployment per `docs.robinhood.com/chain/protocol-contracts`,
  independently verified in the prior production-hardening pass — this
  makes Option B plausible) or confirming the real token(s) in the actual
  swap pair support EIP-2612 `permit()` (unconfirmed either way).
- Whether LI.FI's specific calldata for a Robinhood Chain route is even
  composable through a third-party router at all (the actual subject of
  this whole spike) remains completely untested. A recommendation between
  A/B/C is moot until that question has an answer.

**STOPPING here, as instructed.** No further phases, no PurchasePlanner,
no CapabilityMatrix, no production BagRouter work follows from this spike.
