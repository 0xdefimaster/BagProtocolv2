# SDK deployment pin: LI.FI Composer on Arbitrum One (42161)

Status: **OBSERVED, NOT APPROVED**, 2026-11-08. Read-only RPC observations at block **522387172**, using `https://arb1.arbitrum.io/rpc`. No transaction was signed or sent. This file does not enable a release gate.

| Contract | Address | Runtime keccak256 |
|---|---|---|
| Candidate factory | `0xaceb3bb6c75488b5b806b9de4dcf78814465bdae` | `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5` |
| Candidate VM | `0xa9f22b951d5a9cbbd0ec8d2741ea44bfdd2d11fd` | `0x0d0f2d31c4ab65c4b5da60e68efc4d394891881f822943f60ae3c1266519bfb7` |
| Native USDC (6 decimals, symbol USDC) | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | `0xad30d819dbc47814b7e6cb837fd7cc57fcb591479a38596ee93de4fc52e8c435` |
| WETH (18 decimals, symbol WETH) | `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` | `0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7` |

USDC identity also matches [Circle's contract list](https://developers.circle.com/stablecoins/usdc-contract-addresses). Token runtime hashes identify the observed proxy/runtime, not every implementation dependency or future implementation. USDC may pause, blocklist or upgrade; simulate each purchase.

Factory and VM hashes match the values observed on Base/Robinhood. That does not carry either chain's approval to Arbitrum. The factory hash alone does not pin the VM's code. `resolveLifiComposerAccount` separately derives the signer's proxy and verifies the target/spender policy before compile.

## Fresh Composer checks (2026-11-08)

Using the candidate pin above and public signer `0xb193de199eeb9bd1143607a11ad00999ceb956b8`, the SDK resolved deployed proxy `0xad834b4de0295622a4042a3caa62ce5b961578e7` and verified its owner/factory binding. No private key was loaded. The LI.FI credential was read only into process memory from the existing local environment; it is not included here.

| Scenario | Fresh compile | eth_call |
|---|---|---|
| 0.0005 ETH → USDC | PASS, delivery proof, impact −1 bps | INCOMPLETE, insufficient balance |
| 2 USDC → WETH | PASS, delivery proof, impact +40 bps | INCOMPLETE, insufficient balance |
| 0.0001 WETH → USDC | PASS, delivery proof, impact +38 bps | INCOMPLETE, insufficient balance |
| 0.5 USDC → WETH (separate smaller-amount check) | PASS, delivery proof, impact +25 bps | **OK_WITH_ASSUMED_APPROVALS** |

The last call verified the USDC allowance slot via `allowance()` under state override, then simulated the swap with exactly 500000 units of allowance. This proves execution in eth_call under that approval assumption; no on-chain approval, purchase, receipt or finality was produced. The default three-scenario matrix remains INCOMPLETE; the smaller run does not relabel it as PASS. Prices/impact are observations at quote time, not stable values.

Pending: upstream production deployment confirmation, maintainer approval and a signed live purchase verified against its original compiled intent. A StrategyRegistry deployment/commitment is additionally needed for registered-strategy provenance. No Arbitrum indexed balance reader is qualified; the candidate's direct purchase path uses delivery logs and does not measure input-token debit.

Read-only runner, with credentials and the explicit candidate pin supplied through the environment:

```powershell
npx tsx packages/bag-sdk/examples/evm-phase1-check.ts arbitrum <public-signer-address>
```

Required: `RPC_URL`, `LIFI_API_KEY`, `COMPOSER_FACTORY`, `COMPOSER_FACTORY_CODE_HASH`. The signer needs no private key for this check. Empty balances mean INCOMPLETE, not a passed swap. Nothing is signed or submitted.
