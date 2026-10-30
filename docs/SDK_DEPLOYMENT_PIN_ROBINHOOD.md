# SDK deployment pin: LI.FI Composer on Robinhood Chain

Review note for release gate 2 (`packages/bag-sdk/release-gates.json` → `deploymentPinApproved`). Approved by the
maintainer on 2026-10-30 after the re-check below (approval section).

## The pin

```ts
const robinhoodComposer: ComposerDeployment = {
  chainId: 4663,
  factory: '0xaceb3bb6c75488b5b806b9de4dcf78814465bdae',
  factoryCodeHash: '0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5',
};
```

- **Factory:** LI.FI's production factory for VM 1.2, confirmed by LI.FI on 2026-10-22. The LI.FI addresses page
  still lists the earlier `0xe174…fB35` (`docs/SDK_COMPOSER_TRUST.md`).
- **Runtime hash:** observed 2026-10-21 (`docs/SDK_COMPOSER_TRUST.md`); re-checked by the command below.
- **VM:** `0xA9f22b951d5A9CBBD0eC8d2741EA44BFDD2D11fd` is embedded in the factory's runtime code and in every proxy
  it deploys. A different VM means different factory code, so the factory hash pins the VM address too. It does not
  pin the VM's own code; the check below records that hash for reference.

## What the SDK checks with it (`resolveLifiComposerAccount`)

At one canonical block:
- the RPC is chain 4663;
- the factory's runtime hash equals the pin;
- `predictProxyAddress(signer)` gives the signer's proxy;
- when deployed, the proxy's `owner()` is the signer and its `factory()` is the pinned factory.

From this it allows exactly one transaction target (the proxy, or the factory on first use) and one approval spender
(the proxy). A compile response naming anything else is refused.

## What it does not cover

- The VM's behaviour, the calls its programs make, InvariantChecker / ArithmeticProcessor (their VM 1.2 addresses are
  not identified) and Composer's fee semantics. These are accepted as the upstream dependency (gate 1 basis).
- An audit of VM 1.2.

## Rollout response

When LI.FI ships a new factory, compiles start naming it and the SDK refuses them (`ACCOUNT_DEPLOYMENT_MISMATCH`, or
a target / spender mismatch). Funds are not at risk; SDK purchases stop until a new pin is reviewed:
1. Confirm the new factory with LI.FI.
2. Run the check below against it, and confirm its proxies' `owner()` / `factory()` on a test signer.
3. Update this note and the pin, and release a patch version.

Applications can watch for the refusal codes to notice a rollout.

## Re-check (read only, no key)

```bash
npx tsx -e 'import(`viem`).then(async ({createPublicClient,http,keccak256})=>{const c=createPublicClient({transport:http(`https://rpc.mainnet.chain.robinhood.com`)});console.log(`chain`,await c.getChainId(),`block`,await c.getBlockNumber());for(const [n,a] of [[`factory`,`0xaceb3bb6c75488b5b806b9de4dcf78814465bdae`],[`VM 1.2`,`0xA9f22b951d5A9CBBD0eC8d2741EA44BFDD2D11fd`]]){const k=await c.getCode({address:a});console.log(n,a,`keccak`,k?keccak256(k):`NO CODE`)}})'
```

Expected:
- `chain 4663`;
- factory keccak `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5`;
- VM 1.2 keccak `0x0d0f2d31c4ab65c4b5da60e68efc4d394891881f822943f60ae3c1266519bfb7` (recorded 2026-10-30).

## Approval

| Field | Value |
|---|---|
| Re-check run (date, block) | 2026-10-30, Robinhood Chain (4663) block 101381451, public RPC, run by the maintainer |
| Factory keccak matched the pin | YES: `0xb3a1317ea3653441b2b6f0e9ed25f4a2537e3780c1786e3a532337109d67cac5` |
| VM 1.2 keccak | `0x0d0f2d31c4ab65c4b5da60e68efc4d394891881f822943f60ae3c1266519bfb7` |
| Approved by the maintainer | YES, 2026-10-30. A later factory change needs a new review; the pin can be replaced in a patch release. |
