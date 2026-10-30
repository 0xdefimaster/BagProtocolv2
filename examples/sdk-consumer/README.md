# BAG SDK independent consumer

A small Node 24 / TypeScript NodeNext project using only the public package imports and declared dependencies. It has no BAG frontend, backend, database, private key or default deployment pin.

## Install the prepared SDK package

This starter targets SDK 0.3.0. Once 0.3.0 is on npm, `npm install` resolves it directly. To test an unpublished source tree instead, build and pack it from the BAG repository:

```
npm run build --prefix packages/bag-sdk
npm pack ./packages/bag-sdk --pack-destination <absolute-artifact-directory>
```

Copy this entire starter into a fresh directory outside the repository. In that copy, install the absolute SDK tarball path (this replaces the unpublished SDK dependency), then build and run:

```
npm install --ignore-scripts --no-audit --no-fund <absolute-path-to-SDK.tgz>
npm run build
npm run demo
```

The demo uses synthetic tokens, provider results and receipt evidence. It verifies preservation of the original snapshot, reviewed minima, BigInt round-trip, changed-file refusal, receipt processing, HTTP deadline and safe cancellation. It never accesses the network, asks for a signature or sends a transaction. Its VERIFIED result is synthetic, not live purchase proof.

After the candidate is approved/published, the exact SDK dependency can be installed normally. Peers are pinned to Composer 0.11.3 and viem 2.56.0; keep the Composer/spec line compatible with production.

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

Verification needs an RPC with `debug_traceCall` and `txIndex` on the qualified Nitro build. Alchemy's and the
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
