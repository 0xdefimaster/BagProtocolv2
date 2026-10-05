# LI.FI Composer → BAG fee settlement: feasibility study

Status: **STUDY**. No code or contract changes. 2026-10-05.

## 0. Question and answer

> Can Composer deliver the LI.FI swap output, in the same atomic transaction, to
> a BAG settlement/fee contract that measures the actual USDG amount and splits
> it between the user and the creator?

**Answer: POSSIBLE-BUT-UNVERIFIED (outcome B).** Composer's published SDK and
spec describe every building block this needs:

- several swaps into USDG, merged into one amount;
- `core.call` to an arbitrary contract that spends that amount, with the
  runtime amount injected into the calldata;
- an inline approval to that contract;
- one atomic transaction.

A BAG-shaped flow built offline passes the published `FlowSchema` (§3).

What has not been verified:

- that Composer's backend compiles and simulates this flow on Robinhood Chain
  (4663) against a contract that is not in its catalog;
- the exact semantics of the inline approval;
- whether the execution proxy is the same address for every flow of a user.

None of these is a documented "no", and each can be settled cheaply. The next
step is the isolated PoC in §6, not production.

Why this matters: the live fee-path checker showed that the fee router, which
swaps on Uniswap v3 directly, cannot sell the live Bag. AMKR and HII have no
Uniswap v3 quote at any tier (`docs/STATUS.md` §1a). The same Bag was bought,
and 50% of it sold, through Composer, live. The problem is the execution venue,
not the fee economics.

## 1. Sources and evidence levels

| Id | Source | What it is |
|---|---|---|
| S1 | `@lifi/composer-sdk@0.5.0` installed in this repo: `dist/generated/operations.generated.d.ts`, `dist/generated/config.generated.d.ts`, `dist/authoring/*.d.ts`, `README.md` | LI.FI's published SDK type definitions and README, the version BAG runs |
| S2 | `@lifi/compose-spec@0.5.0` (installed) and `@0.6.0` (npm, 2026-10-05): `dist/index.d.ts` | LI.FI's wire-format spec: `ComposeRun`, `SweepTo`, `ProducedResource`, `ComposeCompileResult`, `ContextKey` |
| S3 | `@lifi/composer-sdk` `src/examples/` (installed 0.5.0): `callContract.ts`, `approveAndDeposit.ts`, `swapAndZap.ts`, `swapToRecipient.ts`, `transferTokens.ts` | LI.FI's own worked examples |
| S4 | `@lifi/composer-sdk@0.7.0` README (npm, 2026-10-05) | Latest README: `getChains`, `route`, proxy settlement rules |
| S5 | BAG live use on Robinhood Chain (`docs/STATUS.md` §1): purchase and 50% redeem, each one Composer transaction | Live, our own transactions |
| S6 | BAG code: `lib/blockchain/lifi-composer-adapter.ts`, `lib/server/redeem-composer.ts`, `contracts/RedeemFeeRouter.sol`, `contracts/CreatorRewardsVault.sol` | The current integration and contracts |
| S7 | Offline mock (§3): the BAG flow built with S1's `build()` and decoded with S2's `FlowSchema`. No network, no key. | Local analysis |
| S8 | li.fi knowledge hub: "LI.FI Is Live on Robinhood Chain from Day One"; "Introducing LI.FI Composer"; the Royco and Jumper Composer case studies; Terms and Conditions | LI.FI marketing and legal pages. **Not read directly**: li.fi, docs.li.fi and composer.li.quest are blocked from this sandbox, so only search-result excerpts were available. Claims resting only on S8 are marked so. |

Not done:

- No call to the Composer API (it needs `LIFI_API_KEY`, and it is blocked from
  this sandbox).
- No transaction.
- No deployment.
- The router is not deployed.

## 2. The nine items

| # | Item | Status | Source |
|---|---|---|---|
| 1 | Swap output to a contract recipient | **SUPPORTED** | S1/S2: `sweepTo` takes a literal address or `context.sender` (`context.executionAddress` is rejected). S3 `swapToRecipient.ts` swaps, merges and sweeps to an address input. S3 `transferTokens.ts`: `core.transfer` sends a resource to any `recipient`, fully or partly (`transferred` / `remainder` ports). |
| 2 | Swap output into the next contract call | **SUPPORTED** (docs); BAG flow on 4663 unverified | S1: `core.call` "Invoke a smart contract function, optionally spending a token resource", wire format `core.call` with `bind: { input: <resourceRef> }`. S3 `swapAndZap.ts`: "The swap's amountOut feeds directly into the zap's amountIn". S3 `approveAndDeposit.ts`: a resource consumed by `core.call` into an ERC-4626 vault. S4: "Every intermediate step settles inside the proxy in the same transaction." |
| 3 | Dynamic calldata injection | **SUPPORTED** (docs); BAG flow on 4663 unverified | S1 `CoreCallConfig.args`: positional values or `{ $ref }`. `SignatureBind` turns named signature parameters into refs to flow inputs or node outputs, resolved at execution time. S3 `callContract.ts` binds the consumed resource itself as the `shares` argument. The SDK also has `materialisers.call` ("measures a balance delta after an arbitrary contract call"), `core.staticCall` (read at execution time) and `core.balanceOf`. Allowed argument types (S2 `SolTypeSchema`): uint8–uint256, int128/int256, address, bool, bytes, bytes4, bytes32, string. So a `bytes` attestation signature fits. Return value: only `uint256` or none (S1 `CoreCallResult`). |
| 4 | Arbitrary or permissioned contract interaction | **POSSIBLE-BUT-UNVERIFIED** | S1/S4: "Call an arbitrary contract … without a dedicated typed op". `core.rawCall` takes pre-encoded calldata. Neither the SDK nor the spec contains a target allowlist (searched S1/S2/S4 for allowlist, whitelist and permission: none). But the backend simulates every flow before returning calldata (`simulationPolicy: 'strict'` by default) and can refuse with `validation_error`, `resolution_rejected`, `verification_error` and others (S2 `ComposeErrorKind`). Whether it accepts a target outside its catalog on 4663 is a server-side policy only a compile call shows. |
| 5 | Actual output measured in the settlement contract | **SUPPORTED** — by our contract, given 2 and 3 | The contract measures its own balance delta: it pulls `amount` from `msg.sender` and reads `balanceOf(this)` before and after. That is the pattern `RedeemFeeRouter` (`swapOutput`) and `CreatorRewardsVault.settleReward` (`received != amount` → revert) already use (S6). Composer only has to deliver the tokens and the runtime amount, which is items 2 and 3. The amount Composer passes is a hint; the delta is authoritative. |
| 6 | User/creator split in the same transaction | **SUPPORTED** — by our contract, given 2 | Inside the one `core.call`: fee to `CreatorRewardsVault.settleReward(creator, fee, redemptionId)`, the rest to the user. Same code path as today's router (S6). The call is one step of the one Composer transaction, so the split is atomic with the swaps. The vault must grant the new contract its settler role. |
| 7 | Partial execution semantics | **SUPPORTED**: all-or-nothing, with three caveats | S1/S2 and the docs excerpt: "compile it into EVM calldata that executes atomically on-chain". It is one EVM transaction, so any revert (a guard, the swap's own `amountOutMin`, our contract) reverts everything. Caveats: (a) `status: 'partial'` is a **compile-time simulation** result, returned only with `simulationPolicy: 'allow-revert'` (S1 README) — not a partially executed transaction. (b) Async routes (`availability: 'future'`) are off unless `allowAsyncRoutes: true` (S2, S4); by default every produced resource is `availability: 'now'`. BAG must keep it off and reject any `future` resource. (c) A `lifi.swap` may leave **unspent input** (`unspentIn` port), which is swept to `sweepTo`. The transaction still succeeds with less than the full amount sold (S1, S4: "the swap can leave unspent input in the proxy"). BAG's accounting must record the input actually sold, not the input requested. Today's Composer redeem verification already requires that "each sold token left the wallet in full" (S6), which would fail closed. |
| 8 | Approval/allowance semantics | **SUPPORTED** for the mechanism; amount and revocation **UNVERIFIED** | User → proxy: compile returns the ERC-20 approvals the signer must send first (`approvals`, `checkOnChainAllowances`). BAG already uses this live and refuses any approval for another token or above the amount sold (S5, S6). Proxy → settlement contract: `CoreCallConfig.approvals: [{ spender }]` grants the call target an allowance inline (S1; S3 `callContract.ts` "grants the vault allowance inline"). Neither doc says whether that allowance is exactly the resource amount, or whether it is reset afterwards. So the contract must pull exactly `amount` and never rely on a leftover allowance. The proxy is the user's Composer execution address (`userProxy`, `context.executionAddress`). Whether it is fixed per user (deterministic) is not documented. BAG still bars unlimited approvals until that is proven on-chain (`docs/STATUS.md` §3). |
| 9 | This flow on Robinhood Chain | **POSSIBLE-BUT-UNVERIFIED** (swaps alone: **SUPPORTED**) | Swaps plus sweep on 4663: **live** — the BAG purchase and the 50% redeem, each one Composer transaction (S5). LI.FI announced Composer on Robinhood Chain at launch (S8, search excerpt only). `core.call` / `core.merge` to a BAG contract on 4663 has not been compiled. S4: "A chain is listed once the VM contract is confirmed deployed on it", and `core.*` ops run in that VM, so nothing documented excludes them. But only `getChains()` plus a compile against 4663 proves it. |

## 3. Offline mock (S7)

Built with `@lifi/composer-sdk@0.5.0` `build()`, offline, then decoded with
`@lifi/compose-spec`'s `FlowSchema`. Result: **decode OK**.

Shape, with placeholder token and contract addresses on chain 4663:

```
inputs: in_0 (erc20 INDA), in_1 (erc20 SOXX),
        redemptionId bytes32, user address, creator address,
        feeAmount uint256, minUserProceeds uint256, deadline uint256, signature bytes
sweep_0     lifi.swap   amountIn ← input.in_0  → USDG   guard slippage(unspentIn, 100 bps)
sweep_1     lifi.swap   amountIn ← input.in_1  → USDG   guard slippage(unspentIn, 100 bps)
merge_usdg  core.merge  a ← sweep_0.amountOut, b ← sweep_1.amountOut
settle      core.call   bind.input ← merge_usdg.merged
            target = <settlement contract>, approvals = [{ spender: <settlement contract> }]
            args = [input.redemptionId, input.user, input.creator, merge_usdg.merged,
                    input.feeAmount, input.minUserProceeds, input.deadline, input.signature]
sweepTo = context.sender   (unspent input and anything left → the user)
```

What this proves: the published schema accepts the structure, including the
same resource used both as the spent input and as an argument (the pattern of
S3 `callContract.ts`).

What it does not prove:

- that the backend compiles it (linearity, resolution and the simulation all
  run server-side);
- what calldata comes out.

So no calldata was produced or analysed. The flow can be rebuilt for a real
compile in step P1 (§6).

## 4. What changes compared with `RedeemFeeRouter`

| Concern | `RedeemFeeRouter` today | Composer + settlement contract |
|---|---|---|
| Swap venue | Allowlisted targets: Uniswap v3 SwapRouter02 on 4663 | LI.FI aggregator through Composer: the venue that bought and sold the live Bag |
| Who calls the contract | The user (EOA) | The user's Composer proxy. `msg.sender` is not the user. |
| Where proceeds go | `msg.sender` | An attested `user` address. Never `msg.sender`, which is the proxy. |
| Swap calldata bound in the attestation (`legsHash`) | Yes | Not possible: Composer compiles the swaps after BAG signs, so the contract sees only USDG arriving. Safety comes from the on-chain floor (`minUserProceeds`, below) plus Composer's per-swap `amountOutMin` and slippage guards. The contract never calls a swap target and needs no swap-target or input-token allowlist. |
| Price quality (#16) | Best Uniswap tier within `FEE_REDEEM_MAX_PRICE_DEVIATION_BPS` of BAG's verified price, otherwise no attestation | **Kept.** The same rule (`redeem-quote-quality.ts`) applied to Composer's quoted per-leg output (`producedResources[*].simulated`): more than 5% below the verified value → no attestation. `minUserProceeds` is derived from that checked quote and enforced on-chain. |
| Fee | B0: attested `feeAmount` from the guaranteed minimum | B0 unchanged (attested `feeAmount`), or B: computed on-chain from the measured amount and the attested basis, carry and rate (§5) |
| Lock (write-then-check) and the attestation deadline clamped to intent expiry | Yes | Unchanged: off-chain and before the attestation |

Order of operations: the attestation is a compile input, and the quote comes
from a compile. So the backend has to:

1. Compile the swap-only flow and take each leg's simulated output.
2. Apply the price-quality rule and compute the fee and minimum.
3. Sign.
4. Compile the final flow with the `settle` node.

Step 4 re-quotes. If the price moves against the user, the contract reverts on
`minUserProceeds`. A better price helps the user. Verification of the
submitted transaction stays as today (sender, target, calldata, value, success)
and reads the authoritative numbers from the settlement contract's event in
the receipt.

Scope note, unchanged from today: assets stay in the user's wallet (A model).
Nothing on-chain stops a user from selling elsewhere. The fee applies to sales
made through BAG, which BAG's ledger records.

## 5. Proposed minimum interface (description only, no contract code)

One new contract. Working name: **RedeemFeeSettlement**. It is separate from
`RedeemFeeRouter`, which stays as it is and is not deployed.

**State**

| Item | Type | Note |
|---|---|---|
| `quoteToken` | immutable token | USDG |
| `vault` | immutable `CreatorRewardsVault` | Must grant this contract its settler role |
| `feeAttestor` | address | Same EIP-712 attestor model as today. Rotation by the owner (multisig), as in `RedeemFeeRouter`. No upgrade, no proxy. |
| `redemptionExecuted` | mapping bytes32 → bool | Replay guard. `redemptionId` is also the vault's `refId`, so a redemption can never be fee-settled twice by any path. |

**One entry point: `settle`.** Returns `userProceeds` (uint256), because
Composer accepts only a `uint256` or void return.

| Parameter | Type | Meaning |
|---|---|---|
| `redemptionId` | bytes32 | `redeem_intents.id` |
| `user` | address | Receives the proceeds |
| `creator` | address | Receives the fee through the vault |
| `amount` | uint256 | Runtime USDG amount injected by Composer (`merge.merged`). A hint only; the delta is authoritative. |
| `feeAmount` | uint256 | B0 mode: the attested fee |
| `consumedBasis`, `lossCarry`, `rateBps` | uint256 | B mode (later PR): the fee is computed from the measured amount. One mode per deployment, never both. |
| `minUserProceeds` | uint256 | Attested floor for what the user gets |
| `deadline` | uint256 | Attestation expiry, no later than the intent expiry |
| `attestation` | bytes | `feeAttestor`'s EIP-712 signature over every parameter above except `amount`, plus the chain id and this contract (EIP-712 domain) |

**Checks, in order**

1. Deadline not passed.
2. `redemptionId` unused.
3. Signature recovers to `feeAttestor`.
4. Mark `redemptionId` used before any external call.
5. Pull exactly `amount` of USDG from `msg.sender`. Measure `received` by this
   contract's own balance delta.
6. Compute the fee: B0 → `feeAmount`; B → `floor(max(0, received − consumedBasis − lossCarry) × rateBps / 10000)`.
7. Require `fee ≤ received` and `received − fee ≥ minUserProceeds`.
8. If the fee is non-zero: approve the vault for exactly the fee, then
   `vault.settleReward(creator, fee, redemptionId)`.
9. Transfer `received − fee` to `user`.
10. The contract's USDG balance must end equal to where it started: no funds
    left behind.

**Event**: `Settled(redemptionId, user, creator, payer = msg.sender, received, fee, userProceeds)`.
It is the authoritative record for receipts and the ledger.

**Deliberately absent**

- no swap logic or swap targets;
- no arbitrary calls;
- no input-token allowlist (only USDG is ever handled);
- no `msg.sender == user` requirement;
- no admin function that moves funds.

**Caller binding (open)**

Not binding `msg.sender` is safe for funds. A third party could only call
`settle` with its own USDG: the user and creator get paid, and the
`redemptionId` is burned, so the user's own transaction then reverts in full
and the user keeps their tokens. That is griefing at the attacker's cost.

Binding the user's Composer proxy as well would remove even that, but it needs
the proxy to be a known, fixed address per user: item 8, unverified.
Decide after P1.

## 6. Recommended next steps (outcome B: isolated PoC, not production)

**P0 — done here.** Offline flow, schema OK.

**P1 — compile and simulate only, no funds moved.**

- On the user's machine, with `LIFI_API_KEY`:
  - `getChains()` contains 4663;
  - compile the §3 flow against a minimal **test** contract;
  - read `transactionRequest`, `approvals`, `userProxy`, and `producedResources`
    (every one `availability: 'now'`);
  - `simulateUserProgram: true`;
  - compile twice for the same signer and compare `userProxy`.
- The test contract only records its inputs and its balance delta, then pays
  the full amount back to `user`, with no fee and no vault. Deploying it costs
  gas only.
- Answers items 4, 8 (proxy determinism) and 9, plus whether the backend
  accepts `bytes` and a `$ref` amount in `args`.

**P2 — one real transaction, very small (about $1).**

- One leg of a token with no Uniswap v3 route (e.g. AMKR) → USDG → test
  contract → user.
- Check on-chain: the delta equals the event's `received`; the user receives
  everything; the contract ends at zero.
- Check the inline approval left behind (item 8).

**P3 — only after P1 and P2 pass.**

- Separate PR: the `RedeemFeeSettlement` contract (B0 mode first) and its
  Hardhat tests.
- Separate PR: the backend two-phase attestation over Composer quotes, keeping
  the #16 rule.
- Deployment is a separate decision.

**If P1 shows the backend refuses a non-catalog `core.call` target, or
`core.*` on 4663** → outcome C. The fallbacks are option (a), fee Bags limited
to tokens the checker verified, or another architecture. Do not loosen #16 in
either case.

The router stays undeployed throughout.
