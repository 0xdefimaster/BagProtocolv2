# Changelog

## 0.3.0 — 2026-10-30

This candidate contains changes after the npm 0.2.1 publication. bag.json v1 definition, normalization, hash domain and allocation semantics remain frozen.

- Enforce minimum investment, registry preflight and SDK-profile JSON Schema.
- Verify submitted purchases against the original compiled call, explicit reviewed wallet minima and actual transaction-scoped balance evidence, including qualified Geth and Robinhood Nitro readers.
- Independently resolve Composer wallet accounts from a reviewed deployment pin; bind transaction targets, proxies, output ownership and approval spenders.
- Enforce returned slippage floors and full input budgets including retained shares; stop requested failed registry verification.
- Preserve quote timing/deadlines, actual fee recipient addresses and structured provider warnings; reject known expired quotes.
- Add stable SDK-owned error codes, safe diagnostic summaries and bounded/cancellable strategy HTTP retrieval.
- Add the independent public-package consumer starter and clean tarball installation checks.
- Refuse a provider answer with two approvals to the same spender, and report `INVALID_TARGET` from `simulateBag` when the transaction target has no contract code instead of a misleading `OK`.
- Pass LI.FI Composer's signed price impact through unchanged with its USD valuation (`PurchaseQuote.priceImpactUsd`). A negative (favorable) impact from that adapter is accepted when the USD values are finite, the output is above the input, nothing is unpriced, and the value is within ±1 bps of the USD ratio (an observed-behavior compatibility tolerance, not LI.FI's documented formula). Other providers still refuse negative values.
- Add `selectExecutionPath`, a pure rule table choosing how a wallet pays (native, direct, atomic EIP-5792 batch, Permit2 relayed/self, sequential) with stable reasons for every path, and `hasAtomicBatchCapability` for reading `wallet_getCapabilities`.

### Integration changes

- Node >=24 is the declared runtime baseline. Tested peers are Composer/spec 0.11.3, viem 2.56.0 and TypeScript 5.9.3.
- Provider legs require positive expected and minimum output; the minimum must satisfy the configured integer slippage bound.
- Simulation can return QUOTE_EXPIRED and INVALID_TARGET. Applications with exhaustive status handling must handle both.
- `SimulationClient` now requires `getCode` (a viem PublicClient has it). Approval spenders are not code-checked: Composer's first purchase approves a proxy that is not deployed yet.
- Public quotes now carry local timing, an optional known provider deadline, normalized fee addresses and warnings. Custom providers may omit the new metadata.
- SDK-owned ProviderResponseError / PurchasePlanError retain their identities and add stable codes. Account RPC failures are sanitized as RPC_READ_FAILED; use getSdkErrorInfo for display. Upstream Composer typed errors remain upstream errors.
- fetchBag now has a default 15-second request/body deadline; callers can set timeoutMs and AbortSignal.
- `quote.priceImpactBps` can be negative for LI.FI Composer quotes. `maxPriceImpactBps` applies in both directions (`|impactBps| ≤ maxPriceImpactBps`); a larger favorable gap fails with PRICE_IMPACT_EXCEEDED.

Release gates closed on 2026-10-30:
- the production factory policy was confirmed;
- the Robinhood deployment pin was approved;
- a live signed purchase was VERIFIED against its original intent (Robinhood Chain, tx `0xec6df6cf…0209`; `docs/SDK_RELEASE_PREPARATION.md`).

Purchase receipt verification is qualified on Robinhood Chain only (README, Chain support).

## 0.2.1 — published 2026-10-20

Observed on the public npm registry on 2026-10-22: latest=0.2.1, gitHead=545dd77c073f8c5ac0df040a6fc0753097fc58ff. These registry metadata identify the published package; they do not imply that later main-branch work is published.
