# SDK deployment pin: LI.FI Composer on Base (8453)

Status: **OBSERVED, NOT YET APPROVED.** The values below were read on Base mainnet by the maintainer on 2026-11-04.
The pin is approved only when every item in "Approval" is filled. Until then, no SDK release and no BAG
documentation may describe Base purchases as supported.

## The pin (observed)

```ts
const baseComposer: ComposerDeployment = {
  chainId: 8453,
  factory: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae',
  factoryCodeHash: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5',
};
```

- **Same address and the same runtime code as the approved Robinhood Chain pin**
  (`docs/SDK_DEPLOYMENT_PIN_ROBINHOOD.md`): 4474 bytes, identical keccak.
- The factory's runtime embeds the VM address, so an identical factory hash also means an identical VM address
  (`0xA9f22b951d5A9CBBD0eC8d2741EA44BFDD2D11fd`). It does **not** pin the VM's own code on Base; that is recorded
  separately below.
- A separate review is still required. The reviewed object is the code on Base, and LI.FI's deployment policy can
  differ per chain.

## Evidence (2026-11-04, maintainer's machine, read only)

| Check | Result |
|---|---|
| `npx tsx scripts/verify-chain-readiness.ts base`, gate A | PASS: RPC 8453 (Alchemy); WETH `0x4200…0006` WETH/18; USDC `0x8335…2913` USDC/6 |
| Factory code on Base (public RPC) | 4474 bytes, keccak `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5` |
| Gate C, `COMPOSER_FACTORY_CODE_HASH` | PASS: live hash = pin |
| Gate C, `COMPOSER_PROXY_PREDICTION`, signer `0xb193DE199EeB9bd1143607a11AD00999Ceb956b8` (P1 test wallet) | PASS: proxy `0xAd834B4De0295622A4042a3CaA62CE5b961578E7` is deployed; `owner()` = signer; `factory()` = pinned factory |
| Gate B-Core (same run, signer `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46`) | PASS: StrategyRegistry `0xcad829dcc30fa88b3d57cc0a6fa32bd56c9a5920` (block 53499552) exact match; that signer's Base proxy `0x0a6BAEfc776477C494aB8b0a288881a7B72196F7` not deployed yet (first purchase targets the factory) |
| Gate D, live purchase (2026-11-04) | **VERIFIED** with this pin: tx `0x21e2770fb15921791d6f311b4bab441c82ceaa589746ccc5d51a1c28122080ee` (block 53500571); evidence `TRANSACTION_AND_DELIVERY_LOGS`, binding `DIRECT`; 2 USDC → WETH + cbBTC; signer `0x49Dadd…FE46` (plain EOA); proxy `0x0a6B…96F7` created in that tx |
| Gate D probe | `debug_traceCall` refused by the Alchemy Base RPC. Receipt verification on Base therefore uses SDK 0.4 `DELIVERY_LOG` |

## What the SDK checks with it

Unchanged from the Robinhood pin. `resolveLifiComposerAccount` reads, at one canonical block:
- the chain;
- the factory runtime hash;
- `predictProxyAddress(signer)`;
- the proxy's `owner()` / `factory()`.

From these it allows exactly one transaction target and one approval spender.

## Re-check (read only, no key)

```bash
npx tsx -e "import('viem').then(async ({ createPublicClient, http, keccak256 }) => { const c = createPublicClient({ transport: http('https://mainnet.base.org') }); console.log('chain', await c.getChainId(), 'block', await c.getBlockNumber()); for (const [n, a] of [['factory', '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae'], ['VM 1.2', '0xA9f22b951d5A9CBBD0eC8d2741EA44BFDD2D11fd']]) { const k = await c.getCode({ address: a }); console.log(n, a, 'keccak', k ? keccak256(k) : 'NO CODE'); } })"
```

Expected:
- `chain 8453`;
- factory keccak `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5`;
- VM 1.2 keccak: to be recorded (Robinhood value for comparison:
  `0x0d0f2d31c4ab65c4b5da60e68efc4d394891881f822943f60ae3c1266519bfb7`).

## What it does not cover

Same as the Robinhood pin:
- the VM's behaviour and the programs it runs;
- Composer's fee semantics;
- an audit of VM 1.2.

These are accepted as the upstream dependency.

## Approval

| Field | Value |
|---|---|
| VM 1.2 keccak on Base | _pending_ |
| LI.FI confirmation that this is the production Composer factory on Base | _pending_ |
| Approved by the maintainer | _pending_ |

After approval:
1. Add the pin to `packages/bag-sdk/release-gates.json`.
2. Update the SDK README chain table ("Purchase compile" on Base: reviewed pin, live test pending).
3. Run the first Base purchase (`docs/chains/BASE_READINESS.md`, gate D).
