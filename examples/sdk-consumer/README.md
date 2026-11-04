# BAG SDK starter — independent developer

A small Node / TypeScript (NodeNext) project that uses `@bagprotocol/sdk` the way an outside developer would:
- only the package's public imports and the dependencies declared below;
- no BAG frontend, backend, Supabase or database;
- no BAG server signing, and no private key;
- no default deployment pin.

Copy this folder anywhere and it works on its own.

## Release status (read first)

| Package | Status | What this starter uses it for |
|---|---|---|
| `@bagprotocol/sdk@0.3.0` | **Published** on npm (2026-10-30, `latest`) | `npm run quickstart` (parse / validate / hash) works with it directly |
| `@bagprotocol/sdk@0.4.0` | **Candidate, not published** | `package.json` pins it, for the full demo / prepare / sign / verify (adds delivery proof). Install it from a tarball (below) until it is published |

So today:
- `npm install` straight from npm cannot resolve `0.4.0`.
- Use the published `0.3.0` for the quickstart alone, or the tarball route for everything.

Exact dependency versions: `@bagprotocol/sdk 0.4.0`, `@lifi/composer-sdk 0.11.3`, `viem 2.56.0`, `typescript 5.9.3`,
`@types/node 24.19.0`. Node ≥ 24 is the supported runtime: every check below was run on **Node 24.22.2** (npm 11.19.1).

### Which SDK version do you need?

| You want to… | Minimum SDK | Published? | Notes |
|---|---|---|---|
| Validate, normalize and hash a `bag.json` offline (`quickstart.mjs`) | **0.3.0** | Yes (npm) | No network, no key |
| Compile a live LI.FI Composer purchase (unsigned) | **0.3.0** | Yes (npm) | Needs your LI.FI key, an RPC, and a reviewed deployment pin. Robinhood Chain only |
| Verify a receipt with a qualified tracing RPC (`ROBINHOOD_NITRO_TRANSACTION_INDEX` / `GETH_TRANSACTION_INDEX`) | **0.3.0** | Yes (npm) | Needs `debug_traceCall` with `txIndex` on the qualified node build; few public RPCs serve it |
| Verify a receipt from delivery logs (`DELIVERY_PROOF=1`, `DELIVERY_LOG`), with any RPC | **0.4.0** | **No: candidate**, tarball only | Release gate 3 was closed on a live Robinhood purchase on 2026-11-02; publication is a separate owner decision |
| Run this whole starter (`npm run build`: `local-sign.ts` imports `DELIVERY_PROOF_SIGNATURE`) | **0.4.0** | **No: candidate**, tarball only | With 0.3.0 from npm, use `quickstart.mjs` and your own code built from `src/purchase.ts` without delivery proof |

Adoption status: no independent third-party developer has completed a live integration with this starter yet.
Every live result referenced here was produced by the maintainer.

## Quickstart (5 minutes, published package, offline)

```bash
mkdir my-bag && cd my-bag
npm init -y && npm pkg set type=module
npm install --save-exact @bagprotocol/sdk@0.3.0 viem@2.56.0
```

Copy `quickstart.mjs` and `bag.example.json` from this folder into `my-bag`, then:

```bash
node quickstart.mjs bag.example.json
```

Expected output (the hash is fixed: bag.json v1 hash rules are frozen):

```json
{
  "status": "VALID",
  "chain": "ethereum",
  "assets": 2,
  "definitionHash": "0xe20192732fcf93465060bbcd43512fcb06cd486f37a939c2ff4801c88eebdad3",
  "hashMatchesValidation": true,
  "swapSlippageBps": 100,
  "warnings": [
    { "code": "DECIMALS_NOT_CHECKED", "path": "definition.assets" },
    { "code": "DRIFT_NEVER_TRIGGERS", "path": "definition.rules.rebalance" }
  ]
}
```

About this example:
- `bag.example.json` is the smallest valid v1 strategy: a single-chain `STATIC_BASKET` with two assets at 50/50.
- Its two addresses are **placeholders** (`0x…01`, `0x…02`). It is valid for validation only and is not executable.
  Replace them with real token addresses on one chain, and check decimals (`readTokenDecimals`) before any purchase.
- Both warnings are expected for this file.
- A strategy that breaks a rule exits with code 1. For example, weights of 60/50 give
  `{ "status": "INVALID_STRATEGY", "errors": [{ "code": "WEIGHTS_NOT_100", ... }] }`.
- A valid hash does **not** mean the assets are liquid or that a purchase can execute safely.

## Full starter from the 0.4.0 tarball

From a BAG repository checkout:

```bash
npm run build --prefix packages/bag-sdk
```

```bash
npm pack ./packages/bag-sdk --pack-destination /absolute/artifact/dir
```

Copy this whole folder outside the repository. In the copy:

```bash
npm install --ignore-scripts --no-audit --no-fund /absolute/artifact/dir/bagprotocol-sdk-0.4.0.tgz
```

```bash
npm run build
```

```bash
npm run demo
```

```bash
npm run quickstart
```

Expected `demo` output (one line):

```json
{"status":"OFFLINE_DEMO_OK","evidence":"SYNTHETIC_ONLY","receiptVerification":"VERIFIED","snapshotIntegrity":"CHECKED","httpDeadline":"HTTP_TIMEOUT","bodyDeadline":"HTTP_TIMEOUT","cancellation":"HTTP_ABORTED"}
```

The demo uses synthetic tokens, provider results and receipt evidence. It checks:
- preservation of the original snapshot and the reviewed minima;
- the BigInt round-trip;
- that a changed file is refused;
- receipt processing;
- the HTTP deadline and safe cancellation.

It never touches the network, asks for a signature or sends a transaction. Its `VERIFIED` is synthetic, **not** proof
of a live purchase.

## Configuration and the LI.FI API key

`.env.example` lists every variable, and contains no secrets. The quickstart and the demo need none of them.

Live `prepare` / `sign` / `verify` need:
- **`RPC_URL`**: your own RPC for the strategy's chain. A URL with an embedded key is a secret.
- **`LIFI_API_KEY`**: request a key from LI.FI (Composer documentation:
  <https://docs.li.fi/composer/composer-api/overview>).
  - Keep it on a server or in your local shell, never in browser code or a commit.
  - The SDK passes it only to the `lifiComposer` adapter; `getSdkErrorInfo` never prints it.
  - A missing or empty key fails with `COMPOSER_CONFIGURATION_INVALID` before any request.
- **`COMPOSER_FACTORY` + `COMPOSER_FACTORY_CODE_HASH`**: a deployment pin you reviewed yourself. There is
  deliberately no default.
  - Robinhood Chain: `docs/SDK_DEPLOYMENT_PIN_ROBINHOOD.md` in the BAG repository.
  - A wrong or changed factory fails with `ACCOUNT_DEPLOYMENT_MISMATCH`, before anything is compiled.

## Wallet signing boundary

- **The SDK never signs and never sends.** It parses and checks strategies, compiles an *unsigned* purchase, simulates
  it, and verifies receipts. No API takes a private key.
- **The user's own wallet signs.** `npm run sign` serves a page on `127.0.0.1`, and your browser wallet (EIP-1193)
  sends the exact approval and purchase transactions the Node process returns. In your own app, use
  `walletFromEthereum` / `submitWithWallet` from `src/purchase.ts` behind an explicit user action.
- **Approvals** are bounded to the planned input amount, and the only spender is the signer's own Composer proxy. A
  compile naming any other target or spender is refused (`UNTRUSTED_TARGET` / `UNTRUSTED_SPENDER`).
- **Retries.** Never send a purchase again because verification is `INDETERMINATE`. Re-run `verify` later.
- **Accounting.** Purchases made through this starter are `NOT_BAG_ACCOUNTED`: no BAG position, fee eligibility,
  P&L or redemption record is created.

## Errors and common integration failures

`getSdkErrorInfo(error)` returns a stable `{ code, message }` that is safe to log: it contains no URL, key or upstream
text. Detailed issues (`parsed.issues`, `validation.errors`, plan issues) are separate, structured fields.

| Symptom / code | Usual cause | Fix |
|---|---|---|
| `INVALID_BAG_JSON` (quickstart) | Wrong shape, unknown field, bad address | Read `issues[].path`; compare with `bag.example.json` or the schema `@bagprotocol/sdk/schema` |
| `INVALID_STRATEGY` / `WEIGHTS_NOT_100` | Weights do not sum to 10000 bps | Fix the weights |
| `DECIMALS_NOT_CHECKED` warning | No token metadata supplied | Pass `tokens` from `readTokenDecimals` before executing |
| `COMPOSER_CONFIGURATION_INVALID` | Missing or empty `LIFI_API_KEY`, bad endpoint or timeout | Set the key server-side |
| `ACCOUNT_DEPLOYMENT_INVALID` / `_MISMATCH` | No pin, wrong pin, or LI.FI rolled out a new factory | Re-review the pin; never disable the check |
| `CHAIN_MISMATCH` | The RPC is on a different chain from the strategy | Use an RPC for `definition.chain` |
| `UNTRUSTED_TARGET` / `UNTRUSTED_SPENDER` | The compile names a contract outside the pin's policy | Stop; do not sign |
| `SLIPPAGE_EXCEEDED` / `PRICE_IMPACT_EXCEEDED` | The route is worse than the strategy allows | Smaller size, or wait; do not loosen the strategy to pass |
| `QUOTE_EXPIRED` | Wallet prompts took longer than the quote age | Get a fresh quote and review it again |
| `RPC_READ_FAILED` | The RPC is down or rate limited, or lacks a method | Another RPC; for receipts see "Verify" below |
| `INDETERMINATE` / `BALANCE_EVIDENCE_UNAVAILABLE` (verify) | The RPC cannot serve the balance evidence | Use `DELIVERY_LOG` (0.4 + `DELIVERY_PROOF=1`) or a qualified tracing RPC; never resend |
| `HTTP_TIMEOUT` / `HTTP_STATUS_ERROR` (`fetchBag`) | Strategy URL slow or failing | Retry the fetch; this is not a purchase |

## Chain support

| Capability | Ethereum | Base | Arbitrum | Robinhood Chain (4663) |
|---|---|---|---|---|
| Parse, validate, normalize, hash | ✅ | ✅ | ✅ | ✅ |
| StrategyRegistry provenance | — no registry | — no registry | — no registry | ✅ |
| Purchase compile (LI.FI Composer) | Not tested; no reviewed pin | Not tested; no reviewed pin | Not tested; no reviewed pin | ✅ live (pin reviewed 2026-10-30) |
| Receipt `VERIFIED` | Not qualified | Not qualified | Not qualified | ✅ live (tracing RPC on the qualified Nitro build; or `DELIVERY_LOG` with 0.4) |

Notes:
- A BAG v1 strategy is single-chain.
- A chain appearing in a TypeScript union does not mean execution there is supported.
- On a chain without a pin, the SDK refuses to compile rather than guessing.

## Tests and what they prove

From the BAG repository:

```bash
npm run smoke:starter --prefix packages/bag-sdk
```

This builds and packs the SDK tarball, installs it with this starter into a temporary directory, builds, then runs
`demo` and `quickstart`. Expected last line:
`{"status":"PASS","sdkVersion":"0.4.0",...,"dependencySource":"SDK_TARBALL",...,"quickstartHash":"0xe201…dad3","signedOrSubmitted":false}`.

```bash
npm run smoke:published-quickstart --prefix packages/bag-sdk
```

This installs the **published** `@bagprotocol/sdk@0.3.0` from npm into a temporary directory and runs the
quickstart. Expected: `{"status":"PASS","sdkVersion":"0.3.0","dependencySource":"NPM_REGISTRY",...}`.

Last run: 2026-11-03, Node 24.22.2, from clean temporary directories outside the BAG repository. That includes
following the quickstart above verbatim, with output identical to the expected JSON.

| Verified | Not verified |
|---|---|
| Quickstart against the published 0.3.0 (npm) and the 0.4.0 tarball; same frozen hash | That 0.4.0 installs from npm (not published) |
| Offline demo: snapshot integrity, minima, receipts (synthetic), HTTP deadlines | Any live compile, purchase or receipt from **this run**. The live Robinhood purchases (2026-10-30, 2026-11-02) were made by the maintainer, not by these smokes |
| Strict NodeNext types (`strict`, `skipLibCheck: false`) against the packed tarball, on Node 24 | Browser bundlers; Node < 24 |
| No network in the demo; npm registry only in the published smoke | Base, Arbitrum and Ethereum execution (no pin, no registry, no receipt qualification) |
| — | Use by an independent external developer (none yet) |

## Prepare a live unsigned intent

Provide your own strategy, RPC, LI.FI credentials and independently reviewed deployment:

- RPC_URL, LIFI_API_KEY; COMPOSER_URL optionally selects the Composer endpoint.
- COMPOSER_FACTORY and COMPOSER_FACTORY_CODE_HASH are required; there is deliberately no default factory.
- STRATEGY_REGISTRY and EXPECTED_CREATOR must be supplied together if provenance verification is required. A failed requested check stops before compilation. Omitted verification is reported as NOT_REQUESTED.

Set environment variables using your shell or secret manager; do not commit them. Supply a minima JSON array with explicit NET wallet amounts chosen after reviewing the quote:

```json
[
  { "token": "0x...full-output-token-address...", "amountRaw": "990" }
]
```

Include each planned swapped output exactly once. Values above are illustrative; never copy a minimum from this README into a real purchase. Swap-level minima/estimates are not automatically treated as wallet guarantees. Applications can call preparePurchase first to display the quote, then createIntent after review.

```
npm run prepare -- strategy.bag.json <inputToken> <amountRaw> <signer> reviewed-minima.json purchase.intent.json
```

The CLI does not sign or submit. It exclusively creates a new output file and reports its intentHash. Retain that hash separately in trusted application state. The snapshot includes the original compiled plan, exact transaction, quote metadata, approvals and reviewed minima. The consumer never serializes its API/RPC configuration; upstream warning text remains untrusted data and should be reviewed before sharing a snapshot.

The consumer checksum detects changed persisted bytes when compared with the separately retained trusted hash. It is not a signature, user authorization or proof of execution. Replacing both file and trusted hash defeats that comparison; never obtain the expected hash from an untrusted file.

## Wallet integration in your own app

src/purchase.ts exports walletFromEthereum for a caller-supplied EIP-1193 browser wallet and submitWithWallet for an explicit user action:

1. Restore the exact snapshot using its separately trusted hash.
2. Check the connected chain and signer; simulate and check expiry.
3. Request bounded approvals through the owner's wallet and wait for approval receipts.
4. Recheck wallet/quote, simulate again, then request the exact original purchase transaction.
5. Return the transaction hash immediately. Persist it with the original intent BEFORE collecting receipt evidence.

The default local age limit is 30 seconds, including preparation latency. Approvals or wallet prompts can outlive it: obtain a fresh quote and ask the owner to review the replacement intent. Do not silently widen minima, replace the original transaction, retry submission after uncertain failure, or perform a second purchase because receipt evidence is incomplete.

Wallet callbacks request confirmation in the user's own wallet. Browser apps should obtain server-prepared unsigned intents; keep Composer keys and private RPC configuration on their host server. Node ESM/NodeNext is the verified starter target; the browser bridge does not claim bundler compatibility.

## Live purchase with your own wallet (local page)

`npm run sign -- <bag.json> <amountRaw> [port]` starts a page on `127.0.0.1` only and prints its URL with a session
token. It uses the same environment as `prepare` plus `INPUT_TOKEN`, and optionally `QUOTE_MAX_AGE_MS` (default 60000)
and `RECEIPT_EVIDENCE_MODE` (default `ROBINHOOD_NITRO_TRANSACTION_INDEX`). The Node process quotes, simulates, saves
the reviewed intent and verifies. The page only asks your browser wallet to send the exact approval and purchase
transactions it returns. API keys and the RPC URL stay in the Node process. No private key is used.

Steps on the page:
1. Connect the wallet.
2. Get a quote.
3. Review the minimum each token must deliver to the wallet. The swap minimum is the default and the floor.
4. Save the intent.
5. Approve and buy. If the quote expires after the approval, get a new quote; the approval stays.
6. Verify with the SDK after a few blocks.

With `DELIVERY_PROOF=1` (SDK 0.4), the program logs each output's measured delivery and "Verify" reads those logs, so any RPC that returns receipts works. If verification still fails, the page lists which contracts emitted the `BagDelivered` log. The CLI equivalent is `RECEIPT_EVIDENCE_MODE=DELIVERY_LOG npm run verify -- …`.

Without delivery proof, verification needs an RPC with `debug_traceCall` and `txIndex` on the qualified Nitro build. Alchemy's and the
public Robinhood endpoints did not serve it on 2026-10-30. If the page shows `INDETERMINATE` /
`BALANCE_EVIDENCE_UNAVAILABLE`, run `npm run verify` later with a qualified `RPC_URL` and
`RECEIPT_EVIDENCE_MODE=ROBINHOOD_NITRO_TRANSACTION_INDEX`. Never send the purchase again.

The intent, its hash, the transaction hash (written before any receipt is read) and a `VERIFIED` result go to
`live-purchases/`. One purchase per run; the page refuses to send a second.

## Verify a submitted purchase

Set RPC_URL and explicitly choose RECEIPT_EVIDENCE_MODE when needed. The default SINGLE_TRANSACTION_BLOCK reader refuses busy blocks. Geth/Nitro modes require the SDK's qualified client semantics and chain checks; there is no event-only fallback.

```
npm run verify -- purchase.intent.json <separately-trusted-intentHash> <transactionHash>
```

VERIFIED requires the original compiled purchase, reviewed wallet minima and sufficient chain evidence. FAILED / INDETERMINATE are not success. The verify command is read-only; repeat after confirmation depth or reader issues are resolved. It can run after the original quote expires.

Independent SDK executions remain NOT_BAG_ACCOUNTED: this example does not create a BAG position, fee eligibility, P&L or redemption record.
