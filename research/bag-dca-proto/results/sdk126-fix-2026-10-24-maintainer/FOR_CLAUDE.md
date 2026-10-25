# Independent verification of PR #126 @ 3f85a4cf80e6d9cc4289d6d074fc7e000e0737ef

The exact swapped-share debit fix is confirmed independently: SDK build PASS; root tsc --noEmit PASS; 302/302 SDK tests PASS. Synthetic receipt fixtures reject partial debit, zero debit and net credit with INPUT_SPEND_BELOW_PLAN; excess still fails. The same four-purchase fork replay passes 34/34; four forwarded receipts are VERIFIED and four legacy receipts still fail INPUT_BALANCE_BELOW_PLAN.

These are distinct evidence scopes: synthetic verifier fixtures, a fork replay of recorded calldata, and one fresh read-only Composer compilation. No fresh live-quote purchase was executed, no real-wallet signature was tested, and no public transaction was sent.

## New response evidence

composer-price-impact.json captures selected raw fields from a new HTTP 200 /compose response, before any BAG validation:

- inputValueUsd: 4.9918325034999995
- outputValueUsd: 4.99499414537114
- impactBps: -6
- Composer 0.11.3, revision 9169cc8; request maxPriceImpactBps remained 500.

The existing guard rejects this with PRICE_IMPACT_INVALID. No checks were loosened. This is a new −6 observation, not the full original −7 response. The diagnostic formula (input-output)/input*10000 gives -6.3336297219986495; that is supporting numerical evidence, NOT official sign or rounding confirmation.

Official docs are accessible here. The FAQ says price impact uses the input/output USD-value difference (https://docs.li.fi/faqs/slippage-price-impact). The Composer SDK reference describes the aggregate USD bound (https://docs.li.fi/composer/composer-api/reference/sdk-api). Neither inspected page explicitly defines the returned signed impactBps formula. The public general OpenAPI was fetched successfully but does not contain /compose or impactBps.

Please keep PR #126's receipt fix separate from any signed-price-impact change. Obtain the precise Composer sign/formula/rounding contract from LI.FI or an authoritative implementation, then assess a separate change and rerun a fresh-quote fork execution. Do not clamp negatives or disable the guard merely to pass the live test. Real MetaMask/Rabby authorization remains NOT TESTED.

Reproduce synthetic cases after building: node spending-probe.mjs --sdk-repo <3f85a4c checkout> --out ./probe.json. Replay uses the original v2 prototype with --repo <e6bdd10 checkout> --sdk <3f85a4c checkout>/packages/bag-sdk --mode replay --out <new directory>. capture-composer-impact.mjs contains this machine's explicit paths; it only reads settings, queries RPC state and compiles, never submits a transaction.

No tracked SDK edits, merge or publication were performed. See review-manifest.json for versions/hashes and commands.
