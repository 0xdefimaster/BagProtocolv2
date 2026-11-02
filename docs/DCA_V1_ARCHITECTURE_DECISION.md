# DCA v1 — Architecture Decision Record

**Status:** Proposed implementation baseline  
**Decision date:** 2026-11-02  
**Scope:** Robinhood Chain, USDG-funded, single-chain BAG purchases  
**Related work:** PR #128, #129, #130, #131; SDK delivery-proof PR #143  
**Important:** This document is an architecture decision, not a deployment, audit, or production-readiness claim.

## 1. Decision in one paragraph

Ship the first fully automatic BAG DCA path as a **non-custodial, user-authorized, on-chain-bounded recurring executor** with a **fixed, typed Uniswap v3 execution adapter**. The owner signs one EIP-712 authorization and gives the executor an exact ERC-20 allowance capped at the total budget. A permissionless keeper submits a run when its signed window is due and pays gas. The executor—not the keeper—derives the amount for every asset, minimum acceptable output, recipient, BAG version and remaining budget. Every swap is made through a pinned adapter with typed parameters; arbitrary target/calldata execution is not part of the DCA path. The executor measures delivery to the recipient and emits per-asset evidence in the same transaction. The transaction is all-or-nothing.

**Composer is not in the DCA v1 critical path.** It remains a candidate provider for a later version, only after a contract-verifiable Composer adapter has a narrowly constrained program model. The presence of a delivery event alone is not sufficient to make an arbitrary VM program safe.

## 2. Product behavior

The user configures the recurring strategy once:

- BAG identity, registered version, definition hash and composition hash.
- Funding token (v1: USDG on Robinhood Chain).
- Amount per run, number of runs, schedule start, period and expiry.
- Maximum input-token price accepted for one whole unit of each output asset.
- Recipient wallet.
- Explicit, reviewed execution adapter and permitted Uniswap v3 fee tiers.

The wallet signs one EIP-712 authorization bound to the chain and the deployed executor. The user grants the executor an **exact allowance no greater than the total budget**. This is an allowance, not a deposit: funds remain in the user's wallet until each due run.

For every due window:

1. A keeper obtains fresh QuoterV2 quotes for the authorized asset pairs and permitted fee tiers.
2. It selects a viable fee tier per asset and submits the prepared run before the quote deadline.
3. The contract revalidates the signature, BAG registry state, schedule, nonce/revocation state, budget, funding and fee tiers.
4. The contract computes each leg input and minimum output from the signed allocation and price ceiling. The caller cannot supply or lower these values.
5. The fixed adapter executes the swaps and returns outputs to the executor.
6. The executor measures every output, forwards it to the signed recipient, measures the recipient's balance increase and emits delivery evidence.
7. Any failed check reverts the entire run. No partial basket is recorded as successful.

A missed window is **skipped, not accumulated**. If price, liquidity, funding, gas or keeper availability is insufficient, that window is recorded as missed; the system does not silently buy later at a different time. The UI must show runs remaining, windows remaining and budget that can no longer be spent.

## 3. Trust boundaries

| Component | May do | Must not be able to do |
|---|---|---|
| User authorization | Set the exact strategy, amount, timing, recipient, price ceilings and route policy | Be silently broadened after signing |
| Recurring executor | Enforce authorization, schedule, budget, price floors, BAG binding and delivery | Upgrade, pause arbitrarily, redirect funds or make arbitrary calls |
| Keeper | Read state, quote, choose among signed fee tiers, submit transactions and pay gas | Hold user keys, alter limits, change recipient or spend outside the authorization |
| DCA adapter | Execute one typed swap through its immutable venue | Accept arbitrary targets/selectors/calldata or choose the recipient |
| RPC / Quoter | Supply observations and quotes used to decide whether to attempt a run | Override the on-chain minimum output |
| Database | Queue, lease, index, retry and report jobs | Be the source of truth for budgets, windows, revocation or execution count |

The chain is the authority for every economic state transition. Database state is recoverable operational state.

## 4. Contract architecture

### 4.1 RecurringPurchaseExecutor

Keep the core contract small and immutable:

- EIP-712 authorization; SignatureChecker support for EOA and ERC-1271.
- Authorization id bound to chainId and executor address.
- On-chain counters per (owner, authorizationId).
- Exact per-run amount, total budget, maximum executions, start, period and expiry.
- At most one execution per window and at least one full period between executions.
- Explicit revocation that is checked before funding or external calls.
- Exact BAG identity/version/composition checks against BagFactory and StrategyRegistry when required.
- Rebuild the registered composition from the signed asset rows and compare it with Bag.compositionHash().
- Compute largest-remainder weight splits on-chain, identically to the SDK.
- Compute minimum outputs on-chain from the signed per-asset price ceilings.
- Measure source debit, adapter output, recipient delivery and residual balances.
- Revert the whole transaction on any failed leg or invariant.

The contract must not accept arbitrary route targets or opaque calldata from the keeper.

### 4.2 Funding model — v1

**Use ALLOWANCE only in v1.** Support EIP-2612 permit where the token supports it; otherwise the user approves the executor directly.

- The allowance must be bounded to the signed total budget, never unlimited.
- The contract pulls exactly one run's amount only when a run executes.
- Exact source debit and exact executor funding delta are checked.
- The contract spends no more than the signed total budget and per-run amount.
- On completion or revocation, the UI should offer an allowance-revocation action. The contract's on-chain revoked/exhausted state prevents further pulls, but the ERC-20 allowance itself may remain until the user revokes it.
- Do not include Delegation Framework funding in the first production release. The current research is useful, but a separate real-wallet and production qualification gate is required before adding it.

### 4.3 Typed execution adapter

Introduce a narrow interface equivalent to the following. The method receives typed economic parameters, not an arbitrary target and calldata:

    interface IDcaSwapAdapter {
        function swapExactIn(
            address tokenIn,
            address tokenOut,
            uint256 amountIn,
            uint256 minOut,
            address recipient,
            bytes calldata routeData
        ) external returns (uint256 measuredOut);
    }

The executor passes only the exact leg input, contract-derived minimum, fixed recipient (the executor itself) and typed route data.

**V1 adapter: UniswapV3ExactInAdapter**

- Immutable SwapRouter02 and Uniswap v3 factory addresses, pinned per chain.
- Supports exact-input, single-hop swaps only.
- routeData decodes only a uint24 fee selected from the owner's signed allowed-fee set.
- Confirms the canonical pool exists.
- Sets an exact allowance for one leg, performs the swap to the executor, and resets allowance to zero.
- Measures the output balance delta; the router's return value alone is not delivery evidence.
- No callback implementation, delegatecall, arbitrary target or arbitrary selector.
- No adapter-held balances after a successful call.

Each additional venue requires a separate typed adapter, its own code-hash pin, adversarial tests and a new reviewed executor deployment or explicitly versioned adapter registry.

### 4.4 Why not reuse BagExecutionRouter as the DCA execution primitive?

PR #130 narrows the generic router plan before calling it: exact input/output assets, fixed recipient, exact leg inputs, allowed fee tiers and a minimum output derived from the owner authorization. That is a meaningful safety layer.

However, BagExecutionRouter still has a privileged planSigner, mutable target allowlists and a generic target/calldata execution surface. It is also not the current deployed production path. Keeping it in DCA introduces an additional signer, contract and operational dependency without adding a capability needed by the v1 DCA use case.

A typed adapter removes that dependency. The keeper can choose only a permitted fee tier; it cannot submit a new target, selector, recipient, amount or minimum.

## 5. Price policy and precision

A signed per-asset price ceiling is a **maximum price the user agrees to pay**, not an independent fair-value oracle and not ordinary slippage protection.

For asset i:

    legInput[i] = largest-remainder split of grossAmountPerRun
    minOut[i]   = ceil(legInput[i] * 10^assetDecimals / maxPriceRaw[i])

The exact integer implementation must be identical in Solidity and TypeScript.

Required safeguards:

- Bound supported token decimals explicitly (recommended v1: 0–36) and use full-precision multiplication/division or prove the maximum intermediate product cannot overflow.
- Reject zero, sentinel/unbounded and malformed price ceilings.
- Test rounding at tiny amounts, uneven weights, high decimals and near-uint256 boundaries.
- Display the current quote, user maximum, minimum output, total authorized budget and the possibility that a window is skipped.
- A route that cannot meet every asset's minimum is rejected atomically.

The Quoter is a planning input, not a trust authority. On-chain minOut checks are the final economic boundary.

## 6. Delivery evidence and SDK verification

Add one event per asset, emitted by the executor after the recipient transfer:

    event AssetDelivered(
        address indexed owner,
        bytes32 indexed authorizationId,
        uint256 indexed executionIndex,
        address recipient,
        address token,
        uint256 balanceBefore,
        uint256 balanceAfter,
        uint256 minReceived
    );

The executor requires balanceAfter >= balanceBefore and balanceAfter - balanceBefore >= minReceived before emitting. Keep the run-level PurchaseExecuted event, expanded if necessary to bind the execution index, window, gross amount, exact source debit and authorization id.

The SDK's verifyRecurringPurchase should add a receipt-log verification mode that:

- Binds the receipt transaction to the exact executor address, chain, authorization id and expected execution.
- Requires exactly one run-level event for the authorization in the transaction.
- Requires exactly one AssetDelivered event for each authorized output asset and no duplicates or unexpected assets.
- Checks owner, recipient, token, execution index and minimum for every event.
- Recomputes balanceAfter - balanceBefore and requires it to meet the signed minimum.
- Treats missing, malformed, ambiguous or mismatched evidence as INDETERMINATE or FAILED, never success.
- Accepts logs only from the independently pinned executor address and reviewed runtime code hash.

The event is evidence produced by the executor's own on-chain balance checks; it is not a substitute for reviewing the executor bytecode and the token contracts. Keep transaction-scoped balance-delta verification as an independent cross-check where a qualified reader exists.

This design reuses the useful principle from SDK 0.4.0 PR #143—measure, enforce and log in one transaction—without requiring the scheduled DCA to execute a general Composer VM program.

## 7. Composer decision

Do not put Composer in the DCA v1 critical path.

SDK 0.4.0's deliveryProof is a valuable standalone-purchase capability: Composer reads balances, transfers outputs, checks deltas and emits BagDelivered. It does not, by itself, constrain every instruction in a recurring VM program to the DCA authorization.

A future Composer DCA adapter must prove all of the following before admission:

- The Composer account/executor identity is independently pinned and cannot be substituted by a compile response.
- The program can only spend the authorized input amount and approved tokens.
- Every output is routed to the signed recipient.
- The program cannot introduce an unreviewed target, spender, selector or side path.
- The contract can enforce the user-signed minimums and total budget atomically, or the adapter has an equivalent audited enforcement boundary.
- Delivery logs are emitted by the expected executor and independently bound to the authorization and run.
- Failure, partial execution, expiry and retry behavior are atomic and unambiguous.

Until that contract-level boundary exists, Composer remains appropriate for user-authorized one-shot purchases, not the unattended DCA executor.

## 8. Keeper and operations

The keeper is a transaction sender, not a custodian or policy authority.

- Separate keeper gas wallet from all user funds and from any other privileged service key.
- In this architecture there is no DCA planSigner key.
- The public execute function remains permissionless: any keeper may submit a valid due run. The keeper cannot change the signed policy.
- Run a long-lived Node 24 worker separately from the Next.js request lifecycle; do not rely on a serverless request staying alive.
- Use Postgres/Supabase for durable job state and worker leases. Claim due work with transactional locking (for example FOR UPDATE SKIP LOCKED); use idempotency keys per authorization/window.
- Persist the original authorization, signature, transaction hash, nonce, quote snapshot and pending intent before sending a transaction.
- On restart, reconcile pending transactions against canonical receipts and executor events before attempting another send.
- Re-read on-chain counters, revocation and balance/allowance before every run. Never trust the local schedule cache.
- Use at least two independently restartable worker instances or a hot standby. Duplicate submissions must be harmless at the contract level, though a losing keeper may waste gas.
- Alert on RPC failures, missed windows, price-limit skips, gas shortage, pending transactions, reorgs and worker inactivity.
- Never auto-retry a transaction whose inclusion state is ambiguous without first reconciling its nonce and receipt.

For the first private pilot, BAG can fund keeper gas. A protocol-funded keeper reward is a later economic feature and must be separately capped in the user's authorization.

## 9. Explicit v1 scope

Included:

- Robinhood Chain only.
- USDG input only.
- ERC-20 output assets already registered in the BAG composition.
- One Uniswap v3 exact-input single-hop swap per output asset.
- Up to 10 assets (or a lower limit established by measured gas).
- ALLOWANCE funding only.
- User-selected fixed maximum price per asset.
- Weekly or other fixed-period schedule, one run per window, no catch-up.
- Full atomic success or full revert.
- Permissionless execution caller; managed keeper service for reliable UX.
- On-chain revocation and receipt-log verification.

Excluded:

- Composer VM execution inside DCA.
- BagExecutionRouter planSigner dependency.
- Delegation Framework funding.
- Multiple chains or cross-chain baskets.
- Multi-hop, RFQ, solver and aggregator routes.
- Fee-bearing strategies and creator performance fees.
- Custody, pooled vaults or share tokens.
- DCA rewards / keeper bounty.
- Automatic price-ceiling increases or AI changes to signed policy.

## 10. Delivery gates

| Gate | Deliverable | Evidence required |
|---|---|---|
| D0 — branch hygiene | Rebase and isolate useful code from #128–#131 onto current main (which includes SDK 0.4.0 delivery proof) | Clean diff, no accidental research artifacts or secrets |
| D1 — contract + adapter | Executor calls only the pinned typed adapter; no generic planSigner path | Unit, fuzz/property and adversarial adapter tests; all economic invariants |
| D2 — evidence + SDK | Per-asset delivery events and SDK receipt verifier | Local EVM tests with dishonest event/token mocks; pinned-emitter checks; mismatch and missing-evidence cases |
| D3 — fork qualification | Real Robinhood BagFactory, Bag, StrategyRegistry, USDG, Uniswap v3 factory/router/pools | Fork tests for honest run, bad fee tier, low output, liquidity failure, reentrancy, wrong BAG/version/recipient, exhausted/revoked schedule |
| D4 — operational worker | Production Postgres store, durable leases, pending reconciliation, monitoring and recovery | Restart, duplicate workers, dropped/replaced/reverted tx, RPC outage and reorg tests |
| D5 — deployment review | Immutable deployment artifacts and per-chain address/runtime hashes | Reproducible build, bytecode match, reviewed configuration, independent security review |
| D6 — human pilot | One real owner wallet and small, capped schedule | Explicit user signature, exact allowance, three observed weekly runs, delivery verification and allowance revocation |
| D7 — private beta | Limited cohort and operational limits | Incident/runbook, support, legal review, audit scope and independent audit findings addressed |

No gate is satisfied by a design document or a local mock alone. A fork test is not a mainnet test; a test-key signing page is not a human wallet signature; a live transaction is not an audit.

## 11. Findings against the existing draft PRs

The existing work is valuable and should be reused, but it is not production-ready:

- **#130:** strong authorization, composition binding, calendar, budget, plan validation and SDK verifier foundation. Its current executor calls BagExecutionRouter and depends on a planSigner; its direct route path is not the architecture selected here. Retain authorization, BAG binding, integer math, calendar and verifier logic; replace the generic router-plan boundary with the typed adapter.
- **#131:** useful keeper state machine, write-ahead record, pending reconciliation, missed-window accounting, schedule outlook and fork evidence. It is not wired to an application route/job runner and its file store is not a production multi-instance Postgres store. Port the state machine, then implement the production store and worker lifecycle.
- **#128/#129:** research and test evidence, not production code. Preserve the test cases and threat scenarios; do not merge all research artifacts into the product path.
- **#143 / SDK 0.4.0:** merged on 2026-11-02. Its Composer delivery proof is useful for standalone purchases and informs the DCA event design, but it does not replace the DCA executor's on-chain enforcement.

## 12. Release policy

- No user funds on a new executor until the exact deployed bytecode, immutable constructor parameters, adapter address and router/factory pins are independently checked.
- No production DCA based solely on fork tests.
- No public beta before independent review and operational recovery tests.
- Keep current BAG purchase, redemption and rebalance paths unchanged while DCA is developed behind a separate feature flag and contract deployment.
- Do not mark the DCA roadmap item complete until D6 is proven and the production status page records the evidence.
