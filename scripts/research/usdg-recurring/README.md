# Recurring USDG basket policy — isolated fork experiment

An opt-in research extension to `../usdg-composer`. It replaces the **one reviewed calldata hash** model with one fixed policy that accepts freshly compiled Composer programs matching a narrow on-chain profile. Production SDK/app code, `bag.json`, dependencies and release gates are unchanged.

## What this implements

- Robinhood chain 4663, **40% WETH / 30% cbBTC / 30% USDG**, 10 USDG gross per purchase, ten purchases maximum, 100 USDG gross lifetime budget. cbBTC is explicitly not WBTC.
- One logical owner policy/session grant. Subsequent programs use the session signer; there is no owner review or backend signature for each new quote. The local setup still contains several owner transactions for deployment, executor installation and session enablement. **A single MetaMask popup onboarding flow is not implemented.**
- A fixed start, interval, expiry, at most one execution in a time window **and a full interval since the previous success**. Missed windows cannot be claimed in a burst. Failed execution does not consume the policy budget or time slot.
- Only the account can invoke the guard. Upstream SmartSession permits that account to call this particular guard's `run(address,bytes)` action. It grants no direct token-transfer, approval, arbitrary-executor or guard-management action.
- Per execution: approve exactly **7 USDG** to the independently predicted Composer proxy, execute, reset approval to zero, verify exactly 7 USDG net input spent and both output balance increases. The 3 USDG cash share accumulates as a reserve that later purchases cannot spend.
- Owner-only pause and irreversible revocation. The account owner retains withdrawal authority. Revocation stops future guarded executions; it cannot reverse completed swaps or eliminate smart-contract risk.
- Fixed, positive **minimum quantities received**, chosen once at policy creation. The runner uses 99% of the initial quote's already slippage-adjusted minima and records the exact quantities. This is an explicit demo price ceiling, **not a live oracle or a continuously recalculated slippage guarantee**. If a later quote falls below these floors, execution stops; the keeper cannot lower them.

## On-chain program checks

`RecurringPurchase.sol` accepts only the recorded 34-instruction VM profile and 17 state slots. It checks the full canonical ABI encoding, the exact basket definition hash, input amounts, partition payload hash, approval recipient/amounts, sweep recipient, context and constant resource slots. Additional/replaced instructions or state are rejected. The definition is fixed to the entire example `bag.json` definition, including its rules; a different strategy/version needs a new supported profile and authorization.

Only the two generic-swap state entries may carry new quote/route data. Their ABI encoding is decoded and checked: fixed USDG inputs and leg amounts, fixed WETH/cbBTC outputs, predicted proxy receiver, positive owner-approved floors, exactly two route steps, one exact fee payload followed by one explicitly permitted router/selector pair. The supported pairs are:

| Router | Selector |
| --- | --- |
| `0x603206D6105217DD972E4Ab30676A220CA393346` | `0x3f0bde25` |
| `0x8E6fD69A77e88ee20Ba4B4fBd59DfCDA3EC0E98A` | `0x5f3bd1c8` |

No automatic admission of new compiler shapes, routers or fee destinations occurs. Unsupported routes stop the experiment. The route's inner payload remains opaque; it is constrained by the router/selector, exact input authorization and atomic output postconditions. **This is not a full audit of router semantics, a universal VM verifier or proof of economically optimal execution.** Factory/token/helper/router runtime hashes are pinned at policy deployment and checked each run. Bytecode pins alone do not freeze storage, diamond facets, proxy implementations, allowlists or upstream governance; those remain trust assumptions.

`wire.mjs` performs two explicit research transformations before validation/execution:

1. Replace the compiler-generated context with a policy/account/definition-specific constant, required by the guard. The same context is exercised across ten distinct programs; this is an empirical profile qualification, not a guarantee for other VM versions.
2. On the local fork, remove a canonical first-use factory envelope when the proxy already exists locally. The live API still sees the account as undeployed on the public chain. The VM program is otherwise preserved. Both remote and local account addresses are resolved independently, and SDK `compileBag` validates the resulting local envelope against local trust.

The source of the private VM implementation was unavailable for review. The pinned profile and measured postconditions deliberately limit the claim. The LI.FI swap ABI reference is [GenericSwapFacetV3](https://github.com/lifinance/contracts/blob/main/src/Facets/GenericSwapFacetV3.sol); current upstream source is explanatory and is not a deployment-source equivalence assertion.

## Run

Requires this branch **including its parent PR #123**, Node 24, the repository's committed lockfile, a built SDK and read-capable Robinhood RPC/Composer credentials. No new dependencies are added.

```powershell
npm ci
npm run build --prefix packages/bag-sdk
node scripts/research/usdg-recurring/run.mjs --env-file C:/path/to/BagProtocolv2/.env.local
```

The configuration helper reads only Composer/RPC entries and never user private keys. See [the shared fork boundary](../usdg-composer/README.md) for exact variables, public dev keys, public-holder impersonation, the read-only upstream proxy and the qualified local ArbSys read model. No public transaction or real-funds operation is performed. Token/Composer bytecode and token storage are not replaced. This is not a Nitro gas-cost benchmark.

`--repo C:/path/to/prepared-checkout` selects dependencies and SDK build from another checkout. `--out C:/path/to/new-directory` selects a fresh output directory. The default is `artifacts/usdg-recurring/<timestamp>`. Do not install dependencies in this research subdirectory. Captured replay belongs to the older single-call runner; this recurring runner is qualified with fresh quotes.

## Evidence and interpretation

The successful result is `REAL_RECURRING_USDG_COMPOSER_FORK_EXECUTION_VERIFIED`, a zero failure count, ten distinct successful program hashes, ten SDK receipt verifications, 70 USDG spent, 30 USDG retained, lifetime budget 100 USDG and zero remaining proxy allowance. Inspect the recorded result rather than inferring success from this documentation.

Each `round-01` … `round-10` contains the raw Composer response, unsigned adapter result, normalized compiled intent, actual local receipt and full call trace. `results.json` records checks, timing, chain block/hash, dependency/source hashes, owner floors, contract pins, approval events, balances, counters, API versions/revisions and transactions. Test branches use EVM snapshots; transactions subsequently discarded by a snapshot are explicitly marked `revertedBySnapshot`, and are not the canonical ten-purchase sequence. Validation failures may revert the outer transaction; execution failures are checked through the inner operation result. A generic network failure is not counted as a passed rejection test.

The interval is **30 simulated seconds**, with synthetic clock advances. This is not ten days/weeks of observed unattended service. Fresh API compilation is real; accounting, schedule, signatures and swaps are exercised on the local fork. No persistent scheduler/keeper service is shipped. `INCOMPLETE` results preserve the failed stage and must not be reported as success.

## Remaining production qualification

1. Reviewed/audited permission, execution profile and router boundaries; define upgrade and deployment migration handling with LI.FI. The research factory pin remains unapproved for SDK defaults.
2. A supported production smart account, full EntryPoint/bundler and actual MetaMask owner flow; gas sponsorship, session storage, revocation and recovery UX.
3. A durable keeper with idempotency, quote freshness, monitoring and retry rules. A keeper cannot bypass these on-chain conditions.
4. A reviewed oracle policy if continuously varying price/slippage rules are required. Fixed output floors can stop filling as market prices change.
5. Production accounting, policy UI and long-duration qualification. Current SDK verification remains `NOT_BAG_ACCOUNTED`; no app position, cost basis, performance fee or P&L is created.

The measured result is a recurring-policy feasibility proof with real Composer execution. It is not authorization to deploy these research contracts or fund them on a public network.
