# Configured local DCA trial

The app entry point is `/dashboard/dca`. See [setup, supported profile and trust limits](../../../docs/DCA_LOCAL_TRIAL.md).

This directory reuses the qualified fork boundary, public development accounts, SmartSession vendor artifacts and ArbSys read model from `../usdg-composer`, and wire normalization from `../usdg-recurring`. Both parent research PRs are required. It introduces no wallet signing, public deployment or live keeper.

`ConfiguredPurchase.sol` accepts a budget, gross amount and interval, and pins the initial validated 40/30/30 Composer profile for that amount. Outputs use fixed positive initial quantity floors; this is not an oracle or a general VM verifier. The account and EntryPoint remain local models. The inherited router/facet/proxy trust assumptions apply.

The app writes `request.json` before starting the runner. To repeat it directly with current live quotes:

```powershell
node scripts/research/dca-trial/run.mjs --config artifacts/dca-trial/<id>/request.json --env-file C:/path/to/.env.local --out C:/path/to/new-results
```

Fresh output directories are required. Fork state and quote results can change. The chosen interval is applied to actual local block timestamps with synthetic time advances; it is not an observation over real days/weeks. An unsupported route or expired quote stops execution and must not be reported as success.

Current requests must include an explicit `settings.purchases` string (1–20), and `budget` must equal `amount × purchases`. For example 5 purchases × 5 USDG requires exactly 25 USDG. The same pure validation runs in the form, API and runner. A sample current request is `examples/exact-total.json`; pass it to `--config` to try fresh quotes. Its date preview is illustrative; the execution schedule is recalculated from the fork snapshot.

The original `evidence/ui-request.json` and `fractional-request.json` are historical records from before explicit-count validation. They contain unused budget and are no longer valid input. They have not been silently rewritten to look like current measurements. Historical result files retain their original source hashes and scope.

The UI's preview uses the current wall clock; `results.json.policy.start` and `periodSeconds` record the fork's actual schedule. Raw quotes, local receipts, full call traces, balances, source hashes and checks are kept in the output directory.

Only configured RPC/API variables are selected from the environment file. Credentials and user keys are never included in request or result files. No public submission method is forwarded. Existing research licenses remain in the sibling vendor directory.
