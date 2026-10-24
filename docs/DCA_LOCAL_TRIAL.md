# DCA tab: local trial

An isolated app experiment at `/dashboard/dca`. It does not activate live purchases, request wallet signatures, deploy contracts publicly or update BAG positions.

## Try it

Use the DCA trial branch, including research PRs #123 and #124. Node 24 and the committed root lockfile are required.

```powershell
npm ci
npm run build --prefix packages/bag-sdk
$env:NEXT_PUBLIC_DCA_TRIAL = 'true'
$env:BAG_DCA_TRIAL = 'true'
$env:BAG_DCA_PUBLIC_SOURCE = 'bagprotocol.com'
# Only when credentials are in another checkout; otherwise .env.local is used:
$env:BAG_DCA_ENV_FILE = 'C:\Users\ilife\Desktop\BagProtocolv2\.env.local'
npm run dev:webpack -- --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000/dashboard/dca`. The DCA navigation entry appears only in development with the public flag. Both flags, development mode and local same-origin requests are required to start or inspect a worker. Production builds cannot run it even if flags are accidentally enabled.

Select the **local reference** basket explicitly, or select a live Bag from the public catalog. The public-source mode reads only `https://bagprotocol.com/api/bags` and the selected version's public `bag.json`; it needs no Supabase key. If public-source mode is unset, the explicit local reference remains available. No fake Bag is inserted in the database. An unsupported live Bag is never replaced with the reference. The worker snapshots the selected strategy definition and binds its hash to the local policy. For a real Bag, the submitted expected version/hash must match the freshly verified server snapshot; otherwise HTTP 409 requires a reload.

Choose:

- Total USDG budget, up to 1,000 USDG for this trial.
- Gross amount per purchase, at least 1 USDG and the selected Bag's minimum investment.
- Number of purchases: an explicit whole number from 1 to 20.
- Interval: 1–365 minutes, hours, days or weeks.

The total budget must equal **purchase count × amount per purchase** exactly, down to USDG's six decimal places. Five purchases of 5 USDG with a total of 25 USDG is valid. A total of 30 USDG shows the expected 25 USDG and blocks submission; direct API requests are rejected with HTTP 400 too. Missing/fractional/zero counts are rejected. No unused budget is silently accepted.

The first purchase is due after one interval; the last is due after `count × interval` from setup. The preview derives both dates from the selected count and interval. The fork records its own start and timestamps from the chain snapshot; it does not wait days/weeks in wall-clock time.

Press **Run local trial**. It starts one local child process and polls its actual progress. Initial Solidity compilation and quotes can take several minutes. Only one trial runs at a time, with a 20-minute process limit. Form fields are locked during a run; progress is not an invented percentage.

## Supported basket and economics

The allocation model supports Robinhood chain 4663, USDG input, up to 10 distinct ERC-20 assets and an explicitly declared **0% BAG performance fee**. There must be at least one swap leg. Public definitions pass SDK parsing, validation and hash verification; on-chain token decimals are checked against the selected definition. Bags with unknown or nonzero performance fees are rejected because BAG profit-fee accounting is outside this trial.

`BasketPurchase.sol` replaces the runner's fixed two-output guard. Each owner-authorized template pins the full instruction hash, every non-swap state cell, context and per-token input amounts. Fresh quotes can change only the semantically checked swap payloads. Factory/proxy lifecycle, known VM opcodes/call targets, router selectors, fee payloads and dependency bytecode hashes remain constrained. Every token's output minimum is checked after execution, the exact USDG debit is enforced, and allowances return to zero atomically. Unknown compiler shapes/routes stop the trial.

The measured new case is the real **asdas (Fork), version 1**: AAPL 10%, ASML 26.01%, COIN 37.24%, GME 26.75%. Its definition hash is `0x5d6118dbe3072743e0997af5c2266c57a2775c71fc337e8fd82b97a92fc2fbb9`. Five purchases of 5 USDG each executed with all four actual tokens on a local fork, both directly and through the browser-started worker. Each run passed 38 checks and five SDK call-trace/balance receipt verifications. No reference-basket substitution was used.

The older reference remains useful for retained-USDG regression:

Example: budget **25 USDG**, purchase **5 USDG**, count **5**, interval **1 day**:

- Five purchases. Each swaps 3.5 USDG and reserves 1.5 USDG as the Bag's cash allocation.
- 17.5 USDG total swap inputs, including swap route fees.
- 7.5 USDG remains as reserved cash allocation; no unallocated budget.
- Maximum temporary USDG allowance is 3.5 USDG per purchase, reset to zero atomically.

The configured local guard enforces the selected amount, budget, number of purchases, minimum interval and expiry. It rejects changed programs, recipients, lower output floors, early/extra purchases, paused/revoked policies, and rolls back accounting/approvals after an execution failure. Different purchase amounts derive a new fixed profile from the initial validated compilation; fee payload and partition data are pinned for that policy.

Minimum output quantities are fixed once from the initial quote (99% of its already slippage-adjusted minima). They are **not a live oracle or a continuously recalculated price limit**. Later prices/routes may not meet these floors; a stop is an incomplete trial, never a fabricated success. Fresh API quotes still refer to public-chain conditions while the local fork uses accelerated timestamps, so time-sensitive routes can also stop an experiment.

## Evidence and privacy

Each run writes to `artifacts/dca-trial/<random-id>/`:

- `request.json`: selected settings, complete strategy snapshot and hash.
- `execution/results.json`: checks, source/dependency hashes, fork block/hash, counters, token balances and transactions.
- `round-NN/`: raw Composer response, adapter/compiled data, local receipt and full trace.

RPC and Composer credentials stay server-side. The research settings helper selects only the configured RPC/API entries from the supplied file. It uses public development keys and local public-holder impersonation, never the user's private key. A read-only RPC proxy blocks public submission methods. No original checkout or `.env.local` is modified by this feature.

The UI job list is in memory. Restarting development loses polling state; raw disk evidence remains. The trial has no durable scheduler, keeper service, BAG accounting or public deployment. The SDK source, purchase/sale/rebalance flows and bag.json format are not changed.

## Account-model limit

This tab deliberately exposes the **local ERC-7579 account/EntryPoint + SmartSession model** from #123/#124. It does not claim to implement the native MetaMask DelegationManager/Hybrid route examined separately. MetaMask/Rabby signature screens, a reviewed native BagPolicyEnforcer, funding/withdrawal/revocation UX and native USDG/Composer end-to-end qualification remain subsequent work.

The local ArbSys getter is an explicitly qualified research model. Token bytecode/storage are not replaced. This is not Nitro gas measurement, a general VM audit or a production security guarantee. Existing research licenses and trust limitations continue to apply.

## Recorded qualification (23 October 2026)

### 24 October allocation update

- Actual four-token BAG: 5 × 5 = 25 USDG, 38 PASS / 0 FAIL, both CLI and browser worker runs; all five receipts verified by SDK call trace and balance evidence.
- Retained-USDG reference regression under the new generic guard: 5 × 5 = 25 USDG, 38 PASS / 0 FAIL; 17.5 USDG swapped, 7.5 USDG reserved, zero remaining allowance.
- API rejects stale/missing expected hashes/versions, inconsistent totals and performance-fee Bags. No worker is launched for those rejections.
- Four- and five-output captured-wire fixtures test exact SDK input splits, template/context normalization and token/amount substitution rejection. The five-output wire fixture is from a fee-bearing Bag and is **not** an execution qualification or fee-accounting claim.
- Several other public Bags returned negative provider price-impact values that the current SDK rejects. The SDK validation was not weakened; these are unsupported quote observations, not successful executions.
- The 1–10 asset model is not a claim that every token, route, asset count or market condition has been execution-qualified. Fixed quantity floors, local account/session model and all earlier production limits still apply.

### Earlier measurements

- Current explicit-count validation: **53 focused unit/component/API/navigation checks passed**, including the exact 5 × 5 = 25 acceptance case, mismatched totals, missing/invalid counts, date derivation and direct API rejection. Full app TypeScript check passed. This validation change does not claim a new Composer execution measurement.
- Historical execution qualification below predates the explicit-count requirement. Its original result/request files remain unchanged; the old requests with unused budget are intentionally rejected by the current form/runner. Use a newly created exact-total request for a current trial.
- Initial qualification: 39 focused unit/component/API/navigation checks passed; the existing app header navigation check passed as part of that set.
- Full app TypeScript check and SDK build passed.
- Browser-started trial: 25 USDG budget, 10 USDG gross, one-day interval; 2 actual local Composer executions and SDK receipt verifications; **27 PASS / 0 FAIL**. Final USDG 11 = cash reserve 6 + unused remainder 5.
- Separate fractional trial: 27.250001 USDG budget, 12.500002 USDG gross, two-hour interval; 2 executions and SDK receipt verifications; **27 PASS / 0 FAIL**. Total swap inputs 17.500002, cash reserve 7.500002, unallocated remainder 2.249997; final USDG 9.749999.
- Both historical runs used the runner/guard hashes recorded in `scripts/research/dca-trial/evidence/`. The fractional case exercises largest-remainder allocation down to the USDG base unit.
- Browser request → local child process → progress polling → real success summary was exercised on loopback. Production-mode route rejection was checked in tests. A full production Next build was not run.

These are local simulations, with zero public transactions. They are not evidence of days of unattended service or native MetaMask/Rabby onboarding.
