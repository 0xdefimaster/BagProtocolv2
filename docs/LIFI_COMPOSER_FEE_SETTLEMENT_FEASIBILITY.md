# LI.FI Composer → BAG fee settlement: feasibility study

Status: **STUDY + P1 RESULTS**. 2026-10-05.

> **P1 result (§7):** on Robinhood Chain, in real transactions, a LI.FI swap of
> AMKR (a token with no Uniswap v3 route) into USDG delivered its actual output
> to a BAG-deployed contract, which measured it in the same transaction. A
> two-leg sale (AMKR + SPY → two swaps → merge) did the same, and a
> reconciliation of every token transfer showed nothing left on the proxy. This
> worked both by push (`core.transfer`, then a call) and by pull (`core.call`
> with an inline approval). `msg.sender` at the contract was the user's own
> Composer proxy. The study's question is answered **yes for delivery and
> measurement**. The user/creator split is BAG contract logic that has not run
> in these transactions; it is the B contract's job (§5) and needs its own
> tests. Nothing below §6 was changed by these results except where §7 says so.
Updated after review: who `msg.sender` is at the settlement contract, and how
the tokens get there, are **not assumed** anywhere below. They are the first
thing P1 measures (§6).

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
| 5 | Actual output measured in the settlement contract | **SUPPORTED** — by our contract, given 2 and 3 | The contract measures its own balance delta (`balanceOf(this)` before and after the tokens arrive), whether they are pulled from the caller or pushed before the call. Which of the two Composer does is measured in P1. That is the pattern `RedeemFeeRouter` (`swapOutput`) and `CreatorRewardsVault.settleReward` (`received != amount` → revert) already use (S6). Composer only has to deliver the tokens and the runtime amount, which is items 2 and 3. The amount Composer passes is a hint; the delta is authoritative. |
| 6 | User/creator split in the same transaction | **SUPPORTED** — by our contract, given 2 | Inside the one `core.call`: fee to `CreatorRewardsVault.settleReward(creator, fee, redemptionId)`, the rest to the user. Same code path as today's router (S6). The call is one step of the one Composer transaction, so the split is atomic with the swaps. The vault must grant the new contract its settler role. |
| 7 | Partial execution semantics | **SUPPORTED per docs**: the documented model is one atomic transaction ("no partial failures"). Not yet observed on 4663 for this flow (P1 R / P2). Three caveats | S1/S2 and the docs excerpt: "compile it into EVM calldata that executes atomically on-chain". It is one EVM transaction, so any revert (a guard, the swap's own `amountOutMin`, our contract) reverts everything. Caveats: (a) `status: 'partial'` is a **compile-time simulation** result, returned only with `simulationPolicy: 'allow-revert'` (S1 README) — not a partially executed transaction. (b) Async routes (`availability: 'future'`) are off unless `allowAsyncRoutes: true` (S2, S4); by default every produced resource is `availability: 'now'`. BAG must keep it off and reject any `future` resource. (c) A `lifi.swap` may leave **unspent input** (`unspentIn` port), which is swept to `sweepTo`. The transaction still succeeds with less than the full amount sold (S1, S4: "the swap can leave unspent input in the proxy"). BAG's accounting must record the input actually sold, not the input requested. Today's Composer redeem verification already requires that "each sold token left the wallet in full" (S6), which would fail closed. |
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
| Who calls the contract | The user (EOA) | **Unknown until P1.** Expected: the user's Composer execution proxy (`context.executionAddress`), but it could be another LI.FI executor or router. `settle` must not be designed around `msg.sender` before P1 shows who it is. |
| Where proceeds go | `msg.sender` | An attested `user` address, never `msg.sender`, because `msg.sender` is not the user in any Composer model. |
| How the USDG arrives | `transferFrom` from the user | **Unknown until P1.** Model 1 (push): Composer transfers the USDG to the contract before calling it. Model 2 (pull): Composer approves the contract and the contract pulls. The approval and security reasoning differs between the two, so the interface in §5 is fixed only after P1. |
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
`minUserProceeds`. A better price helps the user. What the signature has to bind is the economic boundary, not the route:

- the redemption and its Bag/strategy version;
- the user;
- the creator;
- the output token;
- the minimum guaranteed proceeds;
- the deadline;
- the fee semantics (B0: the amount; B: basis, carry and rate).

The route's calldata does not need to be signed, because the contract's floor
is set on the actual output. Verification of the submitted transaction stays as today (sender, target, calldata, value, success)
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
5. Take delivery of the USDG and measure `received` by this contract's own
   balance delta. Model 2 (pull): pull exactly `amount` from the caller.
   Model 1 (push): count what arrived before the call. Which one applies is
   decided by P1; the contract must never rely on a leftover allowance either
   way.
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

**P1 — the probe (built: `contracts/spike/ComposerSettlementProbe.sol`,
`scripts/spike/composer-settlement-probe.ts`, `scripts/spike/deploy-composer-probe.ts`).**

The probe contract takes no fee and holds nothing. For each call it records
`msg.sender`, `tx.origin`, the calldata amount, its allowance, how much
arrived (pushed before the call or pulled) and the allowance left afterwards.
Then it forwards everything to the recipient.

| # | P1 question | How it is answered |
|---|---|---|
| 1 | Does `core.call` build on Robinhood Chain? | `getChains()` lists 4663; flows T/P/S compile with `simulationPolicy: 'strict'` and `simulateUserProgram` |
| 2 | Does LI.FI allow this target? | Same compiles: a non-catalog contract either compiles or is refused with an error kind |
| 3 | Can the dynamic amount be bound to the next call? | Flow S: the swap's runtime `amountOut` is the probe's `amount` argument; the event's `amountArg` shows the value that arrived |
| 4 | Does the actual token reach the contract? | Event `received`; the probe ends with zero balance |
| 5 | Can the balance delta be measured in the same tx? | Event `pulled` / `pushedBeforeCall` against `amountArg` |
| 6 | Who is `msg.sender`, and who is the final recipient? | Event `msgSender` and `txOrigin`, compared with `userProxy` and the signer; `recipient` shows what `context.sender` resolves to |
| 7 | Which spender gets the approval? | The compile's `approvals` (user → spender); the inline approval left on `msgSender → probe` after the call |
| 8 | Is the whole flow atomic? | Flow R (minimum set above the input) must fail simulation; a reverted send must leave every token in the wallet. A pass is recorded as "this flow was tested atomically on Robinhood Chain", not as a general guarantee for every Composer operation (async routes, for one, behave differently) |

Flows: T (USDG → `core.call`, pull), P (USDG → `core.transfer` to the probe,
then a call without a resource: push), S (token → `lifi.swap` → USDG →
`core.call`), R (T with an impossible minimum), and T2 (T again: is `userProxy`
the same address?).

**P1a — compile and simulate only, no funds moved.** Run on the operator's
machine, which needs `LIFI_API_KEY` and network access:

```
npx hardhat compile
npx tsx scripts/spike/deploy-composer-probe.ts                  # gas only; needs PROBE_PRIVATE_KEY + PROBE_CONFIRM
npx tsx scripts/spike/composer-settlement-probe.ts --signer 0xWALLET --probe 0xPROBE \
  --usdg-amount 1000000 [--swap-token 0xTOKEN --swap-amount <raw>]
```

The signer must hold the USDG (and the swap token, for S), because Composer
simulates the real transaction. P1a reads, for each flow:

- the compile status, or the error kind if it fails;
- `userProxy` and the transaction target;
- `approvals` (token, spender, amount);
- `producedResources` (all must be `availability: 'now'`);
- the user-program simulation.

Not covered by the probe: a `bytes` argument (the attestation). That belongs to
the B contract's own test.

**What each result proves.** T, P and S compiling shows that Composer can
*express* the flow. A real S transaction shows that a swap's actual output
reaches a BAG contract and is measured there in the same transaction. Only the
second answers the question in §0. Do not start the B contract before seeing a
real S transaction.

**Order for the real runs:**

1. T compile.
2. T real, about $1. Read `msg.sender`, the allowance and the delivery model.
   This decides Model 1 or Model 2 for §5. If T's pull fails, run P.
3. S compile.
4. S real, about $1. This is the one that matters.
5. R: compile only.

**P1b — one real transaction per step, very small (about $1), with `--send T|P|S`.**
It is sent from a disposable wallet on the operator's own machine and refused
unless the key, a confirmation phrase, an input cap and the pinned probe
address (`PROBE_ALLOWED_ADDRESS`) are all set. BAG signs
nothing. The answers to questions 4–8 come from the receipt and from chain
state afterwards.

**P2 — the same with a stock token that has no Uniswap v3 route.**

- One leg of a token with no Uniswap v3 route (e.g. AMKR) → USDG → test
  contract → user: `--swap-token <AMKR> --swap-amount <raw> --send S`.
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

## 7. P1 results (Robinhood Chain, 2026-10-05)

| Item | Value |
|---|---|
| Probe | `ComposerSettlementProbe` at `0x7beb437538bc71a95dad6624aa04bf3594525e3c` (deploy tx `0x3d7318c61aa9c5744c984f6840d8ce73b79bd7db549311ac415953e40e050984`, block 80917068) |
| Wallet | Disposable, `0xb193DE199EeB9bd1143607a11AD00999Ceb956b8`; BAG signed nothing |
| User's Composer proxy | `0xad834b4de0295622a4042a3caa62ce5b961578e7` |
| Script | `scripts/spike/composer-settlement-probe.ts` (after fixes in PRs #19 and #20) |

### 7.1 Real transactions

| Flow | What ran | Tx | Probe event |
|---|---|---|---|
| T (pull) | 1 USDG → `core.call` probe | `0x22c368f822217d8ce1f3d8afa678dcff701dee2d59497970db725588f9d8740a` | received 1000000, pulled 1000000, calldata amount 1000000 |
| SP (push) | 0.02 AMKR → `lifi.swap` → USDG → `core.transfer` to probe → call probe | `0xf58a19c6b32cbdd737cefe232c0cea7b9038e2dda361f5696f8599e65f2ace19` | received 1129736, pushed before the call; calldata amount 0, as designed. The compile had simulated 1129985: the contract saw the actual amount, not the quote. |
| S (pull) | 0.02 AMKR → `lifi.swap` → USDG → `core.call` probe | `0x089bec61bd8f1f53924be2891ccb113e3d6b0d086a574bc670740b58bdd8a7aa` | received 1123699, pulled 1123699, calldata amount 1123699: the swap's runtime output was injected into the call |
| SP2 (two legs, push) | 0.02 AMKR + 0.0017 SPY → two `lifi.swap`s → `core.merge` → `core.transfer` to probe → call probe | `0x0bac61552e31299f7419a607def008d7167a074731f20e0ad5a5ba95b2315652` | received 2443631 = 1129047 (AMKR leg) + 1314584 (SPY leg), pushed before the call |

In all three:

- `msg.sender` at the probe was the user's Composer proxy, equal to the
  compile's `userProxy`. It was not the wallet and not a shared LI.FI executor.
- `tx.origin` was the wallet.
- `context.sender` resolved to the wallet, and the probe paid everything back
  to it.
- The user's approval went to the user's own proxy.
- The proxy's inline approval to the probe was **0 after the call**: none was
  left behind.
- The probe ended with zero balance.

### 7.1a Reconciliation of every token transfer

`scripts/spike/composer-tx-reconcile.ts` nets every ERC-20 `Transfer` in a
receipt per party. That net is exactly each party's balance change in the
transaction, so no archive state is needed.

| Tx | USDG into the proxy from the swap(s) | Proxy → probe | Proxy → anyone else | Proxy net (every token) | Probe net |
|---|---|---|---|---|---|
| S | 1123699 | 1123699 | 0 | 0 | 0 |
| SP | 1129736 | 1129736 | 0 | 0 | 0 |
| SP2 | 1129047 + 1314584 = 2443631 | 2443631 | 0 | 0 | 0 |

The whole swap output reached the probe. Nothing stayed on the proxy, and no
input token was left unsold: the unspent-input sweeps to the wallet were 0.

Two things seen inside the route, before the proxy:

- **LI.FI fee, taken from the input:** 0.25% of every sold token went to
  `0xc06e…264b` before the swap (e.g. 0.00005 of 0.02 AMKR). It does not
  affect settlement, which measures the USDG that arrives, but the sale
  summary shown to the user must include it.
- **A route intermediary kept a few units:** `0x48a0…e13f` passed on less USDG
  than it received in SP (249 units) and SP2 (226 and 197), and none in S.
  This is the gap §7.1 first read as "simulated vs actual". It happens inside
  the route, not on the proxy, and it is why the fee must be computed from the
  amount that reaches the contract.

### 7.2 Compile and simulation only (no transaction)

- Robinhood Chain (4663) is in Composer's `getChains()` list. A
  non-catalog target (the probe) was accepted, and every flow's user-program
  simulation passed.
- **R (forced revert):** the simulation reverted with the probe's own
  `BelowMinimum(1000000, 1000001)`. The probe was reached, it had received the
  full amount, and its revert failed the whole program. A reverting
  transaction was **not** sent on-chain. Atomicity is therefore shown by
  simulation for this flow on Robinhood Chain, not by a real revert, and it is
  not claimed for other Composer operations (async routes, for one).
- **P (push, USDG only):** compiled and simulated only. Push with a real swap
  ran on-chain as SP.
- **`userProxy`:** identical across every compile. The transaction target was
  a Composer entry contract (`0xaceb…dae`) before the first send, and the
  proxy itself afterwards. So the proxy address was known before it existed
  (counterfactual) and is fixed per user. This is what lets B bind the
  expected proxy.

### 7.3 Findings that change the design

1. **Who calls the settlement contract:** the user's Composer proxy. B
   authorizes on: an explicit `user` + the expected proxy for that user + the
   signed redemption context. Never on `tx.origin`; it is only observed.
2. **Composer's price-impact guard cannot see value handed over by
   `core.call`.** Live, every pull flow was rejected ("input $1, output $0,
   impact 10000 bps") until the guard was switched off
   (`maxPriceImpactBps: 10000`). A `core.transfer` to the contract is a tracked
   output, so push flows keep the default guard.
3. **Recommended model for B: push (SP).** Composer transfers the swap output
   to the settlement contract, then calls it, and the contract counts what
   arrived. This keeps Composer's own price-impact guard on top of BAG's floor
   (`minUserProceeds`) and the swaps' on-chain minimums. Pull (S) also works,
   but only with Composer's guard off. Under push, the contract must count only
   what arrived in this transaction: it holds nothing between calls, and a
   stray balance must not be credited to a redemption. That is B's design work.
4. **Measure, don't trust the quote:** in SP the swap produced 1129985 USDG,
   but 1129736 reached the proxy, because a route intermediary kept 249 units
   (§7.1a). The fee is computed from the contract's measured balance delta,
   as §5 already specifies.
5. **AMKR:** Uniswap v3 has no quote for it (the fee router's venue), yet
   LI.FI sold it and delivered the output to BAG's contract. The venue
   limitation in `docs/STATUS.md` is solved by this route, not by more Uniswap
   liquidity.

### 7.4 Still open (B contract and backend, separate PRs)

- The user/creator split and `CreatorRewardsVault.settleReward` inside the
  Composer call. This is our own contract logic; it needs Hardhat tests and
  then one small real run.
- The push-model accounting rule (only this transaction's arrival counts) and
  the binding to the user's proxy.
- The two-phase attestation over Composer quotes, keeping the #16
  price-quality rule.
- Deployment of anything. The router stays undeployed.
