# Changelog

## 0.3.0 — unreleased candidate

This candidate contains changes after the npm 0.2.1 publication. bag.json v1 definition, normalization, hash domain and allocation semantics remain frozen.

- Enforce minimum investment, registry preflight and SDK-profile JSON Schema.
- Verify submitted purchases against the original compiled call, explicit reviewed wallet minima and actual transaction-scoped balance evidence, including qualified Geth and Robinhood Nitro readers.
- Independently resolve Composer wallet accounts from a reviewed deployment pin; bind transaction targets, proxies, output ownership and approval spenders.
- Enforce returned slippage floors and full input budgets including retained shares; stop requested failed registry verification.
- Preserve quote timing/deadlines, actual fee recipient addresses and structured provider warnings; reject known expired quotes.
- Add stable SDK-owned error codes, safe diagnostic summaries and bounded/cancellable strategy HTTP retrieval.
- Add the independent public-package consumer starter and clean tarball installation checks.
- Add recurring (DCA) authorizations for RecurringPurchaseExecutor: EIP-712 Authorization/Revocation typed data and id, the executor's leg split and price-limit minimums, calendar windows, typed-data decode/compare and the executor ABI. The signed asset list (address, symbol, decimals, weight) must rebuild the BAG's registered compositionHash; the executor enforces the same rebuild on chain (CompositionMismatch). `verifyRecurringPurchase` binds the mined call to the prepared intent (or labels a decoded-call binding as weaker), re-checks the plan against the authorization, and confirms the source debit, recipient deliveries and zero executor/router residue from transaction-scoped balances (FAILED/INDETERMINATE when they do not hold or cannot be read). Summaries disclose that the per-asset max price is a fixed cap, not market slippage protection (windows above it are skipped, not caught up, and the plan may end underspent), and that each run still needs a planSigner signature and a keeper transaction (planSigner cannot exceed the signed limits but can stop or delay purchases). Each run applies the bag.json v1 rules (valid document, minInvestment, BLOCK no-route policy); strategies with a performance fee are refused in this version.
- Add `@bagprotocol/sdk/uniswap-v3`: a Composer-free run builder from QuoterV2 eth_call quotes (no HTTP, no API key), bounded by the owner's signed price limit, producing an unsigned BagExecutionRouter plan.

### Integration changes

- Node >=24 is the declared runtime baseline. Tested peers are Composer/spec 0.11.3, viem 2.56.0 and TypeScript 5.9.3.
- Provider legs require positive expected and minimum output; the minimum must satisfy the configured integer slippage bound.
- Simulation can return QUOTE_EXPIRED. Applications with exhaustive status handling must handle it.
- Public quotes now carry local timing, an optional known provider deadline, normalized fee addresses and warnings. Custom providers may omit the new metadata.
- SDK-owned ProviderResponseError / PurchasePlanError retain their identities and add stable codes. Account RPC failures are sanitized as RPC_READ_FAILED; use getSdkErrorInfo for display. Upstream Composer typed errors remain upstream errors.
- fetchBag now has a default 15-second request/body deadline; callers can set timeoutMs and AbortSignal.

Production factory policy confirmation, final deployment approval and a newly signed purchase verified against its ORIGINAL intent remain release gates. This changelog does not claim live purchase proof or npm publication.

## 0.2.1 — published 2026-10-20

Observed on the public npm registry on 2026-10-22: latest=0.2.1, gitHead=545dd77c073f8c5ac0df040a6fc0753097fc58ff. These registry metadata identify the published package; they do not imply that later main-branch work is published.
