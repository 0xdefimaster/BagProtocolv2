# DCA v1 — internal security review (NOT an independent audit)

**What this is.** A security review of `contracts/dca/*` by the same agent that wrote the code, on 2026-11-03. A
self-review shares the author's blind spots; it does not replace an independent audit, and nothing here may be
described as "audited". The code is not deployed.

## Scope

| | |
|---|---|
| Contracts | `contracts/dca/BagDcaExecutor.sol`, `contracts/dca/UniswapV3ExactInAdapter.sol`, `contracts/dca/IDcaSwapAdapter.sol` (735 lines incl. comments) |
| Contract code at | `68c33f6` (last change to `contracts/dca/`); reviewed on branch head `7d42ab9` |
| Compiler | solc 0.8.24, optimizer 200 runs, EVM shanghai |
| Dependencies | OpenZeppelin 5.1.0 (`SafeERC20`, `ReentrancyGuard`, `EIP712`, `SignatureChecker`, `ShortStrings`, `Strings`, `Math`) |
| External contracts trusted | BagFactory / Bag and StrategyRegistry (this repository, deployed; code matched on a fork), Uniswap v3 SwapRouter02 + factory (pinned), the input token (owner's choice), the BAG's asset tokens (BAG creator's choice) |
| Out of scope | keeper and SDK (reviewed in their own tests), the BAG app, Uniswap, the token contracts themselves |

## Method

1. Threat model (below) and a line-by-line read of every external entry point and every external call.
2. Existing tests re-read against the threat model: 40 local executor/adapter tests (hostile tokens and venues,
   re-entrancy, signatures, calendar, registry binding, rounding), 4 contract↔SDK parity tests.
3. **New: stateful fuzz** (`contracts/test/BagDcaInvariants.test.ts`). Random sequences of executions by the keeper
   and by an attacker with right and wrong windows, deadlines, fee tiers, floors and tampered authorizations; prices
   above and below the ceilings; router misbehaviour (partial fill, lying output, ignored minimum); tokens pushed into
   the executor and adapter; time jumps; revocations. After every action: owner spend = runs × amount; runs ≤ max;
   one run per window and ≥ one period apart; only `allowedCaller` succeeds; nothing after revocation; executor and
   adapter hold only what others pushed in; no allowance left; every delivery ≥ its ceiling minimum; a reverted
   action changes nothing. Result: **25 seeds × 200 actions (5,000 actions, 424 successful runs): no violation.**
   CI runs 3 seeds; `DCA_FUZZ_SEEDS=n` runs more.
4. Fork evidence (Robinhood state, block 104733042): purchases on real pools and real BAGs, registry binding
   negatives, StrategyRegistry negatives, keeper soak (`docs/dca/DCA_V1_TYPED_ADAPTER.md` §7).

Not done: an independent audit, formal verification, and third-party static analysers (Slither, Mythril) — not run
here.

## Threat model

Attackers considered: any caller of `execute` (front-runner, searcher who can move a pool in the same transaction),
a malicious or compromised keeper, a BAG creator, a malicious token or venue reachable through the signed terms, a
sequencer that skews timestamps within its allowed range, and a third party holding the owner's old signatures.

Assets protected: the owner's input-token balance under the approval, the delivered assets, the run budget and
calendar, the correctness of `AssetDelivered` / `PurchaseExecuted` as evidence.

## Results

No Critical or High finding: no path was found that spends more than one signed run per window, spends beyond the
signed budget or count, pays anyone but the signed recipient, buys anything but the registered BAG composition,
executes a revoked or unsigned authorization, keeps funds or approvals in the executor or adapter, or lets one
authorization's state leak into another.

| ID | Severity | Finding | Status |
|---|---|---|---|
| M-1 | Medium | **Any-caller authorizations (`allowedCaller = 0`) could be executed at the worst price up to the ceilings.** Any caller chooses the moment, the fee tier (from the signed set) and passes no floor; a contract can move a pool, call `execute` and move it back in one transaction, extracting up to (ceiling − market) on every leg. | **FIXED** (2026-11-03, after an external review raised it as P1): `allowedCaller` is mandatory; zero is refused on chain and by the SDK. |
| M-2 | Medium | **The keeper is trusted within the ceilings.** With `allowedCaller` set, the keeper still chooses timing, fee tier and the floor; a malicious or compromised keeper (or its key) can do what M-1 describes. | ACCEPTED RISK (design: the ceiling is the only on-chain price bound). Mitigations available off chain: tight ceilings, keeper key custody, monitoring of delivered price vs a reference. An on-chain TWAP bound was not implemented (adds oracle risk on thin pools). |
| L-1 | Low | **Token trust.** Delivery is measured with the asset's own `balanceOf`; a malicious asset (registered by a BAG creator) can fake deliveries or block them. A malicious input token is the owner's own choice. | ACCEPTED RISK on chain; MITIGATED in the keeper (token allowlist required to send). |
| L-2 | Low | **BAG creator can halt a DCA** by recording a new version (`BagChanged` on every later run). No loss; the owner must re-sign. | ACCEPTED (fail-closed by design); the keeper records the windows as missed with the reason. |
| L-3 | Low | **Revocation does not clear the token allowance.** After `revoke`, the executor still holds an approval; it can only spend through another valid, unrevoked signature of the owner, but a future executor bug would meet a standing approval. | Documented. Recommendation: the UI revokes and sets the allowance to 0 together. |
| L-4 | Low | **A run already in flight can land before a revocation** in the same or the next block. | Inherent to any on-chain revocation. |
| L-5 | Low | **Sequencer timestamp latitude** (Arbitrum Orbit lets the sequencer set timestamps within a bounded range) can move a run across a window edge. The one-run-per-window and ≥-one-period rules still hold. | ACCEPTED; informational for schedule semantics. |
| I-1 | Info | `revokeBySig` signatures do not expire; replaying one only re-revokes (idempotent). | No action. |
| I-2 | Info | Only the executor, adapter and router are refused as recipient; other unusual recipients (e.g. the input token contract) are the owner's choice. | No action. |
| I-3 | Info | At exactly the ceiling a run can fail by one raw unit (the venue floors, the contract ceils). | Documented. |
| I-4 | Info | Composition binding uses lowercase addresses; a BAG recorded with mixed-case addresses fails closed (cannot be bought). Real BAGs on the fork matched. | Documented. |
| I-5 | Info | `decimals()` returning malformed data reverts `execute` (try/catch does not catch decoding errors): fail-closed. | No action. |
| I-6 | Info | No pause or upgrade: an executor bug needs a new deployment, new signatures, and owners revoking approvals. | Recommendation: an incident runbook (announce, keeper stop, approval revocation guidance) before deployment. |
| I-7 | Info | EIP-712 hashing is hand-written; equality with viem's `hashTypedData` is enforced by random-case parity tests and the SDK verifier. | No action. |

### Second review (external AI-assisted static review, 2026-11-03) — DCA items

| Item | Assessment | Status |
|---|---|---|
| `allowedCaller = ANY` weakens price protection (P1) | Agreed (same as M-1). | **FIXED**: mandatory `allowedCaller`. |
| No independent audit / live-network keeper validation (P1, release blocker) | Agreed. | **OPEN**: audit; Robinhood finality lag and sequencer behaviour of replacements are measured only on a live network, which needs a separate decision. |
| `reorgDepth` 64 / `minConfirmations` 1 defaults | Partly: finality already uses the RPC's `finalized` tag when served; depth is a floor. | **MITIGATED**: sending refuses an RPC without the tag; both values are explicit settings. |
| Signing screen not built | Agreed. | **OPEN** (product work; `summarizeDcaAuthorization` gives the fields to show). |
| Token trust depends on the keeper allowlist (P2) | Agreed (L-1). | ACCEPTED on chain; keeper allowlist required to send; tokens shown before signing. |
| SDK code-hash check optional (P2) | Agreed. | **FIXED**: VERIFIED requires `expectedExecutorCodeHash` (or an explicit test-only opt-out). |
| Real-BAG fork test counted any non-registry error as "registry passed" | Agreed (test false-positive risk). | **FIXED**: registry passage proven positively (`BadRunParams(1)` probe); swap-leg failures limited to an explicit list. |

### Adapter notes

`swapExactIn` is callable by anyone with their own tokens and has no standing state. It never spends tokens others
pushed into it (balance before = after), resets the router approval to 0, requires the pool to exist in the pinned
factory, refuses partial fills (`InputNotFullySpent`), and requires the router's reported output to equal the
recipient's measured delta (fee-on-transfer or lying routers fail). Re-entry into the adapter or the executor
during a swap reverts (`ReentrancyGuard`). No delegatecall, no arbitrary call, no owner.

## Conclusion

Within this review's limits the contracts enforce what the owner signs. The open risks are design-level and
documented (M-2, L-1–L-5; M-1 fixed). Before deployment: an independent audit, an incident runbook (I-6), and the
deployment conditions in `docs/dca/DCA_V1_TYPED_ADAPTER.md` §8.
