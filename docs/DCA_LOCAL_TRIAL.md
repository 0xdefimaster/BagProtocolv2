# DCA tab: local trial

An isolated app experiment at `/dashboard/dca`. It does not activate live purchases, request wallet signatures, deploy contracts publicly or update BAG positions.

## Try it

Use the DCA trial branch, including research PRs #123 and #124. Node 24 and the committed root lockfile are required.

```powershell
npm ci
npm run build --prefix packages/bag-sdk
$env:NEXT_PUBLIC_DCA_TRIAL = 'true'
$env:BAG_DCA_TRIAL = 'true'
# Only when credentials are in another checkout; otherwise .env.local is used:
$env:BAG_DCA_ENV_FILE = 'C:\Users\ilife\Desktop\BagProtocolv2\.env.local'
npm run dev:webpack -- --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000/dashboard/dca`. The DCA navigation entry appears only in development with the public flag. Both flags, development mode and local same-origin requests are required to start or inspect a worker. Production builds cannot run it even if flags are accidentally enabled.

Select the **local reference** basket explicitly, or select a live Bag from the existing registry. No fake Bag is inserted in the database. An unsupported live Bag is never replaced with the reference. The worker snapshots the server's current strategy definition and binds its hash to the local policy.

Choose:

- Total USDG budget, up to 1,000 USDG for this trial.
- Gross amount per purchase, at least 1 USDG and the selected Bag's minimum investment.
- Interval: 1–365 minutes, hours, days or weeks.

The budget must cover 1–20 whole purchases. `floor(budget / amount)` determines their number; any remainder stays unused. The first purchase is due after one interval. The preview shows the first/last scheduled dates. The fork records its own start and timestamps from the chain snapshot; it does not wait days/weeks in wall-clock time.

Press **Run local trial**. It starts one local child process and polls its actual progress. Initial Solidity compilation and quotes can take several minutes. Only one trial runs at a time, with a 20-minute process limit. Form fields are locked during a run; progress is not an invented percentage.

## Supported basket and economics

The qualified compiler profile supports Robinhood chain 4663, USDG input, **40% WETH / 30% cbBTC / 30% USDG**, and no BAG performance fee. Addresses, decimals, runtime code, 34 VM instructions, 17 state slots, routers and selectors are constrained. Unknown compiler shapes/routes stop the trial.

Example: budget **25 USDG**, purchase **10 USDG**, interval **1 day**:

- Two purchases. Each swaps 7 USDG and reserves 3 USDG as the Bag's cash allocation.
- 14 USDG total swap inputs, including swap route fees.
- 11 USDG remains: 6 USDG reserved cash allocation plus 5 USDG unallocated remainder.
- Maximum temporary USDG allowance is 7 USDG per purchase, reset to zero atomically.

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

- 39 focused unit/component/API/navigation checks passed; the existing app header navigation check passed as part of that set.
- Full app TypeScript check and SDK build passed.
- Browser-started trial: 25 USDG budget, 10 USDG gross, one-day interval; 2 actual local Composer executions and SDK receipt verifications; **27 PASS / 0 FAIL**. Final USDG 11 = cash reserve 6 + unused remainder 5.
- Separate fractional trial: 27.250001 USDG budget, 12.500002 USDG gross, two-hour interval; 2 executions and SDK receipt verifications; **27 PASS / 0 FAIL**. Total swap inputs 17.500002, cash reserve 7.500002, unallocated remainder 2.249997; final USDG 9.749999.
- Both runs used the final runner/guard hashes recorded in `scripts/research/dca-trial/evidence/`. The fractional case exercises largest-remainder allocation down to the USDG base unit.
- Browser request → local child process → progress polling → real success summary was exercised on loopback. Production-mode route rejection was checked in tests. A full production Next build was not run.

These are local simulations, with zero public transactions. They are not evidence of days of unattended service or native MetaMask/Rabby onboarding.
