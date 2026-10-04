# StrategyRegistry — design

Status: **contract, off-chain verifier and tests implemented; not deployed.**
App wiring (signing a registration from the UI, recording it, showing it in
bag.json / the Strategy API) is the next PR.

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

## 8. Next (app wiring PR)

- Creator signs `registerStrategy` / `publishVersion` from the UI; the server
  verifies the receipt (event, creator, hash equals the stored version's
  recomputed hash) and records it — never signs.
- `bag.json.commitments.registry` and the Strategy API show the registry id,
  the version's on-chain status and the tx.
- **Prerequisite for forks:** BAG's fork records do not store the parent
  version today (`forkedFrom.version` is always null). `registerFork` needs it,
  so fork creation must start recording the parent's current version first.

## 9. Not verified

- Not deployed to Robinhood Chain or any public network; no live transaction.
- Gas costs measured only on the in-process EVM.
