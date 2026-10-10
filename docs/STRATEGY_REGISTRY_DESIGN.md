# StrategyRegistry — design

Status: **deployed on Robinhood Chain (2026-10-10).** Contract, off-chain
verifier, user-signed registration flow and fork provenance implemented. The
app uses it once `STRATEGY_REGISTRY_ADDRESS_ROBINHOOD` is set (§8).

## 0. Deployments

| Chain | Address | Deploy tx | Block | Deployer |
|---|---|---|---|---|
| Robinhood Chain (4663) | `0x907cc27d644c8ea1c24b8320ad09ecf2819209a8` | `0x453db80f70a024816ac22d457017fbbc84294fdcce407f91f1d5666a137d518e` | 85332074 | P1 disposable wallet `0xb193DE199EeB9bd1143607a11AD00999Ceb956b8` |

Deployed with `scripts/deploy-strategy-registry.ts robinhood`. The script
checked the RPC's chain id (4663) before sending and the receipt's success
and contract address after. The contract has no constructor arguments, owner,
admin or fee, so the deployer has no power over it.

Not independently re-read from this repository's sandbox (no Robinhood Chain
access): the bytecode at the address is checked on the explorer
(robinhoodchain.blockscout.com) against `artifacts/contracts/StrategyRegistry.sol`.

**To switch it on:** set `STRATEGY_REGISTRY_ADDRESS_ROBINHOOD` to the address
above in the deployment's environment (Netlify) and redeploy. It is an address,
not a secret. Switched on in production on 2026-10-10.

**First live commitment (2026-10-10).** Bag `feetest`
(`170e5e72-d5d5-4f16-b180-24b3dc525b37`, TSLA 50% / NVDA 50%, 20% performance
fee), v1, `definitionHash`
`0x089fc9ba2754f4180658c5f809986e606f8ec63d55430e3ab33da2046210a4fa`,
registered from the creator's own wallet `0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46`
through the Bag page panel (§8):
tx `0xe5c105c3f07daee701f25ca7bd1b2afd3cfb9c8c43ff2c09aeaf32a2db0180c7`.
BAG confirmed the receipt and the panel shows v1 as Registered. Anyone can
re-check it without BAG: `GET /api/strategies/170e5e72-d5d5-4f16-b180-24b3dc525b37/versions/1`
gives the bag.json, and `scripts/verify-strategy-commitment.ts` compares its
hash with the registry on-chain.

## 1. What it is for

One question: **"what is strategy X, version N?"** The registry records,
immutably and on-chain, the bag.json v1 `definitionHash`
(docs/BAG_JSON_V1_DESIGN.md) that the strategy's creator committed to for each
version. Anyone holding a bag.json can then check it is exactly that
commitment, without trusting BAG's server.

Three layers, three questions, kept apart:

| Layer | Question | Where |
|---|---|---|
| **StrategyRegistry** | What is this strategy / version? | `contracts/StrategyRegistry.sol` → `definitionHash` |
| **Accounting** | What actually happened to the user with it? | ledger, holdings, P&L (docs/ACCOUNTING_V2_DESIGN.md) |
| **Execution** | How was it executed? | intents, routes, receipts |

## 2. What it holds — and what it never holds

Holds, per strategy: `creator`, `latestVersion`, fork origin
(`forkOfStrategyId`, `forkOfVersion`); per version: `definitionHash`. Events
also carry `offChainRef` and an optional `uri` locator for the bag.json (not
verified, not stored).

**Never:** NAV, TVL, holdings, shares, P&L, execution state, wallet balances,
fees, tokens or ETH. No owner, admin, pause, upgrade or fee. Nothing can be
updated or deleted. (Locked by `contracts/test/StrategyRegistry.test.ts`, "no
economic surface".)

## 3. Identity

`strategyId = keccak256(abi.encode(creator, offChainRef))`, with
`offChainRef` = the BAG strategy UUID as bytes32 — exactly
`BagFactory.deriveBagId()`. The same Bag has the same id in both contracts,
and because the creator is part of the id nobody else can register it (no
squatting). TS: `registryStrategyId(creator, uuid)`
(`lib/domain/basket-protocol/strategy-registry.ts`).

## 4. Two lineages, never mixed

**Version lineage — inside one strategy.** Versions are `1, 2, 3, …`, no gaps
(`publishVersion` must name exactly `latestVersion + 1`). The parent of
version N is always version N−1 of the same strategy; it is implicit and
cannot be set. Only the strategy's creator publishes versions.

```
BAG A   v1 ──▶ v2 ──▶ v3
```

**Fork lineage — between strategies.** A fork is a **new** strategyId, with
its own creator and its own version 1, that records once, at registration,
the exact `(parentStrategyId, parentVersion)` it was forked from. The parent
version must already be registered. Forking is permissionless; it never
touches the parent.

```
BAG A v3 ├── fork ──▶ BAG B v1 ──▶ B v2
         └── fork ──▶ BAG C v1
```

So "v2 of B" always means B's own second version; "forked from A v3" is a
separate, fixed fact about B. A fork's versions never continue the parent's
numbering, and the parent's versions never mention its forks.

History created before the registry existed is published in one transaction
with `publishVersions(strategyId, firstVersion, hashes[])`, still contiguous.

## 5. Who signs

The creator's own wallet signs every registration and version (user-signed
model). BAG's server never signs a registration or a version on a user's
behalf, and the deployer has no power over the registry after deployment.

## 6. Third-party verification

Inputs: a bag.json (e.g. from `GET /api/strategies/:id/versions/:version`),
the creator's address, the registry address, an RPC. No key, no BAG server.

1. Recompute `definitionHash` from `bag.json.definition` (JCS + domain prefix,
   docs/BAG_JSON_V1_DESIGN.md §4). The bag.json's stated hash is **not**
   trusted — it must equal the recomputed one.
2. Derive `strategyId = keccak256(abi.encode(creator, uuid))` from the bag.json's
   `ref.strategyId`.
3. Read `strategyOf(strategyId)`: a registered strategy whose `latestVersion`
   covers `ref.version`.
4. Read `definitionHashOf(strategyId, ref.version)` and compare with the
   recomputed hash.

Verified only when all four hold. Implemented as `verifyBagJsonCommitment` +
`readRegistryRecord`, and as a CLI:

```
npx tsx scripts/verify-strategy-commitment.ts <chain> <registry> <creator> <bag.json>
```

Exit 0 = verified. Checked end to end on a local Hardhat node: the genuine
bag.json is VERIFIED; a tampered definition (weights changed, original hash
kept) and a wrong creator are NOT VERIFIED.

The verifier only imports the pure bag.json canonicalization and viem; it is
the seed of the independent npm verifier planned with Receipt v3.

## 7. Relation to BagFactory's compositionHash

`BagFactory` records a `compositionHash` per on-chain version (assets and
weights, the format the Bag contract uses). The registry records the bag.json
`definitionHash`, which covers the whole definition (assets, weights, rules,
fee, policies) in a canonical form anyone can reproduce. They are independent:
a strategy can be registered without a deployed Bag, and the registry never
reads the factory.

## 8. App wiring (user-signed registration)

**Flow.** `POST /api/bags/:id/registry/prepare` builds the next transaction for
the creator's wallet — `registerStrategy` (v1), `registerFork` (v1 of a fork) or
`publishVersions` (every stored version after the last registered one). The
creator's wallet signs and sends it. `POST /api/bags/:id/registry/confirm
{ txHash }` then verifies the mined receipt and records it in
`strategy_registrations` (0052, insert-only). The panel on the Bag page
(`StrategyRegistryPanel`) loops prepare → sign → confirm until nothing is left.
`GET /api/bags/:id/registry` is the public status.

**Confirm records nothing unless every check holds:** sent from the creator's
session wallet to the configured registry (`STRATEGY_REGISTRY_ADDRESS_<CHAIN>`),
succeeded, the strategy id is the creator-bound id of this Bag, a fork names
exactly its recorded parent registration and version, and every published
definitionHash equals the stored version's bag.json hash. A commitment that
differs (e.g. sent directly to the contract with another hash) is refused and
the version stays `NOT_REGISTERED` in BAG. Confirm is idempotent; a
transaction cannot be claimed by two Bags. BAG's server never signs.

**Fork provenance.** Forks now record the exact parent version they were made
from (`bags.parent_bag_version`, 0052; checked to exist at insert, immutable
afterwards, same rules as the rest of the lineage). bag.json `forkedFrom.version`
shows it. A fork registers with `registerFork(parentRegistryId, parentVersion)`
only once that parent version is registered; until then prepare returns
`PARENT_NOT_REGISTERED`. Forks made before 0052 keep `parent_bag_version = NULL`
— it is never inferred — and cannot be registered (`FORK_PARENT_VERSION_UNKNOWN`):
registering them as non-forks would lose their provenance. Whether to let their
creators register them some other way is an open decision.

**bag.json.** `commitments.registry` per version: `REGISTERED` (with registry
address, registry id, creator, tx, block and, on a fork's v1, `forkOf`) only
when the recorded commitment is exactly this version's definitionHash;
otherwise `NOT_REGISTERED`. `recordedFrom: VERIFIED_TX_RECEIPT`, never a chain
read by the response. Schema: `docs/schemas/bag.v1.schema.json`.

**Tests.** Real Postgres + the real StrategyRegistry on Hardhat's in-process
EVM (`strategy-registration-local-evm.integration.test.ts`): register v1 →
publish v2 → bag.json REGISTERED → a third party verifies on-chain; wrong hash
and wrong sender recorded as nothing; fork registers against the exact parent
version only after it is registered, and the chain shows the same fork origin;
pre-0052 fork refused; only the creator; registry must be configured.

## 9. Not verified

- Not deployed to Robinhood Chain or any public network; no live transaction.
- The registration panel has not been exercised against a real wallet extension.
- Gas costs measured only on the in-process EVM.
