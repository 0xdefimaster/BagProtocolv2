# Draft issue (not posted): ERC-7715 periodic permission on Robinhood Chain (4663) fails after Grant

> Prepared for the user to post manually if they choose. Nothing was submitted automatically.
> Check first whether the user's earlier manual report already covers this; do not duplicate it.

## Summary

On MetaMask **13.53.0**, `wallet_requestExecutionPermissions` for an `erc20-token-periodic` permission on Robinhood Chain (chainId 4663 / `0x1237`) opens the native permission screen. After **Grant** the request fails with:

```
code: -32603
message: External signature requests cannot sign delegations for internal accounts.
```

No permission context is returned.

## Request (abridged; full JSON in `results/metamask-native/native-permission-result.json`)

| Field | Value |
|---|---|
| Permission | `erc20-token-periodic` |
| Token | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Amount | 1 USDG per 60 s |
| Rules | `expiry`, plus `redeemer` and `payee` set to one address |
| Account | a fresh account (zero ETH, zero USDG, no code) |

## Source analysis (pinned sources, offline reproduction 7/7)

- Extension v13.53.0 depends directly on `@metamask/delegation-deployments` 2.1.0, which **includes** 4663.
- `@metamask/gator-permissions-controller` 4.2.2 (bundled) depends on `@metamask/delegation-deployments` **1.4.0**, which **does not include** 4663. Its lookup throws `Contracts not found for chainId: 4663`.
- The signature controller (39.2.10) then validates the delegation without a decoded permission. That path produces the observed message.
- As of 2026-10-25 the latest `gator-permissions-controller` (6.0.1, 2026-09-24) still declares `delegation-deployments ^1.4.0`. The 1.x line ends at 1.4.0, so no version in that range includes 4663.

This is a strong candidate cause, not a proven one: we have no internal extension runtime trace, and other decode failures could surface as the same external error.

## Expected

Either the grant succeeds on 4663, or the wallet stops advertising 4663 support until the controller's registry includes it.

## Suggested fix

Move `gator-permissions-controller` to `@metamask/delegation-deployments` ^2.1.0, which includes 4663, and release it in the extension.

## Primary sources

- https://github.com/MetaMask/metamask-extension/blob/v13.53.0/package.json
- https://github.com/MetaMask/metamask-extension/blob/v13.53.0/yarn.lock
- https://github.com/MetaMask/smart-accounts-kit/blob/b874928c143e316cc47436112fd04a1f2444a900/packages/delegation-deployments/src/index.ts
- https://github.com/MetaMask/core/blob/7d5e4cc3eff4ee94cb9c38cb091d14755e215f9d/packages/gator-permissions-controller/src/GatorPermissionsController.ts
- https://github.com/MetaMask/core/blob/3bb5d086a6e3fcc94af342eb20dfae75bec02fc6/packages/signature-controller/src/SignatureController.ts
- https://github.com/MetaMask/core/blob/3bb5d086a6e3fcc94af342eb20dfae75bec02fc6/packages/signature-controller/src/utils/validation.ts
