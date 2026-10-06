# bag.json v1 + Unified Strategy API (PR #5) — design draft

Status: implemented in PR #5. Decisions taken on the open questions (§7):
version-time display metadata, keccak256, `/api/strategies/*` alongside
`/api/bags/*`, `null` for fields a legacy recipe lacks. Implementation notes:
`ref.strategyId` (not `bagId`) and `forkedFrom.strategyId`; validate also
checks declared asset decimals against the registry (`DECIMALS_MISMATCH`).

Review follow-up (security/semantics patch): asset `symbol` moved out of the
definition into `metadata.assets` (identity is chain + address);
`compositionCommittedOnchain` replaced by `commitments.onchainComposition`
(`status`, `recordedFrom`, `comparedBy`, `readFromChainThisRequest`); creator
stays outside `definitionHash` (authorship has its own on-chain provenance);
fork lineage is set only server-side and immutable (0046). The current contract
is in `docs/STRATEGY_API_SEMANTICS.md`; the examples below predate this patch.

**v1 is frozen (SDK PR).** The standalone SDK (`packages/bag-sdk`, spec in its
README) is the single implementation of parse/validate/normalize/hash; the app
re-exports its canonicalization. Decisions recorded with it:
- D1: closed chain table (`ethereum` 1, `base` 8453, `arbitrum` 42161, `robinhood` 4663), defined once (`BAG_V1_CHAINS`).
- D2: single-chain strategies.
- D3: a minimal document `{ bagJson, definition, metadata? }` is complete.
- D4: `creator` is a verification input, never read from the JSON.
- D5: strict parsing.
- Weights sum to exactly 10000; the deposit split (floor, largest remainder, ties by `chain:address`) is normative. Version creation now requires exactly 10000 too; the purchase path always did.
- The `null` → default table (`resolveV1Rules`) is normative and frozen. Defaults are still never written into the document or the hash.
- The core never fetches. Transport lives in adapters (`/http`, `/evm`).

Changing any hash-relevant field, normalization, sorting or numeric rule, the
chain table, the validation rules or the meaning of a field requires
`bag.json/v2`.

Goal: one canonical Strategy object that the HTTP API and later MCP serve,
built from what BAG already stores. No smart-contract change, no DB schema
change, V1 purchase/redeem/execution flows untouched.

## 1. Layers

| Layer | Answers | Changes when | Source |
|---|---|---|---|
| **bag.json** (definition) | What did the creator commit to in version N? | Only with a new version | `bag_versions.recipe` |
| **State** (Passport today) | What does the strategy look like now? | Any time (NAV, TVL, routes, fee lock) | DB + derived |
| **Policy view** | How does BAG apply each rule, who enforces it? | With a BAG release or a version | `deriveStrategyPolicy` |
| **Evidence** (Receipts) | What happened when it executed? | Per execution | intents + tx claims |
| **Access** (MCP, later) | How does an agent reach the above? | — | Unified API |

bag.json carries **only creator-declared, version-scoped values**. It never
carries state (NAV, TVL, holders, route status), enforcement metadata (that is
BAG's claim about itself and can change with a release), or execution data.

## 2. Findings in today's code that shape the design

1. **Display metadata is mutable without a version.** `updateBagMetadata`
   edits `name` / `symbol` / `description` freely; `recipe` keeps the value from
   version time. → metadata is outside the hashed definition.
2. **The effective performance fee is Bag-level, not version-level.** Once the
   first external investor arrives, `bags.performance_fee_bps_locked` wins over
   `recipe.performanceFeeBps`. → bag.json records the *declared* fee; the
   effective (locked) fee belongs to state/policy.
3. **Unset fields fall back to today's defaults** (`unroutablePolicy`,
   `performanceFeeBps`, slippage). If bag.json filled in defaults, an old
   version's bag.json — and its hash — would change whenever a default changes.
   → bag.json writes `null` for "not set by the creator"; the policy view says
   which default applies today.
4. **`compositionHash` is not reproducible from public data.** It is built from
   addresses *as stored* (not case-normalized) and sorted with `localeCompare`
   (locale-dependent). It stays as is: it is committed on-chain and changing it
   would break the version-confirm check. bag.json gets its own hash with strict
   canonicalization, and links the on-chain commitment instead of replacing it.
5. **Slippage lives in `rebalanceRule.maxSlippageBps`** but is applied as the
   per-swap purchase minimum. bag.json names it for what it does
   (`swapSlippageBps`), sourced from the same field.

## 3. bag.json v1 shape

```jsonc
{
  "bagJson": 1,                         // format version of this document
  "definition": {                       // ← the only hashed part
    "kind": "STATIC_BASKET",
    "chain": "robinhood",
    "mutability": "MUTABLE",
    "assets": [                         // sorted by (chain, address), codepoint order
      { "chain": "robinhood", "address": "0x…lowercase", "symbol": "TSLA", "decimals": 18, "weightBps": 5000 }
    ],
    "rules": {
      "weightBounds": { "minBps": 500, "maxBps": 6000 },
      "maxAssets": 10,
      "minInvestment": { "amount": "10", "measuredAs": "PAYMENT_TOKEN_AMOUNT" },
      "swapSlippageBps": 100,           // null = not set, protocol default applies
      "rebalance": { "frequency": "THRESHOLD_ONLY", "driftThresholdBps": 500 },
      "performanceFeeBps": 1000,        // declared; null = not set
      "noRouteAssetPolicy": "HOLD_INPUT" // BLOCK | HOLD_INPUT | REFUND; null = not set
    }
  },
  "definitionHash": "0x…",             // keccak256 of the canonical definition (§4)

  // Not hashed: identity, display and links.
  "ref": { "strategyId": "uuid", "version": 3, "parentVersion": 2, "createdAt": "…" },
  "network": { "chainId": 4663 },      // EIP-155, from BAG chain config
  "metadata": { "name": "…", "symbol": "…", "description": "…" },   // as recorded with this version
  "commitments": {
    "onchainCompositionHash": "0x…" | null,
    "onchainTxHash": "0x…" | null,
    "compositionCommittedOnchain": true | false | null,  // BAG re-derived the hash from this version's stored recipe
    "registry": { "status": "REGISTERED" | "NOT_REGISTERED", … }  // StrategyRegistry commitment of this definitionHash (docs/STRATEGY_REGISTRY_DESIGN.md §8)
  },
  "forkedFrom": { "strategyId": "uuid", "version": 3 } | null   // the parent version the fork was made from (0052); null only for forks made before it was recorded
}
```

Why the definition hash excludes `ref`: two Bags with identical rules (e.g.
a fork that changed nothing) share a `definitionHash` — *content identity* —
while keeping separate *strategy identity* (`bagId` + `version`).

## 4. Canonicalization and hash

- Only integers, strings, booleans, null — no floats (`minInvestment.amount`
  is a decimal string).
- EVM addresses lowercase; assets sorted by `chain`, then `address`, by UTF-16
  code unit (never `localeCompare`).
- Serialized with RFC 8785 (JCS): sorted keys, no whitespace.
- `definitionHash = keccak256(utf8("bag.json/v1\n" + JCS(definition)))` — a
  domain prefix so the bytes can never collide with another BAG hash; keccak so a
  future contract can commit to it directly.
- Published test vectors in `docs/schemas/` so anyone can recompute it.

## 5. Unified Strategy API

New, versioned read endpoints. Existing `/api/bags/*` routes stay unchanged.

| Endpoint | Returns | MCP tool (PR #6) |
|---|---|---|
| `GET /api/strategies/:id` | Strategy object: `definition` (current bag.json), `state`, `policy`, `lineage` summary, links | `get_strategy` |
| `GET /api/strategies/:id/versions` | version list: `version`, `definitionHash`, on-chain commitment, `createdAt`, `reason` | `get_strategy_history` |
| `GET /api/strategies/:id/versions/:v` | bag.json of that version | `get_strategy_definition` |
| `POST /api/strategies/validate` | `validate_bag` on a bag.json `definition` (same engine, same result shape) | `validate_bag` |
| `GET /api/users/me/strategies/:id/executions` | personal receipts (receipt v2, unchanged; same handler as today's route) | `get_my_executions` |
| `/api/strategies/:id/executions` | **reserved** for aggregate provenance; not built in PR #5 | — |

The Strategy object composes existing builders (`strategy-passport`,
`bag-version-timeline`, `strategy-policy`); no business logic is duplicated.
Visibility rules are the Passport's: non-public Bags are 404 unless the viewer
is the creator. No internal ids (user ids, row ids, route fingerprints).

```jsonc
{
  "schemaVersion": 1,
  "strategyId": "uuid",
  "definition": { /* bag.json of the current version */ },
  "state":   { "status", "tvlUsd", "navPerShare", "holders", "routeStatus": [...], "effectivePerformanceFeeBps", "feeLocked", "sourceInfo" },
  "policy":  { /* StrategyPolicy v2, unchanged */ },
  "lineage": { "currentVersion", "versionCount", "forkedFrom", "forkCount" },
  "links":   { "versions": "...", "myExecutions": "...", "passport": "..." }
}
```

## 6. Out of scope for PR #5

- MCP server (PR #6), aggregate execution provenance, `quote_bag`,
  `validate_purchase`.
- Committing `definitionHash` on-chain (needs a contract change).
- Policy snapshots per execution (known limitation stays).
- Changing `compositionHash` canonicalization (§2.4).

## 7. Open questions (with recommendation)

1. **Display metadata in bag.json**: version-time values from `recipe`
   (recommended: matches what was committed; current values are in `state`)
   or current values from `bags`?
2. **Hash function**: keccak256 (recommended, EVM-native) or sha256?
3. **Route prefix**: `/api/strategies/*` alongside `/api/bags/*`
   (recommended) or a `/api/v1/` prefix?
4. **Legacy versions** whose recipe lacks a field: `null` (recommended) or
   omit the key?

## 8. Test plan

- Canonicalization: key order, asset order, address case and input order do
  not change the hash; any rule/asset change does; metadata edits do not.
- Hash test vectors checked into the repo and verified in CI.
- Old-version stability: bag.json of a stored version is byte-identical
  before and after a protocol default changes.
- JSON Schema ↔ TypeScript sync (same pattern as receipt v2).
- Route security: private Bag 404, no internal ids, personal executions stay
  scoped to the viewer.
