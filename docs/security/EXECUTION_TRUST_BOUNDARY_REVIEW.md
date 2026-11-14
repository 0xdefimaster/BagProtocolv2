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
- **Status (2026-11-14, M2 implemented locally):** fixed behind a default-off flag. With
  `BAG_WALLET_BATCH_BINDING=enforce` (app) or `smartAccountBinding: 'EXACT'` (SDK) the shared binding
  (`packages/bag-sdk/src/wallet-envelope.ts`) refuses any execution other than the built call and the built
  approvals, so a sibling transfer can no longer reach execution accounting. In the default `off` the legacy
  behavior, and this gap, are unchanged; both characterization tests still pass there. Shadow first:
  `docs/runbooks/WALLET_BATCH_BINDING_SHADOW.md`.

## F-01 (MEDIUM): a wallet "batch" sent to any contract that carries the built calldata

- **Where:** `isWalletRoutedBatch` (`lib/blockchain/composer-status.ts`) accepts a transaction whose calldata starts
  with the `redeemDelegations` selector **regardless of its target**, if the built call's bytes appear inside it.
- **Scenario:** the wallet owner sends such calldata to a contract of their own that never runs the Composer call
  and just transfers output tokens to the wallet; the purchase is booked at its full deposit although the deposit
  never left. Same impact class as T-1 (ledger integrity, owner-crafted).
- **History:** a fix exists on `origin/fix/f01-forged-batch` (`7a62dd0`, 2026-10-19: pin DelegationManager per chain,
  require the input to leave the wallet) and was **never merged**; `main` is exposed.
- **Status:** the exact binding refuses it (`UNSUPPORTED_ENVELOPE`, tested in app, SDK and parity suites); default
  `off` still accepts it. Either enforce M2 or merge the F-01 commit on its own.

## D-1 (resolved behind the flag)

A batch carrying the exact call: legacy app = DONE (containment); SDK `OFF` = INDETERMINATE
(`UNSUPPORTED_TRANSACTION_ENVELOPE`) without a call trace. With the shared exact binding on both sides the verdicts
agree: a pinned MetaMask envelope binds (`WALLET_BATCH_EXACT`) with identical amounts, and the T-1 and F-01 shapes
are refused or left unverified by both (`sdk-app-purchase-verification-parity.test.ts`, "enforce / EXACT").

## M2 trust assumptions that remain

1. **Pinned contract semantics.** MetaMask DelegationManager `0xdb9b…dB3` and EIP7702StatelessDeleGator `0x63c0…E32B`
   behave as their verified source (Sourcify exact match on Base; identical code on Robinhood and Arbitrum after
   masking the chain id and EIP-712 domain hash): executions run in order, default mode reverts on any failure,
   empty permission contexts execute on the caller. Neither contract is a proxy. The DelegationManager owner can
   pause it (redemptions then revert); that cannot make a wrong transaction pass.
2. **Historical state honesty.** The wallet's code and nonce at the previous block come from the operator's RPC;
   a lying RPC could fake them (the same RPC already supplies the receipt). Unreadable state never passes.
3. **Nonce accounting.** A code change needs a valid EIP-7702 authorization, which always increments the authority's
   nonce; the check relies on that consensus rule.
4. **No callbacks into the wallet.** Within the built call, a token that calls back into the wallet (ERC-777-style
   hooks) would run pinned wallet code, which only executes calls it is asked to; BAG's assets are plain ERC-20s.
   A DIRECT transaction from a wallet with another delegate is not pinned (its code does not run unless called back).
5. **Transfer-sum accounting itself.** With siblings excluded, the app still credits Transfer logs to the wallet
   inside the built call; correctness of those amounts rests on the Composer program BAG built and on the token
   contracts. `DELIVERY_LOG` (M3) moves that measurement inside the program.
6. **Approvals.** Accepted approvals do not move tokens; they are limited to the built (token, spender, amount).
7. **Compatibility, not security:** other EIP-7702 implementations, ERC-4337 bundles, try mode and user-raised
   approval caps are refused (`docs/runbooks/WALLET_BATCH_BINDING_SHADOW.md`, known limits).

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
