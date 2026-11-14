# Runbook: `BAG_SDK_COMPOSER_COMPILE` shadow on staging (M3a)

Scope: the SDK cross-check of the Composer **purchase** compile (`lib/blockchain/composer-sdk-compile.ts`). It does
not change what users sign. Design and tests: `docs/architecture/M3_PURCHASE_SLICE_PLAN.md` §3.5.

## 1. Live qualification already done (2026-11-14, read-only, nothing signed)

`scripts/audit/m3a-shadow-qualify.ts` runs real Composer compiles through the app's legacy adapter and cross-checks
them with the SDK exactly as shadow does, using the reviewed pins. Evidence: `evidence/m3a-shadow/`.

| Check | Robinhood (4663) | Base (8453) |
|---|---|---|
| Factory `0xaceb3bb6…bdae` live runtime keccak = pin `0xb3a1317e…cac5` | PASS (block 114237870) | PASS (block 57388576) |
| Factory runtime embeds VM `0xa9f22b95…11fd` | PASS | PASS |
| ERC-20 purchase, deployed proxy (target = proxy) | MATCH (USDG → 2 legs) | MATCH (USDC → 2 legs, USDC → 3 legs) |
| Native-ETH purchase, deployed proxy | MATCH | MATCH |
| Same four, fresh signer (first use: target = factory) | MATCH ×2 | MATCH ×3 |
| Composer calls per purchase (legacy + SDK) | 1 | 1 |
| Negative control: wrong code-hash pin | REFUSED `ACCOUNT_DEPLOYMENT_MISMATCH` | same |
| Negative control: one calldata byte changed | MISMATCH `TX_DATA` | same |
| Dead RPC | REFUSED `RPC_READ_FAILED` in 5 ms | — |
| Hanging RPC (3 s deadline in the script; 10 s in the app) | UNAVAILABLE `TIMEOUT` at 3.0 s | — |

MATCH means: same request body (except the flow id), and identical transaction target, calldata, value and chain,
user proxy, approvals (token, spender, amount) and every leg's expected and minimum output.

Not covered by this run: Arbitrum (pin not release-approved; do not set its pin or enable it), Ethereum (no reviewed
Composer pin), real buyers' wallets and amounts, a purchase where the buyer accepted a price-impact limit (unit-tested
only), sustained RPC load.

### 1b. Wider unsigned sample (2026-11-14)

`--sample N --seed 20261114`: generated **unsigned quotes, not transactions** (Robinhood and Base alternating;
stablecoin or native-ETH input; 1 to 4 legs; $1 to $50 or 0.0003 to 0.01 ETH; half with a fresh signer). Three runs
(50 + 50 + 30 = **130 quotes**, `evidence/m3a-shadow/m3a-shadow-sample*`):

| Outcome | Count |
|---|---|
| MATCH | 124 |
| REFUSED `SLIPPAGE_EXCEEDED` (SDK) | 5 |
| Composer simulation refusal before any check (legacy refuses too) | 1 |
| MISMATCH, UNAVAILABLE, extra Composer call | 0 |

The refusals are intermittent (the same 30 configurations gave 30/30 MATCH in run 3). The one with leg detail: a
cbBTC leg with a simulated estimate of 3768 raw units and an on-chain minimum of 3729, while the SDK requires
`floor(3768 × 0.99) = 3730`: one raw unit, i.e. rounding or a quote-versus-simulation difference, not a looser floor.
**Gate for `on` (not for shadow):** at about 4 % such purchases would fail under `on`. Decide before `on`: keep it
(the buyer retries), or let the SDK check tolerate one raw unit below the floor; collect the shortfall per refusal in
shadow first.

## 2. Staging configuration (owner applies; not applied by this work)

```
BAG_SDK_COMPOSER_COMPILE=shadow
COMPOSER_FACTORY_ROBINHOOD=0xaceb3bb6c75488b5b806b9de4dcf78814465bdae
COMPOSER_FACTORY_CODE_HASH_ROBINHOOD=0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5
COMPOSER_FACTORY_BASE=0xaceb3bb6c75488b5b806b9de4dcf78814465bdae
COMPOSER_FACTORY_CODE_HASH_BASE=0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5
# Arbitrum and Ethereum: leave unset. Their purchases then log UNAVAILABLE NO_REVIEWED_DEPLOYMENT in shadow.
```

Values come from `docs/SDK_DEPLOYMENT_PIN_ROBINHOOD.md` (approved 2026-10-30) and `docs/SDK_DEPLOYMENT_PIN_BASE.md`
(approved 2026-11-04). Never copy them from a Composer response. The app's RPC (`ROBINHOOD_RPC_URL`, `BASE_RPC_URL`)
must serve `eth_getCode` and `eth_call` at the latest block.

## 3. Before switching staging to shadow

1. The deployed branch contains M3a (it is stacked on M2 and the F-01 fix; see the merge order in `docs/STATUS.md`).
2. Re-run the qualification from the staging host's network with its own env:
   `npx tsx --env-file=<staging env> scripts/audit/m3a-shadow-qualify.ts --out <dir outside the repo>`; every case
   MATCH, pins PASS.
3. Log collection captures `[sdk-compile-shadow]` lines (chain, legs, verdict, codes; no wallet, amounts, calldata).

## 4. In shadow: acceptance for `on`

Over a sample of real staging purchases on each chain (suggested: at least 50 per chain, including native-ETH ones):
zero `MISMATCH`, zero unexplained `REFUSED`, `UNAVAILABLE` only `NO_REVIEWED_DEPLOYMENT` on unpinned chains. Any
`REFUSED ACCOUNT_PROXY_MISMATCH` or `UNTRUSTED_*` is a security event: inspect the compile before anything else.
Watch purchase-creation latency (the check adds about 5 to 7 RPC reads).

## 5. Rollback

`BAG_SDK_COMPOSER_COMPILE=off` (or unset). Nothing is persisted by the check.
