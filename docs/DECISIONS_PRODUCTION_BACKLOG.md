# Production backlog — technical decision records

> **Status: NOT IMPLEMENTED** — design / decision only. Current state: [docs/STATUS.md](STATUS.md).

Status of all three: **decided, not implemented in this phase.** None is a
demo blocker. Each records what would be built, what must not be built, and
what would trigger revisiting it.

---

## ADR-1 — Second aggregator (1inch / 0x)

**Context.** Execution goes through the `BagExecutionProvider` seam
(`lib/execution/`). The registry order is BAG Router → LI.FI Composer → LI.FI
sequential. Every LI.FI outage or unsupported pair is currently a hard
failure for any route BAG Router cannot serve.

**Decision.** Do not add one now. When it is added, it is a new
`BagExecutionProvider` (for example `ZeroXProvider`) registered in
`buildDefaultProviders()`, not a change to the compiler, bridge or accounting:

- `supports()` must be chain-bound: the same canonical `getEvmChainIdFor`
  mapping `BagRouterProvider` uses. It must never throw.
- `expectedOutputs` must fill the explicit semantics from
  `lib/execution/types.ts`:
  - `quotedOutputRaw` = the aggregator's `buyAmount` (`PROVIDER_QUOTE`)
  - `minimumGuaranteedOutputRaw` = the enforced `minBuyAmount`, or `null`
    when the provider cannot guarantee a floor
  - This keeps ranking honest.
- `compileQuote()` must stay side-effect-free: no allowance, no signature.
- If BAG Router executes a leg, the router's `allowedTarget` must allowlist
  the aggregator's settlement contract by owner action. The router's
  allowlist is the trust boundary. A provider must never bypass it.

**Why not now.** On Robinhood Chain (4663) neither 1inch nor 0x support is
verified from here (no network access). The demo path (BAG Router +
Uniswap v3 on Robinhood) does not depend on a second aggregator.

**Revisit when** LI.FI availability on 4663 is measured as insufficient, or a
target chain lacks LI.FI coverage.

---

## ADR-2 — Rescue mechanism for `BagExecutionRouter`

**Context.** `BagExecutionRouter` deliberately has no `withdraw` or `sweep`.
Its NatSpec trust boundary #2 says `owner` must never have a path to move
assets out of the contract. The router is designed to hold nothing between
transactions:

- outputs are measured as balance deltas and paid to `msg.sender`
- leftover input and native value are returned in the same `execute()` call

**The two things "rescue" can mean are not the same:**

| | Accidental-token recovery | Arbitrary owner withdrawal |
|---|---|---|
| What | Tokens someone sent to the router outside `execute()` (a mistaken transfer) | The owner moving any balance, any time |
| Whose funds | Nobody's claim inside the protocol; the sender's mistake | Could include funds in flight in a user's execution |
| Risk added | Small, if strictly scoped | Turns the owner key into a custody key: a compromised or malicious owner can steal |
| Verdict | Acceptable in principle, only under the constraints below | **Rejected.** Breaks trust boundary #2. |

**Decision.** Implement nothing now. **Never** add an unrestricted
`sweep(token, to, amount)` to the router. If accidental-token recovery is
ever added, it must satisfy all of these:

1. **Not during an active plan.** The function must be `nonReentrant`,
   sharing the guard with `execute()`, so it can never run inside an
   execution's call frame, where balances belong to the executing user.
2. **Timelocked and multisig-owned.** Queue with a public event, then execute
   after at least 48h. This gives observers time to see a malicious queue.
   The router `owner` is expected to be a multisig already.
3. **Recipient allowlist.** Only a pre-registered recovery address, never an
   arbitrary `to` chosen at call time.
4. **Nothing the protocol relies on.** It cannot sweep native value
   mid-transaction, since it cannot run inside `execute()` anyway.
5. **Events for everything**, so recovery is auditable on-chain.

**Finding recorded alongside this decision.** `execute()` returns leftover
input using the router's **absolute** input-token balance:

```solidity
uint256 leftoverInput = IERC20(plan.inputToken).balanceOf(address(this));
```

It does not use a before/after delta. So a token mistakenly sent to the
router that is also some plan's `inputToken` is paid out to the next user
who executes with that input token. Any other token is stuck forever. This
is not an owner-theft vector, since the router cannot be drained by its
owner, but it means accidental funds go to a stranger.

The minimal fix, if the contract is ever redeployed, is to snapshot the
input-token balance before pulling input and return only the delta. That is
the same pattern the contract already uses for outputs. It is not changed
here: this phase is design only, and the router is already covered by 29
contract tests that a redeploy would re-run.

**Revisit when** a real accidental transfer happens, or before the next
router redeploy. Apply the delta fix first; add recovery only with
constraints 1–5.

---

## ADR-3 — Full on-chain reward settlement

**Context.** Creator rewards (fork royalty, performance fee) are recorded
atomically in the `creator_reward_settlements` ledger by the accounting
RPCs (migrations 0017/0018; 0033 and 0034 re-assert them). An off-chain
worker (`lib/server/creator-rewards-settlement.ts`) settles EARNED rows to
`CreatorRewardsVault.settleReward` on Robinhood Chain. Router-settled
redemptions already pay the performance fee on-chain in the same
transaction (`RedeemFeeRouter`, attestation-bound).

**Decision.** Keep the hybrid model for now. Do not move reward computation
on-chain in this phase.

**Why.**

- **The computation needs off-chain state.** Rewards depend on NAV, cost
  basis and profit, computed from off-chain holdings and prices (see
  `docs/PROTOCOL_ECONOMICS.md`). Computing them on-chain would require an
  on-chain NAV oracle and per-position cost basis. That is a new trust
  surface and far more code than the problem needs today.
- **The money itself is already on-chain and non-custodial where it
  matters.**
  - `CreatorRewardsVault` holds creator balances.
  - `owner` cannot sweep the reward token (`CannotSweepRewardToken`).
  - `settleReward` is idempotent per `refId`.
  - Creators withdraw themselves.
- **The router path shows the incremental route.** It pays the fee on-chain
  atomically with the redemption, authorized by a server attestation the
  contract verifies. Extending that pattern, rather than a full on-chain
  accounting rewrite, is the next step if needed.

**What "full on-chain" would require (for later):**

- an on-chain NAV / price source (for Robinhood: the Uniswap v3 TWAP from
  `docs/ROBINHOOD_PRICE_AUTHORITY.md` could be read on-chain)
- per-position cost basis on-chain
- a migration of the settlement ledger with a reconciliation proof that
  every EARNED row is settled exactly once

**Revisit when** the settlement worker's trust (its settler key) is judged
too large for the reward volume, or regulators or partners require on-chain
computation.
