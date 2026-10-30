# Basket settlement adapters

Status: **NOT IMPLEMENTED: specification.** The contract between `BagSettlementRouter`
(`docs/BAG_SETTLEMENT_ARCHITECTURE.md`) and the code that performs one swap.

An adapter turns typed parameters into one exact-input swap on one liquidity venue. It never decides who receives
what, how much is spent, or which tokens are acceptable: the router decides that from the signed intent and the
registered composition, and measures every result itself.

## Interface

```solidity
interface IBasketAdapter {
    /// keccak256("BAG_ADAPTER_<VENUE>_<KIND>_V<n>"), e.g. "BAG_ADAPTER_UNIV3_EXACT_IN_V1".
    function adapterId() external pure returns (bytes32);

    /// Pure validation, no state change and no token movement. Used by the SDK before signing and by tests.
    /// Returns (false, reason) instead of reverting so callers can report why.
    function check(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        view
        returns (bool ok, bytes32 reason);

    /// Called only by the router, after it transferred exactly `amountIn` of `tokenIn` to this adapter.
    /// Swaps all of it to `tokenOut`, sends the output to `to` (the router), reverts below `minOut`.
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to, bytes calldata data)
        external
        returns (uint256 amountOut);
}
```

## Call protocol

1. The router snapshots its own `tokenOut` balance and the adapter's `tokenIn` / `tokenOut` balances.
2. The router transfers exactly `amountIn` of `tokenIn` to the adapter. There are no allowances from the router to
   adapters.
3. The router calls `swapExactIn(…, to = router, …)` with `CALL`, never `DELEGATECALL`.
4. The router requires:
   - its `tokenOut` delta `≥ minOut` (the measured value counts, not the return value);
   - the adapter's two balances back at their snapshots: it keeps nothing;
   - for exact input, the whole `amountIn` consumed. An adapter that returns unspent input sends it back to the
     router, which refunds the payer.

## Adapter invariants

Every adapter ships with a test per invariant.

| ID | Invariant |
|---|---|
| A1 | Only the router can call `swapExactIn` (immutable router address). |
| A2 | Calls only venue contracts fixed at construction (e.g. SwapRouter02) and the two tokens. No target, selector or calldata from `data` is ever executed as given. |
| A3 | `data` is decoded into typed fields and every field is checked: allowed fee tiers, pools derived from the canonical factory, path tokens equal `tokenIn` → `tokenOut` (plus allowed hubs once multi-hop exists). |
| A4 | The venue receives `amountOutMinimum = minOut` (or equivalent), so the venue itself also reverts below the minimum. |
| A5 | The recipient on the venue is `to`. It is never taken from `data`. |
| A6 | An allowance to the venue is exactly `amountIn` and is reset to 0 after the call, even when unused. |
| A7 | No storage that affects behaviour, no owner, no upgrade. |
| A8 | No callback is accepted. The adapter does not implement swap callbacks: venues that need one are reached through the venue's own router. This removes the forged-pool callback class (cf. SushiSwap RouteProcessor2, 2023). |
| A9 | `check` and `swapExactIn` agree: anything `check` refuses, `swapExactIn` reverts on. |
| A10 | Gas and return data from the venue are bounded. A revert is bubbled up as one adapter error. |

## v1: `UniswapV3ExactInAdapter` (`BAG_ADAPTER_UNIV3_EXACT_IN_V1`)

- **Venue:** Uniswap v3 `SwapRouter02` and `UniswapV3Factory` on the chain, fixed at construction (Robinhood:
  `lib/config/robinhood-chain.ts`, verified against Uniswap's deployment page).
- **`data`:** `abi.encode(uint24 fee)`, single hop.
- **Checks:**
  - `fee ∈ {100, 500, 3000, 10000}`;
  - `factory.getPool(tokenIn, tokenOut, fee)` has code;
  - `tokenIn != tokenOut`.
- **Call:** `exactInputSingle({ tokenIn, tokenOut, fee, recipient: to, amountIn, amountOutMinimum: minOut,
  sqrtPriceLimitX96: 0 })`.
- **Not in v1:** multi-hop paths, which v1.1 adds with `bytes path`, a hub allowlist and a tier check per hop.

## Later adapters

Each one has its own entry gate: quote-quality tests and adversarial tests on a fork before it joins a router
version.

### Uniswap v4

- `data` is a `PoolKey` plus `zeroForOne`.
- Hooks: only hookless pools, or hooks on an explicit allowlist reviewed per hook address. A hook can move value.
- Reached through Uniswap's own router (Universal Router `V4_SWAP`, exact-in single only), so the adapter implements
  no `unlockCallback` (A8).

### Aggregator (0x, 1inch, Odos, KyberSwap, …)

- **One adapter per aggregator.** Its target is that aggregator's fixed entry point, with a selector allowlist.
- **Admitted only if** the adapter can decode and check, from the aggregator's documented ABI: input token and
  amount, output token, recipient (`= to`) and the minimum. An opaque payload that cannot be decoded is refused.
  This excludes APIs whose action encoding is declared unstable.
- **Output** is still measured by the router; the allowance is still exact and reset.
- **Quote freshness:** the plan expiry must not exceed the aggregator's quote deadline.

### Composer (optional)

- **Target:** the payer's or the router's Composer account, under a reviewed factory pin (as in the SDK's
  `resolveLifiComposerAccount`).
- **Output:** the program's terminal outputs must name the router as owner, with immediate delivery. The router
  measures the delta as for any adapter.
- **Why it is last:**
  - programs are general VM code;
  - per-user proxies make the target vary;
  - factory deployments have differed between documentation and production.
- **Status:** never required for a purchase to work.

## Versioning and pinning

- **Identity:** an adapter is its address plus `adapterId`.
- **Router versions:** a router version fixes its adapter list at construction. Adding one means a new router version.
- **SDK pins:** per chain, the router address, router code hash, adapter addresses and adapter code hashes. A
  mismatch is a refusal, never a fallback.

## Tests required per adapter

- **Unit, with venue mocks:** every A-invariant, including a malicious venue that:
  - returns a false amount;
  - keeps tokens;
  - re-enters the router;
  - sends output to a third party.
- **Fork, real pools:** exact output, revert below minimum, allowance reset, adapter balance zero.
- **Adversarial:** forged pool address in `data`, wrong token pair, fee-on-transfer token, zero-liquidity tier,
  unsupported tier.
- **Differential:** `check` vs `swapExactIn` on generated inputs (A9).
