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

## F-01 (HIGH in the default mode until this fix): calldata of the built call sent to a contract that never runs it

- **Root cause:** the default binding (`isWalletRoutedBatch`, `lib/blockchain/composer-status.ts`) accepted any
  transaction from the wallet whose calldata starts with the `redeemDelegations` selector and contains the built
  call's bytes, **whatever its target**. Containment of bytes was treated as proof of execution.
- **Exploit (owner-crafted, reproduced in tests before the fix):** the wallet sends that calldata to a contract of its
  own; the contract never runs the Composer call and transfers output tokens (which the owner funded) to the wallet.
  `trackComposerTransaction` returned `DONE` with those outputs; `verifyExecution` booked a purchase at the full
  deposit although the deposit never left (`lib/blockchain/__tests__/f01-forged-envelope.test.ts`,
  `composer-tx-search.test.ts` "F-01", `purchase-execution.test.ts` "F-01", all red on the unfixed code).
- **Impact:** ledger integrity, and a third-party economic effect: a fabricated cost basis can be timed against price
  moves (deliver tokens bought cheaper after the quote), creating a booked loss and loss carry that reduce the
  performance fees the Bag's creator is owed on later gains. No fund theft; requires the wallet owner.
  Sales: a forged sale must still move every sold token out (the flow requires it) and a fee sale needs the
  attested `Settled` event, so the sale path is narrower; the same pin applies.
- **Fix (default mode, no flag, 2026-11-14):**
  1. `redeemDelegations` envelopes bind only when sent to the chain's pinned DelegationManager
     (`trustedDelegationManagers`, from the SDK's `TRUSTED_SMART_ACCOUNTS`; none on Ethereum). Applied in
     `trackComposerTransaction` and in `findComposerTransactionFromWallet`.
  2. A Composer purchase paid with an ERC-20 must show the whole swapped deposit leaving the wallet in the same
     transaction (`composerDepositLeftWallet`, `lib/server/purchase-execution.ts`); otherwise nothing is booked.
  Not taken from the historical `7a62dd0` patch: its switch of the output floor to the provider's swap-boundary minimum,
  which contradicts the later rule that `providerEnforcedMinOutputRaw` never changes verification (tested).
- **Compatibility:** MetaMask v1.3.0 accounts can only use the pinned DelegationManager (their implementation's
  `executeFromExecutor` accepts no other caller), self-call batches and direct calls are unchanged, and a real
  Composer purchase always pulls its ERC-20 deposit from the wallet. Already-booked intents are not re-verified.
  Historical BAG transactions could not be replayed in this session (database access not authorized): see D below.
- **Residual in the default mode** (closed only by `BAG_WALLET_BATCH_BINDING=enforce`): a self-call envelope run by
  a wallet's own unpinned EIP-7702 code (it can interpret calldata its own way), a native-ETH deposit (no Transfer
  log to check), and T-1 sibling calls (pinned by "KNOWN GAP in the default mode" in the parity matrix).

## T-2 (MEDIUM, open): the app signs the Composer target and approval spender the API returns

- **Where:** `buildComposerPurchase` and the sale / rebalance builders (`lib/blockchain/lifi-composer-adapter.ts`)
  check an approval's address format and that its amount does not exceed the input, but compare neither
  `transactionRequest.to` nor the approval spender with a reviewed per-transaction allowlist. The Composer factory
  code hash is checked only as a chain-readiness gate (`lib/blockchain/chain-readiness.ts`).
- **Impact:** a wrong or compromised Composer API response would be presented for signature: an approval of up to
  the purchase input to an arbitrary spender, or a call to an arbitrary target. Bounded by the approval cap and by
  what the wallet shows; depends on trust in LI.FI's API.
- **Already solved in the SDK:** `compileBag` enforces caller-owned `allowedTransactionTargets` and
  `allowedApprovalSpenders`, and the README requires deriving the account from a reviewed deployment
  (`resolveLifiComposerAccount`), never from `transactionRequest.to` / `userProxy`.
- **Plan:** M3a (`docs/architecture/M3_PURCHASE_SLICE_PLAN.md`) moves the app's compile onto that check, behind a
  flag and a byte-identity shadow. Not changed in this session (it changes what the app is willing to present).

## D-1 (resolved behind the flag)

A batch carrying the exact call: legacy app = DONE (containment); SDK `OFF` = INDETERMINATE
(`UNSUPPORTED_TRANSACTION_ENVELOPE`) without a call trace. With the shared exact binding on both sides the verdicts
agree: a pinned MetaMask envelope binds (`WALLET_BATCH_EXACT`) with identical amounts, and the T-1 and F-01 shapes
are refused or left unverified by both (`sdk-app-purchase-verification-parity.test.ts`, "enforce / EXACT" and the
decision parity matrix).

## Shared decision model

`@bagprotocol/sdk` `VerificationDecision` = `ACCEPTED` | `REJECTED` | `INSUFFICIENT_EVIDENCE`
(`purchaseReceiptDecision`, `walletExecutionDecision`; the app's `composerOutcomeDecision`). The app's `PENDING` and a
missing RPC endpoint, and the SDK's `INDETERMINATE`, are `INSUFFICIENT_EVIDENCE`; `FAILED` is `REJECTED`; anything
unknown is never `ACCEPTED`. The parity matrix runs 13 scenarios through both verifiers (enforce / EXACT) and requires
equal decisions; the only intended difference is F-01 (app `REJECTED`, SDK without a trace `INSUFFICIENT_EVIDENCE`:
neither accepts).

## M2 independent review (second pass, 2026-11-14)

| # | Assumption | Classification | Evidence / note |
|---|---|---|---|
| 1 | EIP-7702 delegate identification (designator `0xef0100‖delegate` at the previous block) | Independently verified (format, on-chain reads) | `checkWalletExecutionState`; real Base batches show the designator of the pinned implementation |
| 2 | DelegationManager identity | Independently verified | pinned address; the implementation's immutable `delegationManager()` read on three chains |
| 3 | ERC-7579 canonical decoding | Independently verified against the verified source; test-covered (mutation-checked) | real MetaMask Base batches decode canonically |
| 4 | `redeemDelegations` self-authorized vs delegated contexts | Verified through a trusted dependency (Sourcify-verified DelegationManager source); test-covered; **self-authorized path not yet observed on chain** | only relayer (delegated) DelegationManager transactions were observed; shadow must confirm MetaMask's self-path encoding |
| 5 | Execution modes: only default; try refused | Independently verified against source; test-covered | try mode swallows failures in `executeFromExecutor` / `execute` |
| 6 | Approval ordering and amounts | Test-covered; ordering deliberately free (an approve cannot move tokens; a misordered batch reverts) | amounts must be the built (token, spender) and ≤ the built amount |
| 7 | Duplicate built calls and siblings refused | Test-covered (app, SDK, parity, real-data regression), mutation-checked | default mode: siblings still accepted (known gap) |
| 8 | Transaction/receipt binding | SDK: canonical block anchoring and confirmations; app: receipt and transaction by hash from one RPC | app trusts its RPC for inclusion (unchanged legacy behavior) |
| 9 | Historical block state and nonce rule | Verified through a trusted dependency (EIP-7702 consensus rule: valid authorizations increment the nonce) | unreadable state is INSUFFICIENT_EVIDENCE (app: PENDING), never a pass |
| 10 | RPC trust and failure behavior | Unverified beyond fail-closed tests: a lying RPC can fake receipts and state alike | same trust as every receipt-based check |
| 11 | SDK ↔ app consistency | Test-covered: decision parity matrix (13 scenarios) | one intended non-accepting difference (F-01) |
| 12 | Composer-internal transfers contaminating accounting | **Unverified.** With siblings excluded, remaining contamination sources are the built program itself and refunds back to the wallet (gross sums would overstate a purchase's spend or a sale's sold amount; rebalances already use net flows) | the replay tool measures `depositRefunded` / `soldTokenRefunded`; `DELIVERY_LOG` (M3) removes the dependency |

**Fixed in this pass (enforce/EXACT only, default unaffected):** a DIRECT transaction now also requires the wallet's
code to be a plain EOA or the pinned delegate, unchanged in the block. A direct call runs wallet code whenever it
sends ETH back (native sales, refunds): an unpinned delegate's `receive()` could add transfers there (T-1 by callback).
Shadow logs no longer carry the full transaction hash (10-character `txRef` plus the internal `intentId`) and log each
transaction and verdict once per process (bounded set).

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
4. **Callbacks into the wallet.** Only plain EOAs and the pinned delegate (empty `receive()`) are accepted, for envelopes
   and direct calls alike; BAG's assets are plain ERC-20s without receiver hooks.
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
