# Execution trust boundary review

2026-11-14, `audit/sdk-first-hardening`. Scope: purchase/sale verification, the provider compiler and candidate
ranking, `BagExecutionRouter`. Internal review, not an audit.

## T-1 (MEDIUM): sibling calls in a wallet batch are credited as execution output

- **Where:** `lib/blockchain/composer-status.ts` `trackComposerTransaction` → `isWalletRoutedBatch` /
  `batchContainsCall` (containment); consumers `lib/server/purchase-execution.ts` (~line 1534, lower bound
  `minOutputRaw` only), `lib/server/redeem-execution.ts` (~lines 901–902, `sentAmountsByAddress` /
  `receivedAmountsByAddress`), `lib/server/rebalance-execution.ts` (line 235).
- **Behavior:** a transaction from the wallet (to itself, or through MetaMask's DelegationManager) is accepted when
  its calldata contains the exact Composer call. Other calls in the same batch are not excluded, and every ERC-20
  Transfer to (or from) the wallet in the transaction is summed per token.
- **Scenario:** the wallet owner crafts a batch = the exact Composer call + `token.transferFrom(ownOtherAccount →
  wallet, X)` and reports its hash for the intent. The purchase books Composer output + X, at the purchase's cost.
  In a sale, extra inbound USDG inflates proceeds; extra outbound transfers can satisfy "sold in full".
- **Impact:** ledger integrity (positions, cost basis, realized P&L, performance views, leaderboards). No third
  party loses funds; fee-path sales take proceeds from the `Settled` event, not from Transfer sums, so fees are not
  affected. Requires a deliberately crafted transaction; the app's own UI sends a single call.
- **Verified:** unit level, `lib/blockchain/__tests__/composer-status.test.ts` "KNOWN GAP T-1" (500 + 1000 credited
  as 1500). The SDK has the same property in batched `BALANCE_DELTA` / `TRANSFER_LOGS` mode
  (`packages/bag-sdk/test/receipt.test.ts` "KNOWN GAP T-1"); its `DELIVERY_LOG` evidence is measured inside the
  Composer program and is not affected.
- **Changed:** nothing in production code; both behaviors are pinned by tests.
- **Fix:** exact-batch binding shared through the SDK (`../architecture/SDK_FIRST_MIGRATION_PLAN.md` M2), then
  delivery-proof compilation in the app (M3). Shadow-run on a real MetaMask smart account before enforcing.

## D-1 (difference, by design today)

A batch carrying the exact call: app = DONE (containment); SDK = INDETERMINATE (`UNSUPPORTED_TRANSACTION_ENVELOPE`)
unless the reader provides a call trace. Pinned in `sdk-app-purchase-verification-parity.test.ts`. Resolved by M2.

## Verified equal

For direct calls the two implementations agree on the transaction to sign, the verdict and the per-token amounts,
and both refuse another calldata, sender, native value, or a revert (`sdk-app-purchase-verification-parity.test.ts`).

## Compiler and ranking

- The provider compiler is CURRENT code but off: `isBagExecutionCompilerEnabled()` is true only for
  `BAG_EXECUTION_COMPILER_ENABLED === 'true'`; `.env.local` sets `false`; STATUS records the live purchase path as the
  legacy one.
- Ranking does not claim "best" with fewer than two executable candidates or on an exact tie, and separates
  guaranteed from quoted output (`lib/execution/candidate-ranking.ts`, header comment and `pickHighest`). No
  "best execution" claim is supported by live data: only one provider (LI.FI Composer) runs live.
- Not re-audited here: quote expiry and cache paths inside the compiler. Their tests run in the unit suite
  (passing); a focused review belongs with enabling the compiler.

## BagExecutionRouter

- Trust model is stated in the contract NatSpec: `planSigner` chooses each leg's calldata **and** the minimum
  outputs, so a stolen signer can route output elsewhere within those minimums. Owner manages allowlists.
- State: MERGED, NOT DEPLOYED. The app adds the router provider only when a router address, a plan-signer key and a
  confirmed on-chain Bag all exist (`buildBagRouterProviderConfig`, `lib/server/purchase-execution.ts` ~line 115);
  no router address is configured locally.
- LOW: `getBagRouterPlanSignerKey()` returns any non-empty string; `.env.example` ships a non-empty placeholder.
  Combined with a configured router address this fails at key parsing rather than as "not configured". Validate the
  key shape (0x + 64 hex) and treat anything else as unset.
- Publishing weights on-chain (StrategyCompositions) does not constrain calldata or recipients; it cannot replace the
  plan signer. Viable reductions: user-side plan inspection in the SDK (decode legs for known routers, require the
  router as recipient), minimum outputs derived from the user's own quote, per-leg balance-delta checks. Activation
  gate: all of these reviewed, a documented signer custody (KMS/HSM), bytecode qualification, owner Safe, and an
  approved controlled deployment.

## External trust

LI.FI Composer VM 1.2 is pinned by factory code hash on Robinhood and Base (hash re-checked 2026-11-14) and is not
audited by BAG (`docs/SDK_COMPOSER_TRUST.md`).
