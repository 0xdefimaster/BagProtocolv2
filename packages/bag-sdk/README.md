# @bag-protocol/sdk — bag.json v1

A BAG strategy as a portable object. This package reads, checks, canonicalizes
and hashes a **bag.json v1** document, and verifies it against StrategyRegistry.
It needs no BAG frontend, server or database.

- Dependencies: `viem` (peer) and standard Web APIs (`fetch`). No framework,
  database, environment variable, endpoint or key in the source. A boundary
  test (`test/boundary.test.ts`) enforces this.
- Network access only through what you pass in (`fetch`, a viem client).
- Status: in-repo package (`private`), not published to npm yet.

```ts
import { fetchBag, parseBag, validateBag, normalizeBag, hashBag, verifyRegistryCommitment } from '@bag-protocol/sdk';

const parsed = parseBag(fileText);            // or: await fetchBag(url)
if (!parsed.ok) throw new Error(parsed.issues.map((i) => `${i.code} ${i.path}`).join('\n'));
const check = validateBag(parsed.bag, { tokens });  // tokens: optional { chain, address, decimals }[] (see readTokenDecimals)
const canonical = normalizeBag(parsed.bag);
const definitionHash = hashBag(canonical);    // == check.definitionHash

// Optional: is this exactly what <creator> committed on-chain?
const v = await verifyRegistryCommitment({ bag: parsed.bag, expectedCreator, registry, client });
```

Pipeline steps:
- `parseBag`: shape and types only.
- `validateBag`: rules.
- `normalizeBag`: canonical copy.
- `hashBag`: `definitionHash`.

Quoting, simulating and compiling a purchase are a separate layer (`quoteBag`,
`simulateBag`, `compileBag`, next PR) and are not part of the artifact.

## Document

```jsonc
{
  "bagJson": 1,            // required
  "definition": { … },     // required — the only hashed part
  "metadata": { … },       // optional, display only
  // Added by BAG when it serves a stored version; optional, never hashed, never authority:
  "definitionHash": "0x…", "ref": { … }, "network": { … }, "commitments": { … }, "forkedFrom": { … }
}
```

A file with only `bagJson` and `definition` is a complete bag.json. It can be
parsed, validated and hashed with no record anywhere. A registry check also
needs `ref` (strategyId and version).

### Definition (hashed)

All keys are required. `null` means "not set by the creator". It is never
replaced by a default. A missing key is an error, not `null`.

| Field | Type |
|---|---|
| `kind` | `"STATIC_BASKET"` \| null |
| `chain` | v1 chain slug (below) |
| `mutability` | `"MUTABLE"` \| `"IMMUTABLE"` \| null |
| `assets[]` | `{ chain, address, decimals, weightBps }`: identity is `chain + address` |
| `rules.weightBounds` | `{ minBps, maxBps }`, each integer \| null |
| `rules.maxAssets` | integer \| null |
| `rules.minInvestment` | `{ amount: canonical decimal string, measuredAs: "PAYMENT_TOKEN_AMOUNT" }` \| null |
| `rules.swapSlippageBps` | integer 1–10000 \| null (0 is recorded as null) |
| `rules.rebalance` | `{ frequency: MANUAL\|DAILY\|WEEKLY\|MONTHLY\|THRESHOLD_ONLY \| null, driftThresholdBps }` \| null |
| `rules.performanceFeeBps` | integer 0–3000 \| null; `0` (no fee) and `null` (not set) hash differently |
| `rules.noRouteAssetPolicy` | `BLOCK` \| `HOLD_INPUT` \| `REFUND` \| null |

Not hashed:
- Display (`metadata`, asset symbols).
- Identity and lineage (`ref`, `forkedFrom`).
- `network`, `commitments`.
- The creator.

## Hash

```
definitionHash = keccak256(utf8("bag.json/v1\n" + JCS(normalize(definition))))
```

- JCS is RFC 8785: keys sorted by UTF-16 code unit, no whitespace, numbers by value.
- `normalize`:
  - EVM addresses are trimmed and lowercased;
  - assets are sorted by `chain`, then `address`, by code unit (never `localeCompare`);
  - exactly the definition's keys are kept, nothing is added.
- Golden vectors: `docs/schemas/bag-json.v1.vectors.json`. They are computed independently (Python JCS + js-sha3) and checked by the tests.

Consequences:
- Asset order, address case and key order do not change the hash.
- Any committed value does change it.
- A fork that changes nothing has the same `definitionHash`. Content identity is not strategy identity.

## Chain and token identity

| Slug | EIP-155 chain id |
|---|---|
| `ethereum` | 1 |
| `base` | 8453 |
| `arbitrum` | 42161 |
| `robinhood` | 4663 |

- The table is closed and defined once (`BAG_V1_CHAINS`). The hash covers the slug, so every reader maps it with this table.
- Adding a chain changes what v1 accepts. It comes only with a controlled spec version.
- A v1 strategy is single-chain: every `assets[].chain` must equal `definition.chain`.
- A token is `chain + address`. The address is 20-byte hex, compared lowercase; the EIP-55 checksum is display only.
- `0x0000000000000000000000000000000000000000` is the native asset.
- `decimals` is hashed. `validateBag` compares it with the token when you pass `tokens`, for example from `readTokenDecimals(definition, clientFor)`. Without `tokens` it warns `DECIMALS_NOT_CHECKED`; it never claims a check it did not do.

## Strict parsing

`parseBag` rejects each of these instead of guessing:

| Input | Code |
|---|---|
| Unknown key | `UNKNOWN_FIELD` |
| Missing key | `MISSING_FIELD` |
| Wrong type | `WRONG_TYPE` |
| A fraction or exponent where an integer is required (`1.0`, `1e0`, `1.5`) | `NOT_AN_INTEGER` |
| A duplicate JSON key | `DUPLICATE_KEY` |
| A non-canonical decimal (`"10.0"`, `"010"`) | `NON_CANONICAL_DECIMAL` |
| A chain outside the table | `UNSUPPORTED_CHAIN` |

Notes:
- `JSON.parse` silently keeps the last duplicate key. That is why duplicate keys are refused.
- Pass the file's **text** to `parseBag`: `1.0` and duplicate keys are only visible there.
- All problems are returned at once.

## Validation

`validateBag` applies BAG's version-creation rules. It is pure and deterministic, with findings in a fixed order.

Definition rules:

| Code | Rule |
|---|---|
| `NO_ASSETS` | At least one asset |
| `TOO_MANY_ASSETS` | At most `maxAssets` and at most 100 |
| `ASSET_CHAIN_MISMATCH` | Asset on another chain |
| `DUPLICATE_ASSET` | Same chain + address, any case |
| `INVALID_DECIMALS` | Decimals 0–18 |
| `DECIMALS_MISMATCH` | Against supplied tokens |
| `INVALID_WEIGHT` | Weight 1–10000 |
| `WEIGHTS_NOT_100` | Weights sum to 10000 ± 2 |
| `BELOW_MIN_WEIGHT`, `ABOVE_MAX_WEIGHT`, `INVALID_WEIGHT_BOUNDS` | Weight bounds |
| `INVALID_PERFORMANCE_FEE` | Fee cap 3000 |
| `INVALID_SLIPPAGE` | Slippage range |
| `INVALID_DRIFT_THRESHOLD` | Drift range |

Document rules:

| Code | Rule |
|---|---|
| `DEFINITION_HASH_MISMATCH` | A stated `definitionHash` must equal the recomputed one |
| `NETWORK_MISMATCH` | `network.chainId` must match the chain table |
| `INVALID_PARENT_VERSION` | `ref.parentVersion` must be `version − 1` (null for version 1) |
| `SELF_FORK` | A fork must be another strategy |
| `METADATA_ASSET_UNKNOWN` | `metadata.assets` may only name definition assets |

A `null` bound is checked against the frozen v1 defaults (`V1_RULE_DEFAULTS`):
- min 100 bps;
- max 7000 bps;
- `maxAssets` max(count, 10).

These defaults are never written into the document or the hash.

Not checked here: BAG's asset allowlist, routes, prices, price impact and deposit size. They depend on the market or a deployment.

## Version, fork and registry

- **Versions:** `1, 2, 3…` inside one strategy, with no gaps. The parent of version N is N−1.
- **Forks:** a fork is a **new** strategy with its own version 1. It records once the exact `(parent strategy, parent version)`.
- **Registry identity:** `registryStrategyId = keccak256(abi.encode(creator, uuidAsBytes32))`. This equals `StrategyRegistry.deriveStrategyId` and `BagFactory.deriveBagId`.

**`creator` is a verification input, not an attested field from the JSON.** The
creator is not in `definitionHash`. `verifyRegistryCommitment` takes the creator
*you expect* and does the following:

1. Derive the strategy id from it.
2. Read the registry.
3. Require that the entry was registered by that creator.
4. Require that `definitionHashOf(id, ref.version)` equals the hash recomputed from `definition`.

`commitments.registry` in a served bag.json, including its `creator`, and the
stated `definitionHash` are never used as authority. If you copy the creator
from the JSON, you only verify what the JSON claims.

## v1 freeze

bag.json v1 semantics are frozen. Changing any of the following requires
**bag.json/v2**, with a new hash domain:
- a hash-relevant field;
- a normalization rule;
- the sorting rule;
- the numeric rule;
- the chain table;
- the validation rules or defaults above;
- the interpretation of a field.

This holds even when the bytes would not change: a change of meaning is a new version.
