# BagSettler: a Composer-independent basket settlement router

Status: design proposal, 2026-10-28. Nothing here is deployed or audited. It does not change bag.json v1, the definition hash or allocation semantics.

## Problem

The SDK can only execute a purchase through LI.FI Composer. Three of the four 0.3.0 release gates (`packages/bag-sdk/release-gates.json`) exist only because of that: the production factory policy, the deployment pin and the trace-based receipt readers (Geth 1.16 / Nitro) that reconstruct what a Composer VM program did. A BAG-owned settlement contract would remove the execution monopoly and most of that verification machinery.

`contracts/BagExecutionRouter.sol` already exists, but it is built for the app, not for the SDK:

| Property | BagExecutionRouter | What the SDK needs |
|---|---|---|
| Authorization | EIP-712 plan signed by BAG's `planSigner` | No BAG server in the path: an agent must execute alone |
| Governance | `owner` target/token allowlists | Any bag.json asset, without waiting for an allowlist update |
| Identity | `bagId` must resolve in `BagFactory` | SDK purchases are `NOT_BAG_ACCOUNTED`; identity is the definition hash |
| Input | Standing ERC-20 approval to the router | No passive allowance |
| Undeclared output | Stays in the router | Impossible by construction |

Its delta accounting, exact approve-then-reset per leg, deadline, reentrancy guard and leftover refund are correct and should be reused.

## What the literature and incidents say

1. **Passive allowances are the dominant loss vector.** LI.FI 2024 (~$11.6M, an unvalidated call in a new facet, only infinite approvals exposed), Socket/Bungee 2024 (~$3.3M, `performAction` forwarded `transferFrom` calldata, only infinite approvals exposed) and SushiSwap RouteProcessor2 2023 (~$3.3M, a forged pool passed the callback check and pulled from approvers) all had the same shape: a router holding users' standing approvals plus one unvalidated call path. Allowlists did not prevent any of them; each bug arrived with a new module.
2. **0x Settler's answer: hold nothing.** Settler takes no token allowances and keeps no TVL. Input moves through Permit2 signature transfers or AllowanceHolder's ephemeral allowance. 0x state this lets Settler "be more lax with the calls that it makes to other contracts because it does not hold TVL or allowances". The MetaTxn variant signs `SlippageAndActions(recipient, buyToken, minAmountOut, actions)` as a Permit2 witness, binding the trade to the signature. Deployments are discovered through a registry and rotated rather than upgraded in place.
3. **Uniswap Universal Router: commands plus postconditions.** A command byte string with parallel inputs, Permit2 transfer commands, `SWEEP`/`BALANCE_CHECK_ERC20` postconditions and opt-in allow-revert for partial fills.
4. **Weiroll/Enso: general VMs.** Expressive (return values feed later calls), but delegatecall-based scripting is the hardest model to verify and is what makes Composer receipts need trace readers.
5. **CoW, UniswapX, ERC-7683: intents.** The user signs an outcome and competing solvers/fillers supply the route; settlement verifies the outcome only. This removes dependence on any single liquidity source, but needs a filler network.
6. **Wallet batching (EIP-5792 `wallet_sendCalls`, EIP-7702 + ERC-7821).** Approve and execute can be one atomic batch, so an exact approval never outlives the transaction. Wallet support is still uneven.
7. **ERC-7621 (draft) basket tokens.** Standardizes a basket share token and deliberately leaves swap execution out. bag.json delivers assets straight to the wallet, so this is a later wrapper, not a router concern.

## Proposed model

Basket purchases are a narrow problem: one input, N exact-input swaps, every output to one recipient, all or nothing. The router should be the smallest contract that settles exactly that, and should be safe because it has nothing to steal, not because of an allowlist.

### Contract properties

- **Immutable, no owner, no signer, no allowlist, no pause.** Deployed with CREATE2 at the same address on every chain. A new version is a new address; the SDK pins address and runtime code hash per chain (the existing deployment-pin mechanism, with BAG as the reviewer instead of a third party).
- **No passive allowances.** Input arrives one of three ways:
  - `settleWithPermit`: Permit2 `permitWitnessTransferFrom`, the `BagPurchase` struct as witness. One signature binds funds and outcome, and anyone (the agent, a relayer) may submit it.
  - `settle` with `msg.sender` as payer: `transferFrom` of an exact amount approved in the same EIP-5792/7702 batch.
  - Native input: `msg.value == inputAmount`, wrapped internally.
- **Exact amounts, no bps partition.** Each leg carries its own `amountIn`. The router requires `Σ amountIn + keptAmount + feeAmount + relayerFee == inputAmount`, so the allocation from `splitByWeight` is enforced exactly. `partition.ts`, the 16-part limit and the bps rounding bound stop applying to this path.
- **Per leg:** `forceApprove(spender, amountIn)`, call `target`, `forceApprove(spender, 0)`. Targets are arbitrary except Permit2, the router itself and the input/output tokens of the purchase. Since the router holds no approvals and only the current payer's funds, a malicious leg can at worst waste that payer's own input, which the output floors then revert.
- **Outcome checks:** for each output token, router balance delta ≥ `minOut` (delta, never absolute balance), then transfer exactly the delta to `recipient`. Output tokens must be distinct. Kept share and fee go straight to their recipients. Leftover input is refunded to the payer. Any shortfall reverts the whole purchase.
- **Structured event**, the main SDK simplification:

```solidity
event BasketSettled(
    bytes32 indexed definitionHash,
    address indexed payer,
    address indexed recipient,
    address inputToken,
    uint256 inputAmount,
    address[] tokensOut,
    uint256[] amountsOut
);
```

A log can only carry the address of the contract that emitted it. With a pinned, immutable code hash, `eth_getTransactionReceipt` alone proves what was delivered. `debug_traceCall`, Geth/Nitro qualification and the `INDETERMINATE` path for public RPCs become unnecessary for router purchases.

### Signed intent

```solidity
struct Leg {
    address tokenOut;
    uint256 amountIn;
    uint256 minOut;
    address spender;   // receives exactly amountIn, reset to 0 after the call
    address target;
    bytes   data;      // route calldata; recipient/taker = router
}

struct BagPurchase {
    bytes32 definitionHash;   // bag.json v1 definition hash
    address recipient;
    address inputToken;
    uint256 inputAmount;
    uint256 keptAmount;       // allocation when the input token is itself an asset
    address feeRecipient;
    uint256 feeAmount;
    uint256 relayerFee;       // input token paid to msg.sender; 0 when the payer submits
    uint256 deadline;
    bytes32 legsHash;         // keccak256 of the encoded Leg[]
}
```

Only `legsHash` goes into the witness, so the Permit2 signature stays small. The SDK displays and checks the decoded legs before signing, as it does now with `compileBag`.

### Where routes come from

The router does not route. The SDK's existing provider seam (`ComposerProvider.compile`) becomes a per-leg `LegQuoter`:

- **Aggregator legs:** 0x, 1inch, Odos, KyberSwap, ParaSwap, with taker/recipient set to the router. Quotes are taken per leg and the best wins, so no single API is load-bearing.
- **Direct AMM legs without an API key:** Uniswap v3/v4 and Aerodrome-style pools encoded by the SDK. Worse prices on large orders, but always available. Required on chains aggregators don't cover (check Robinhood first).
- **LI.FI** remains one quoter, not the execution layer.

The router checks outcomes regardless of where calldata came from, so a wrong or malicious quote fails closed.

## What changes in the SDK

| Today (Composer) | With BagSettler |
|---|---|
| Composer factory policy + deployment pin (gates 1–2) | BAG's own immutable deployment pin |
| bps partition, ≤16 parts, rounding bound | Exact per-leg amounts |
| Trace-based receipt readers (Geth 1.16, Nitro) | Receipt logs from a pinned code hash |
| One provider | Per-leg competition among N quoters + direct AMM fallback |
| Approval to a per-user proxy | Permit2 witness or same-batch exact approval |

The Composer path can stay as an alternative provider; nothing has to be removed.

## Launch chains and one-click purchase

Target: Robinhood (4663), Base (8453), Arbitrum (42161). "One click" means one wallet popup per purchase, on every wallet, including wallets without EIP-5792 atomic batching (Rabby, per the note in `lib/blockchain/wallet-sweep-client.ts`).

### Entry points (all in v1, because the contract is immutable)

| Entry point | Payment | Who submits |
|---|---|---|
| `settleNative(purchases, legs)` | `msg.value`, wrapped internally | Payer |
| `settle(purchases, legs)` | `transferFrom(msg.sender)`, exact approval in the same batch | Payer |
| `settleWithPermit(purchases, legs, permit, signature)` | Permit2 witness over the purchase batch | Anyone: payer, agent or relayer |

Every entry point takes an array of purchases (multi-buy). One payment covers the batch: the sum of `inputAmount` over the purchases equals the amount pulled, each purchase keeps its own legs, floors and sum rule, and emits its own `BasketSettled`. Any failing purchase reverts the batch. All purchases in a batch share one chain and one input token. Buying across chains is not atomic and stays out of v1.

### Client path selection

| Situation | Path | Popups per purchase |
|---|---|---|
| Pays with ETH (any wallet) | `settleNative` | 1 transaction |
| ERC-20, wallet reports atomic EIP-5792 (MetaMask) | `wallet_sendCalls`: exact approve → `settle` | 1 confirmation |
| ERC-20, no atomic batching (Rabby), relayer up | Sign Permit2 witness → relayer submits `settleWithPermit` | 1 signature, no gas |
| ERC-20, no batching, relayer down | Sign witness, then submit `settleWithPermit` | 2 |
| Agent with its own key | `settleWithPermit` or `settle` | 0 |

The Permit2 path needs a one-time token approval to Permit2 per token. Many wallets already have it from Uniswap. Where the token supports EIP-2612, the relayer can submit the user's `permit` to Permit2 in the same transaction, so the first purchase costs two signatures and no gas transaction. Rabby and MetaMask both sign `eth_signTypedData_v4` and show Permit2 spender and amount. Reuse `walletSupportsAtomicBatch` for the capability check.

Default the Buy button to ETH input: it is one popup on every wallet without a relayer.

### Relayer

A stateless service: simulate, submit `settleWithPermit`, receive `relayerFee` in the input token. The witness binds legs, floors, recipient, fee and deadline, so a relayer can only fail to submit, never change the purchase. Anyone can relay, BAG's relayer is one of them, and the payer can always self-submit. L2 gas is cents. BAG may sponsor it by setting `relayerFee = 0`. Quotes age quickly, so the relayer submits immediately or returns the request for a recompile.

### Per chain

| | Robinhood | Base | Arbitrum |
|---|---|---|---|
| Native | ETH | ETH | ETH |
| Main ERC-20 input | USDG (6 decimals); EIP-2612 unverified | USDC | USDC |
| Permit2 (canonical `0x0000…8BA3`) | Present per Robinhood docs (`lib/config/robinhood-chain.ts`) | Expected; verify | Expected; verify |
| Direct AMM legs | Uniswap v3 SwapRouter02 `0xCaf6…5cb2`, with the existing `robinhood-swap-builder.ts` | Uniswap v3/v4, Aerodrome | Uniswap v3/v4, Camelot |
| Aggregator legs | Unverified: plan on direct v3 as the primary source | 0x, 1inch, Odos, KyberSwap | Same |
| Same address deploy | CreateX present (Composer's factory uses it there) | Verify | Verify |

Verify each "verify" item with `eth_getCode` before deployment. Robinhood stock tokens are routed through their Uniswap v3 pools against USDG/WETH. Receipt verification is the same event check on all three chains, so the Nitro trace reader is not needed for settler purchases.

## Phases

1. **Router v1 (same chain, three networks).** Contract with all three entry points and multi-buy. Hardhat tests plus fork tests on Robinhood, Base and Arbitrum, reusing `BagExecutionRouter`'s accounting. SDK: `settler` adapter, direct Uniswap v3 quoter (Robinhood first), two aggregator quoters (Base/Arbitrum), event-based receipt verification, wallet path selection. External audit before mainnet funds.
2. **Relayer service.** The contract already supports it. Ships when Rabby users need one-click ERC-20 purchases.
3. **Intent filling.** Publish `BagPurchase` as an order that any filler can satisfy by delivering `tokensOut ≥ minOut` (UniswapX/CoW shape): the user signs outcomes, not routes. Cross-chain baskets via ERC-7683 order data later.

## Alternative considered: general composable router (ERC-8211 + diamond)

Proposal: a router that executes ERC-8211 "smart batching" batches (runtime-resolved parameters, predicates, return values written to state), with target/selector allowlists, delegatecall/CALL contexts and a diamond proxy with ERC-7201 storage. Rejected for this purpose:

- ERC-8211 is not a general VM: it adds three primitives to an ordinary batch format. But a router built around it executes caller-composed batches, which puts BAG in the business Composer and Biconomy's MEE (which already ships an audited ERC-8211 implementation) are in, without being differentiated by it.
- Caller-composed execution is what forces trace-based receipt verification today. BagSettler's value is that one fixed code path plus one event proves the outcome.
- An upgradeable diamond with facets is LI.FI's architecture: the 2024 loss came from a newly added facet. Upgradeability also brings back an owner that agents must trust, which is the factory-policy/deployment-pin gate in another form.
- Delegatecall belongs in the user's own account (7702/7579), not in a shared router whose storage and balances all users touch.
- Target/selector allowlists did not stop the cited incidents and block arbitrary bag.json assets and quoters.

What to keep: ERC-8211 is a reasonable account-side encoding. The SDK can later emit an ERC-8211 or EIP-5792 batch (exact approve → `BagSettler.settle`) for smart accounts. Rules for that layer:

- Predicates are an extra wallet-side check. They never replace the settler's own floors, and `settle` must remain directly callable without any batch layer.
- Runtime-resolved parameters may feed only the `msg.sender`-payer path. A Permit2 witness signs exact amounts, so the permit path takes no values resolved at execution time.
- Any convenience contract stays outside the settler, receives no standing approvals and cannot change what `BasketSettled` attests. None is planned for v1.

## Risks and open questions

- **Audit cost and blast radius.** Small (estimated <300 lines), but it moves user funds. Immutability means a bug is fixed by deploying a new version and moving the SDK pin.
- **Aggregator taker restrictions.** Some APIs require `taker == tx.origin` or a specific allowance target. Verify each quoter on a fork before supporting it.
- **Fee-on-transfer/rebasing tokens.** The delta check handles them conservatively. bag.json validation may need to reject them explicitly.
- **N API calls per purchase.** Rate limits and latency for 10+ asset baskets. Batch endpoints, or the direct AMM path, mitigate this.
- **App path.** Whether the app moves to BagSettler (accounting from `BasketSettled`) or keeps `BagExecutionRouter` with `planSigner` is a separate decision.

## Sources

- 0x Settler: https://github.com/0xProject/0x-settler, https://docs.0x.org/docs/core-concepts/contracts
- Uniswap Universal Router commands: https://developers.uniswap.org/docs/protocols/universal-router/concepts/commands
- LI.FI incident report (July 2024): https://li.fi/knowledge-hub/incident-report-16th-july
- Socket/Bungee incident: https://halborn.com/blog/post/explained-the-socket-protocol-hack-january-2024
- SushiSwap RouteProcessor2: https://rekt.news/sushi-yoink-rekt
- Enso routing strategies (Weiroll): https://docs.enso.build/pages/build/reference/routing-strategies
- CoW Protocol batch auctions: https://ethresear.ch/t/affiliated-amms-and-permissionless-solving-for-uniform-price-batch-auctions/20187
- UniswapX whitepaper: https://uniswap.org/whitepaper-uniswapx.pdf
- ERC-7683 Redux discussion: https://ethereum-magicians.org/t/erc-7683-redux-programmable-fillers/27674
- EIP-5792 / EIP-7702 batching: https://docs.blockdaemon.com/docs/eip-5792-transaction-batching
- ERC-7621: https://ercs.ethereum.org/ERCS/erc-7621
