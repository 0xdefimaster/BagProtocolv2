# BAG settlement architecture

Status: **G1 (specification) in code; router NOT IMPLEMENTED.** The message types, hashing, target split, adapter
interface and receipt event are in `contracts/settlement/` and `lib/domain/settlement/basket-types.ts`, pinned by the
shared vectors in `contracts/test/vectors/basket-settlement-v1.json` (both sides tested). The router and adapters are
not written, audited or deployed. Supersedes the leg model of
`docs/BAG_SETTLER_DESIGN.md`: legs are typed adapter calls, never arbitrary `target` + calldata. The rest of that
document (wallet paths, launch chains, rejected alternatives) still applies. Adapter contract: `docs/ADAPTER_INTERFACE.md`.
Rollout and gates: `docs/MIGRATION_AND_ROLLOUT.md`.

## What BAG is

BAG = a portable basket standard + a safe settlement layer + independent receipt verification.

- **Liquidity sources** answer "how is this swapped, along which route?": LI.FI/Composer, 0x, 1inch, Uniswap and others.
  BAG does not compete with them and does not write its own DEX.
- **BAG** answers "which assets, in which proportions, for which strategy version, and how does anyone verify that
  the purchase did exactly that?"
- **The BAG app is the first integrator.** SDK, API, widget and settlement contracts are equally usable by other
  wallets, dApps and agents. Composer is one optional adapter or quote source, not the centre.

## Layers

```
bag.json v1  ──►  StrategyRegistry (definitionHash) + StrategyCompositions (weights on chain)
                                   │
   user / agent signs              ▼
   BasketIntent  ───────────►  economic limits: who pays, who receives, which strategy version,
                                how much at most, worst price per asset, fee caps, nonce, deadline
                                   │
   quote provider / keeper         ▼
   ExecutionPlan ───────────►  short-lived route: adapter + typed params per leg, minimums, fees
                                   │
                                   ▼
                          BagSettlementRouter  (no admin, no arbitrary calls)
                           ├─ UniswapV3ExactInAdapter   (v1)
                           ├─ UniswapV4Adapter          (later)
                           ├─ AggregatorAdapter         (later, gated)
                           └─ ComposerAdapter           (optional)
                                   │
                                   ▼
                          BasketSettled event  ──►  SDK verifyBasketReceipt (anyone)
```

## Trust model

| Party | Can | Cannot |
|---|---|---|
| User (payer) | Sign or revoke an intent, set limits | Make the router skip a check |
| Quote provider / keeper / relayer | Choose the route within the intent, submit, delay | Spend more, use another strategy version, accept a worse price than the limit, raise a fee above its cap, deliver elsewhere |
| BAG backend | Serve quotes and plans, refuse service | Sign anything the router trusts for purchases. The router has no BAG key |
| Adapter | Execute one typed swap | Choose recipients or amounts. The router measures every result |
| Router | Enforce the intent, the registered composition and the plan | Call anything but tokens, the two registries and its fixed adapters |

**Success criteria.**
- No single party — user, quote provider or a hot backend key — can loosen the economic limits on its own.
- A purchase is cryptographically bound to the strategy version and its `definitionHash`.
- Anyone can verify with the SDK that the delivery followed the basket rules.
- Purchases work with Composer switched off.

## BasketIntent (signed by the payer)

EIP-712, domain `BagSettlementRouter` / `1` / `chainId` / router address. Signature checked with ECDSA for an EOA or
ERC-1271 for a smart account (OpenZeppelin `SignatureChecker`). When `msg.sender == payer` no signature is needed.

```solidity
struct BasketIntent {
    address payer;               // funds come from here: EOA, smart account, or a DCA executor
    address recipient;           // every output goes here
    bytes32 strategyId;          // StrategyRegistry id
    uint32  strategyVersion;
    bytes32 definitionHash;      // == StrategyRegistry.definitionHashOf(strategyId, strategyVersion)
    bytes32 compositionHash;     // == StrategyCompositions.compositionHashOf(strategyId, strategyVersion)
    address inputToken;          // v1: USDG
    uint256 maxInput;            // gross, fees included
    bytes32 priceLimitsHash;     // keccak256(abi.encode(uint256[] maxPriceX18)), composition order
    uint16  maxIntegratorFeeBps;
    uint16  maxProtocolFeeBps;
    uint256 nonce;               // unordered, single use (bitmap); revocable before use
    uint64  deadline;
}
```

- **Strategy binding.**
  - The router reads both registries and refuses on any mismatch.
  - StrategyCompositions cannot parse JSON. Before signing, the SDK checks that the on-chain allocations equal the
    bag.json definition (`definitionToAllocations`).
  - A version without a published composition cannot be bought through the router.
- **Price limits, not routes.**
  - `maxPriceX18[i]` is the most input-token raw units the payer accepts per raw unit of asset `i`, scaled 1e18.
  - The router derives `minOut[i] = floor(targetIn[i] × 1e18 / maxPriceX18[i])`. No decimals are needed.
  - For a one-shot purchase the SDK sets the limit to the quoted price plus the payer's slippage. For DCA the payer
    signs a standing ceiling.
  - A limit of 0 is invalid (fail closed).
- **Revocation.**
  - `invalidateNonces(wordPos, mask)` (Permit2-style bitmap) by the payer.
  - Any token approval can also be revoked at the token.

## ExecutionPlan (supplied by the quote provider, not signed by the payer)

```solidity
struct Leg {
    address tokenOut;       // must be the composition asset at this position
    uint256 amountIn;       // must equal the router's computed target for that asset
    uint256 minOut;         // must be ≥ the intent-derived minimum; the adapter enforces it too
    address adapter;        // one of the router's fixed adapters
    bytes   adapterData;    // typed params, decoded and validated by that adapter
}

struct ExecutionPlan {
    bytes32 intentHash;
    uint64  expiry;                    // short quote life, ≤ intent.deadline
    uint256 inputAmount;               // ≤ intent.maxInput
    address integratorFeeRecipient;
    uint256 integratorFee;             // ≤ inputAmount × maxIntegratorFeeBps / 10000
    uint256 protocolFee;               // ≤ inputAmount × maxProtocolFeeBps / 10000; paid to the router's immutable treasury
    Leg[]   legs;                      // composition order; the input token's own share is kept, not swapped
}
```

`planHash = keccak256(abi.encode(plan))` is emitted. Replay is impossible because the intent nonce is consumed by the
execution.

## BagSettlementRouter

Immutable. No owner, pause or upgrade. Adapters, treasury, Permit2 address (where deployed) and the two registries are
fixed at construction. A new adapter or rule set means a new router version, which the SDK pins by address and code
hash per chain.

**`execute(intent, signature, plan, funding)`, in order:**
1. **Authorization.**
   - Check the deadline and the plan expiry.
   - Consume the nonce.
   - Verify the signature (unless `msg.sender == payer`).
   - Check that `plan.intentHash == hash(intent)`.
2. **Strategy.** `definitionHash` and `compositionHash` must match the registries. Every allocation's `chainId` must
   be `block.chainid`.
3. **Amounts.**
   - Fees are within their caps.
   - `net = inputAmount − fees`.
   - Targets come from `net` split by the composition weights. This is the same largest-remainder rule as
     `packages/bag-sdk/src/split.ts`, with ties broken by token address ascending.
   - Every leg's `amountIn` must equal its target exactly.
   - `minOut ≥` the intent-derived minimum.
4. **Funding.** Pull exactly `inputAmount`: allowance, EIP-2612 `permit` or Permit2, whichever the chain and token
   actually support (verified per deployment, never assumed). Then check that the router's balance rose by exactly
   `inputAmount`; a fee-on-transfer token is refused.
5. **Fees.** Integrator fee to the signed recipient, protocol fee to the treasury.
6. **Kept share.** If the input token is itself an asset, its target goes straight to `recipient`.
7. **Legs.** For each leg:
   - Snapshot the router's `tokenOut` balance and the adapter's `tokenIn`/`tokenOut` balances.
   - Transfer exactly `amountIn` to the adapter and call `swapExactIn`.
   - Require: router `tokenOut` delta `≥ minOut`; adapter balances back to their snapshots.
   - The return value is informational only.
8. **Delivery.** Transfer each measured delta to `recipient`. Refund any unspent input to the payer. Every token
   touched must end at its pre-execution router balance: deltas, never absolute balances, so a donation is never
   paid out.
9. **Event.** `BasketSettled(intentHash, strategyId, recipient, strategyVersion, definitionHash, compositionHash,
   planHash, payer, inputToken, grossInput, integratorFee, integratorFeeRecipient, protocolFee, tokensOut,
   amountsOut)`.

**Invariants.** Each is a test; see `ADAPTER_INTERFACE.md` for the adapter side.

- R1: the only external calls are to ERC-20 tokens (`transfer`, `transferFrom`, `balanceOf`, `permit`), Permit2,
  the two registries (view) and the fixed adapters. No caller-supplied target, selector or calldata.
- R2: every leg spends exactly its composition target. The legs cover every composition asset except the kept input
  asset.
- R3: each delivered amount is `≥ max(plan.minOut, intent minimum)`, measured as a balance delta.
- R4: fees `≤` their signed caps. The protocol fee goes only to the immutable treasury.
- R5: no allowance or balance survives the transaction (router and adapters).
- R6: one execution per nonce, before its deadline. A revoked nonce cannot execute.
- R7: `nonReentrant` on every state-changing entry point.
- R8: the event equals what moved (cross-checked with Transfer logs in tests).

**Sale direction.**
- A `SellIntent` names the holdings sold (tokens, exact amounts), the output token, the minimum gross output, the
  recipient, nonce and deadline:

  ```solidity
  struct SellIntent {
      address seller;
      address recipient;
      bytes32 strategyId;
      uint32  strategyVersion;
      bytes32 holdingsHash;      // keccak256(abi.encode(address[] tokens, uint256[] amounts))
      address outputToken;
      uint256 minGrossOutput;
      uint256 nonce;             // same unordered bitmap as BasketIntent
      uint64  deadline;
  }
  ```
- The router pulls the holdings, swaps them through the same adapters, and measures the gross output as its own
  balance delta.
- The performance fee is computed from that measurement and the attested cost basis / loss carry (fee semantics
  unchanged: `docs/FEE_ECONOMICS_DESIGN.md`). The fee and the fork royalty are paid; the rest goes to the recipient.
- Basis attestations come from an ERC-1271 or threshold signer, not a single hot key.
- Any admin role on supporting contracts uses `Ownable2Step`.

## Fees: three kinds, kept apart

| Fee | When | Bound | Recipient |
|---|---|---|---|
| Integrator / execution | At purchase, from the input | Payer-signed cap (bps) | Recipient named in the plan |
| Protocol | At purchase, from the input | Payer-signed cap (bps) | Router's immutable treasury |
| Creator performance fee (+ fork royalty) | At sale, only on realized gain | Strategy's locked rate, attested basis/carry | Creator / root creator |

The three are never modelled as one split of the purchase amount.

## DCA is not part of the router

DCA only answers "who may spend how much, and when". It is layered above the router:

```
RecurringAuthorization (signed once) ──► RecurringPurchaseExecutor ──► BagSettlementRouter ──► adapters ──► receipt
```

- **Authorization.** The `RecurringAuthorization` carries the same economic terms as a `BasketIntent`: strategy,
  version, hashes, recipient, input token, price limits and fee caps. On top of those it adds the per-run maximum,
  total budget, maximum runs, period, start and expiry.
- **Each run.**
  - The executor checks the window, budget, runs and revocation.
  - It pulls the run amount under the user's wallet permission.
  - It calls the router as `payer`, with an intent built from the stored terms.
- **No plan signer.**
  - A keeper supplies the plan; the router validates it against the intent and the composition.
  - Liveness still depends on a keeper, but the keeper cannot loosen anything.
- **One-shot purchases never wait for DCA.**
- **Wallet permission classes are distinct evidence and must not substitute for each other:**
  - EOA allowance / EIP-2612 permit to the executor;
  - ERC-7715 native permission;
  - smart-account delegation.
  - Offer only the class a wallet has actually been shown to support (`REAL_WALLET_TESTED`). Research prototypes
    (#128–#131) are not production behaviour.

## Receipt verification

The SDK's `verifyBasketReceipt` takes the transaction hash and the original intent, plus a pinned router address and
code hash per chain. It returns `VERIFIED` only if all of the following hold:

1. Exactly one `BasketSettled` from the pinned router, for `hash(intent)`.
2. The strategy id, version, `definitionHash` and `compositionHash` are equal to the intent and to the registries at
   that block.
3. `tokensOut` equals the composition, and each amount is `≥` the intent-derived minimum.
4. The recipient's Transfer logs, or transaction-scoped balance deltas when a qualified reader is supplied, agree with
   `amountsOut`.

A trace reader is no longer required: the event comes from fixed code.

## Build order

1. Canonical `BasketIntent` / `ExecutionPlan` / adapter interface / receipt schema, with EIP-712 test vectors.
2. Router + `UniswapV3ExactInAdapter` + tests (unit, invariants, Robinhood fork).
3. SDK: compile (intent + plan), validate, execute request, `verifyBasketReceipt`.
4. `/v1/quote` and `/v1/status`. These are thin wrappers over the SDK, with no logic of their own; every integrator
   can run the SDK instead.
5. Widget.
6. MCP `quote_bag`.
7. Explorer / receipt page.

## V1 scope

- **Network and input:** Robinhood Chain only; USDG input only.
- **Tokens:** a reviewed token universe, enforced in the SDK and backend. The router itself refuses fee-on-transfer
  behaviour by delta checks.
- **Adapter:** `UniswapV3ExactInAdapter` only, single hop USDG → asset, fee tiers {100, 500, 3000, 10000}.
- **Execution:** atomic multi-leg purchase.
- **Fail closed:** when there is no pool, or a quote cannot meet the payer's limits, the purchase is refused. No
  promise that every token can always be bought.
- **Later:** V4, multi-hop and aggregators, each after its own quote-quality and security tests. A Composer adapter
  is optional.

## Relation to existing contracts

- **`BagExecutionRouter`** (planSigner model): not used by the SDK path. Its delta accounting, exact approve/reset and
  refund logic are reused.
- **`StrategyRegistry` / `StrategyCompositions`:** hard dependencies. StrategyCompositions must be deployed and the
  version's composition published.
- **The current redemption settlement:** moves to the sale direction above. Rollout:
  `docs/MIGRATION_AND_ROLLOUT.md`.
- **#130 `RecurringPurchaseExecutor`:** becomes the DCA layer above this router instead of above
  `BagExecutionRouter`.

## Open questions

- Hub tokens and path validation for multi-hop (v1.1).
- Whether the protocol fee starts at 0 bps (cap only) and how the treasury is governed.
- Robinhood Chain support for Permit2 and USDG `permit`: run `scripts/verify-settler-prereqs.ts` before relying on them.
