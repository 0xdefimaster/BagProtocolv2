# StrategyCompositions: a strategy's weights, on-chain

Status: **built and tested on a local chain; not deployed.** Step 1 of the on-chain plan: strategy facts on-chain,
the user's money stays in the user's own wallet (no vault, no pool).

## Why

StrategyRegistry (`docs/STRATEGY_REGISTRY_DESIGN.md`) commits each version's bag.json `definitionHash`. A hash proves a
file is unchanged, but no contract can read assets or weights from it. Anything that has to act on the strategy
itself — a router checking a purchase against the strategy, an indexer, another app — would still need BAG's server.

StrategyCompositions stores, per registered `(strategyId, version)`, the allocation list:
`(chainId, token, weightBps)`.

## Rules (contracts/StrategyCompositions.sol)

- Reads the existing StrategyRegistry; the registry is not changed or redeployed.
- Only the strategy's creator there can publish, and only for a version already registered there.
- Once per version. Never changed, never deleted.
- Canonical: entries strictly ascending by `(chainId, token)`, so one composition has one encoding and no duplicates.
  Every weight > 0, weights sum to exactly 10000 bps, no zero chainId or token, 1–64 entries.
- `compositionHash = keccak256(abi.encode(allocations))`; event `CompositionPublished(strategyId, version, hash, allocations)`.
- No owner, admin, pause, upgrade, fee or payable function. Holds no tokens.

What it does not prove: that the allocations equal the bag.json behind the `definitionHash` (a contract cannot parse
JSON). BAG compares the two before recording anything, and anyone can do the same with
`lib/domain/basket-protocol/strategy-compositions.ts` (`definitionToAllocations`, `compareComposition`).

## App flow (lib/server/strategy-registration.ts)

The existing user-signed registration loop gets one more step. Once every version is registered, `prepare` returns
`PUBLISH_COMPOSITION` for the **latest registered version** whose weights are not recorded yet (when
`STRATEGY_COMPOSITIONS_ADDRESS_<CHAIN>` is set and the definition can be expressed on-chain). The creator's wallet
signs it; `confirm` records a row in `strategy_compositions` (migration 0057, insert-only) only when the receipt has
exactly one `CompositionPublished` from the configured contract, for this Bag's registered id and a registered
version, with allocations and hash equal to that version's bag.json definition. The server never signs.

The registry panel shows "Weights on-chain" per version, and the creator gets a "Publish vN weights on-chain" button
when that step is open.

Known edge: if a creator publishes different weights directly to the contract, BAG does not record them, and that
version can never be published again (once per version). The panel keeps showing the step for that version; the next
version can be published normally.

## Deploy (the owner runs it; nothing here deploys)

```
npx hardhat compile
npx tsx scripts/deploy-strategy-compositions.ts robinhood
```

Needs `STRATEGY_REGISTRY_ADDRESS_ROBINHOOD` (the live registry; the script checks it is a StrategyRegistry) and a
one-time `DEPLOYER_PRIVATE_KEY` with a little ETH. It reads the contract back (chain, registry, constants, no
balance) and prints `VERIFIED`. Then:

1. Run migration `0057_strategy_compositions.sql` in the Supabase SQL Editor.
2. Set `STRATEGY_COMPOSITIONS_ADDRESS_ROBINHOOD` in Netlify (not secret).
3. Remove `DEPLOYER_PRIVATE_KEY` from `.env.local`.
4. Live test: register a Bag, publish its weights from the panel, and check them with `readOnchainComposition`.
   Until then: **not verified live**.

## Next steps this enables

- Browser and SDK verification of the weights (add the deployed address to the SDK's deployments).
- BAG Router checks a purchase plan against the registered weights instead of trusting a plan signer.
- On-chain purchase receipts and cost basis, then settlement fees computed from on-chain records.

## Tests

- `contracts/test/StrategyCompositions.test.ts`: who and when, canonical form, no economic surface, ABI in sync,
  BAG's helpers against the contract, deployment checks.
- `lib/domain/basket-protocol/__tests__/strategy-compositions.test.ts`: conversion and comparison.
- `lib/server/__tests__/integration/strategy-registration-local-evm.integration.test.ts`: real PostgreSQL + local
  EVM, end to end: publish after registration, refuse weights that are not the bag.json, skip when not configured.
