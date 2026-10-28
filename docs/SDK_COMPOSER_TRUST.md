# SDK Composer trust and release priorities

Observed 2026-10-21. This note concerns the standalone purchase SDK, not changes to BAG accounting or the application execution path.

## P0: independent wallet target and spender binding

Implemented by `resolveLifiComposerAccount` and the `lifiComposer({ account })` guard. The caller supplies a chain-specific reviewed factory and runtime hash. At one canonical block the helper checks chain, factory code hash, `predictProxyAddress(signer)`, proxy deployment state, and the deployed proxy's `owner()` and `factory()` values. It derives a narrow target/spender policy before any compile response is accepted.

The direct target is the predicted proxy after deployment, or the pinned factory for first use. Approval spender is the predicted proxy in both cases. A deployed/undeployed state change between resolution and compile can cause a safe refusal: resolve again and recompile rather than broadening the allowlist. Run fresh resolution for each compile. The observation is not a cryptographic proof against a dishonest reader and does not audit VM bytecode, arbitrary inner calls, mutable deployment controls or fee semantics.

The adapter rejects a different signer, chain, target, user proxy or approval spender. Output metadata must name the signer as terminal owner, the requested chain, and immediate delivery. Existing amount, output-token, minimum-output, price-impact and approval bounds in `compileBag` still apply.

## Deployment discrepancy: documentation and observed server

Primary references:

- [LI.FI account model](https://docs.li.fi/composer/composer-api/overview): deterministic per-signer proxies via CreateX CREATE3.
- [LI.FI canonical addresses](https://docs.li.fi/composer/composer-api/reference/addresses): factory snapshot `0xe174D02351656a883f6626497C86684e849efB35`; explicitly described as a convenience snapshot.
- [LI.FI quickstart](https://docs.li.fi/composer/composer-api/quickstart): proxy target after deployment, factory target on first use.

Read-only Robinhood mainnet observations, not a claim that either deployment has been independently audited:

| Factory | Observed runtime keccak256 | Observation |
| --- | --- | --- |
| `0xe174d02351656a883f6626497c86684e849efb35` | `0xab7b3d16c383dfd0f2260930069b414102d1cb2a22c478b64282cf01c1e0262b` | Current documentation snapshot; deployed on Robinhood, but its predicted accounts did not match the live production compile responses tested. |
| `0xaceb3bb6c75488b5b806b9de4dcf78814465bdae` | `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5` | Observed production compile deployment on Robinhood; predictions matched the independently read proxy owner/factory and returned compile accounts. |

For signer `0x49dadd8212128bdf6752351bf70f6a5d8b73fe46`, the documented factory predicts `0xbd45be2cbc57145cd39947bdceff6c50bd9a0f94`, while the observed production factory predicts `0x0a6baefc776477c494ab8b0a288881a7b72196f7`. Both proxies are deployed; their owner/factory getters match their respective deployments. The older second demo signer likewise maps to a different proxy under each factory. Do not assume historical account addresses still identify the current deployment.

No production default is embedded in SDK source. The application owner must review and explicitly select a deployment pin. A changed compile deployment is a refusal until the selected deployment is independently reviewed; copying the returned address is not review.

## Live checks completed

Using the actual pinned Composer SDK 0.11.3, the production Composer API, and the caller's private RPC/API credentials:

1. **Wrong deployment:** selecting the documentation snapshot factory caused target/proxy binding to fail. No transaction was returned to the caller.
2. **Deployed proxy:** native-input `feetest` compilation succeeded against the independently pinned observed production factory. Local RPC simulation correctly reported insufficient native balance for the demo signer. Compile success was not presented as wallet readiness.
3. **First use:** a signer with an undeployed predicted proxy compiled to the pinned factory, with the independently predicted `userProxy`. Native-input RPC simulation returned `OK`. This was `eth_call`, not deployment or submission.
4. **ERC-20 first use:** 10 USDG compiled with zero native value and an exact 10 USDG approval to the predicted proxy, not the factory. RPC simulation reported insufficient USDG balance for the example signer; no approval or transaction was sent.

Private credentials are neither committed nor included in output. Reproduce with `packages/bag-sdk/examples/compile-verified-composer.mjs` after building the SDK, supplying your own reviewed deployment and credentials.

## Remaining Composer release checks, in order

1. **Confirm the production deployment policy with LI.FI:** explain the snapshot/server discrepancy, which deployment is intended for the integration, and migration/retirement guarantees. Prepare this evidence for a human-approved support request; this work did not send a message to LI.FI.
2. **Document and approve the deployment pin operationally:** factory address, code fingerprint, network, signer-account resolution, review date and response to a rollout. The helper intentionally does not auto-accept a new factory.
3. **Complete a newly signed SDK purchase:** preserve the original compiled purchase and reviewed wallet minima, let the user sign with sufficient balance/approvals, and verify the mined receipt using the Nitro reader. The unsigned compile and historical reader checks do not replace this step.
4. **Release compatibility:** keep Composer/spec peers in lockstep and SDK 0.11.x bounds until a deliberate upgrade is checked against the production server. Do not upgrade to a staging/alpha package merely because a documentation example mentions it.

Only after these release gates should npm distribution be finalized. SDK purchases remain `NOT_BAG_ACCOUNTED`; this work does not add positions, fees or redemption accounting.
