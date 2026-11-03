# Base (8453) readiness plan

Status 2026-11-03: **NOT production-qualified.**
- No BAG contract is deployed on Base.
- No Composer pin has been reviewed for Base.
- No live Base purchase has been verified.

The `base` entries in `lib/config/chains.ts`, in `BAG_V1_CHAINS`, and in the deploy scripts' chain lists are
configuration only. They are not evidence. A chain is production-qualified only when its own deployment,
Composer execution, trust checks and receipt verification have passed **with Base evidence**. Robinhood Chain
evidence does not carry over.

Scope:
- **In scope:** single-chain BAG v1 strategies of crypto assets on Base; the SDK purchase path (LI.FI Composer);
  StrategyRegistry provenance; receipt verification.
- **Out of scope:** RedeemSettlement fees, royalties, DCA, BagExecutionRouter, stock tokens, cross-chain baskets,
  auto-rebalance.

## Read-only check

Run on the owner's machine. It needs only a Base RPC and no key, and never sends anything:

```bash
npx hardhat compile
```

```bash
npx tsx scripts/verify-chain-readiness.ts base
```

`lib/blockchain/chain-readiness.ts` (tests: `lib/blockchain/__tests__/chain-readiness.test.ts`) prints one line per
check and a gate summary. An address or pin that is not configured shows as `NOT_CONFIGURED`: it is never
defaulted and never borrowed from Robinhood Chain. Exit code 1 means some check FAILED.

The sandbox this was written in cannot reach a Base RPC: `https://mainnet.base.org` was unreachable. So no
Base result is recorded here yet.

## Gates

| Gate | Holds when | How it is checked | Status |
|---|---|---|---|
| **A** Chain and asset identity | The RPC is 8453; WETH `0x4200…0006` is `WETH`/18; native USDC `0x8335…2913` is `USDC`/6; every strategy asset is checked with `readTokenDecimals` | `verify-chain-readiness.ts base` (A checks) | Config IMPLEMENTED; NOT VERIFIED live |
| **B** BAG contracts | StrategyRegistry (and BagFactory and StrategyCompositions, if the app is to use Base) are deployed by the owner; their addresses are set in `STRATEGY_REGISTRY_ADDRESS_BASE` / `FACTORY_ADDRESS_BASE` / `STRATEGY_COMPOSITIONS_ADDRESS_BASE`; live runtime equals the artifact (immutables and metadata masked) | Deploy scripts already take `base`. Then `verify-chain-readiness.ts base` (B checks) | NOT DEPLOYED |
| **C** Composer trust | A **Base-specific** pin (factory and runtime code hash) is confirmed with LI.FI and reviewed in a separate `docs/SDK_DEPLOYMENT_PIN_BASE.md`; the live code hash equals the pin; a test signer's predicted proxy is unused, or owned by the signer and the pinned factory | `COMPOSER_FACTORY_BASE` / `COMPOSER_FACTORY_CODE_HASH_BASE` / `COMPOSER_TEST_SIGNER`, then the C checks | NOT REVIEWED |
| **D** Execution and receipt proof | A real Base purchase compiled by the SDK with the Base pin is signed by the owner's wallet, and `verifySubmitted` returns `VERIFIED` | Owner step; the script only probes the RPC (`debug_traceCall`) | NOT VERIFIED |
| **E** Independent consumer | The starter (`examples/sdk-consumer`), installed from the npm package or the tarball outside the repository, prepares and verifies the Base purchase with no BAG app, backend or database | Owner step | NOT VERIFIED |

Order: A → C → B (only StrategyRegistry is needed for the SDK path) → D → E. Nothing in D or E starts before A
and C are PASS.

## Gate B: deployment configuration (no addresses invented)

| Contract | Script | Inputs | Needed for |
|---|---|---|---|
| StrategyRegistry | `npx tsx scripts/deploy-strategy-registry.ts base` | `DEPLOYER_PRIVATE_KEY` (one-time, owner's shell only), `BASE_RPC_URL` | SDK provenance (`verifyRegistryCommitment`) |
| BagFactory | `npx tsx scripts/deploy-bag-factory.ts base` | Also `PROTOCOL_TREASURY_ADDRESS`, `FACTORY_OWNER` (a Safe), `BAG_CREATION_FEE_ETH` | App Bag creation on Base, not needed for the SDK path |
| StrategyCompositions | `npx tsx scripts/deploy-strategy-compositions.ts base` | As above | App only |

After each deployment:
1. Set the printed `…_BASE` variable.
2. Re-run `verify-chain-readiness.ts base`.
3. Record the address, block and bytecode result in a new §"Base" of `docs/STATUS.md`.

No Base address belongs in the repository before that record exists.

## Gate C: the Base Composer pin

- **The Robinhood pin is not reused.** The LI.FI factory may have the same address on several chains (CREATE2/3), but
  the reviewed object is the *code on that chain*.
- Steps, mirroring `docs/SDK_DEPLOYMENT_PIN_ROBINHOOD.md`:
  1. Ask LI.FI for the VM 1.2 factory on Base.
  2. Read its runtime hash on Base.
  3. Confirm the VM address embedded in it.
  4. Check `predictProxyAddress` / `owner()` / `factory()` on a test signer.
  5. Write `docs/SDK_DEPLOYMENT_PIN_BASE.md`.
  6. Mark it approved in `packages/bag-sdk/release-gates.json` only after review.

## Gate D: receipt evidence on Base (important)

- Every OP Stack block starts with the L1-attributes deposit transaction. A Base block therefore never holds exactly
  one transaction, and the SDK's `SINGLE_TRANSACTION_BLOCK` reader always refuses on Base.
- `GETH_TRANSACTION_INDEX` requires `web3_clientVersion` to match `Geth/v1.16.*`. Base nodes run op-geth or op-reth,
  whose version strings differ, so that reader refuses as well. Widening that check would need a separate
  qualification of op-geth's `txIndex` semantics, with real historical reads.
- `ROBINHOOD_NITRO_TRANSACTION_INDEX` is chain-gated to 4663.
- **Practical route: SDK 0.4 `DELIVERY_LOG`** (`DELIVERY_PROOF=1`). The purchase program logs each output's measured
  delivery, and verification reads those logs from any RPC.
  - 0.4.0 is a candidate, not published, so gate D on Base depends on that release, or on a newly qualified
    indexed reader.
  - Note that this is an inference from the SDK source and OP Stack block structure. Confirm it on the first live
    Base attempt by recording the refusal codes.

## Owner checklist (in order)

- [ ] A Base RPC of your own, set in your shell as `BASE_RPC_URL`. Never commit it.
- [ ] `verify-chain-readiness.ts base`: gate A PASS. Save the output.
- [ ] Base Composer pin confirmed with LI.FI and reviewed (`SDK_DEPLOYMENT_PIN_BASE.md`): gate C PASS.
- [ ] StrategyRegistry deployed on Base with a one-time key: gate B PASS for the registry.
- [ ] A small strategy (two liquid Base tokens) registered from the creator's own wallet.
- [ ] SDK 0.4.0 published, or the tarball used, with `DELIVERY_PROOF=1`.
- [ ] One small purchase signed in the owner's wallet: `VERIFIED`. Record the tx hash, block and output: gate D.
- [ ] The same flow from the starter copied outside the repository: gate E.
- [ ] Only then: update the SDK README chain table and `docs/STATUS.md` for Base to LIVE VERIFIED, with links to
      the evidence.
