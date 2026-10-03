# Strategy API semantics (V2)

How BAG describes a strategy to people and agents: what each endpoint answers,
where every value comes from, and what is deliberately not claimed. Applies to
the HTTP API today and to the future MCP tools built on it.

**Unified Strategy API** (canonical for agents and MCP; schemas in
`docs/schemas/bag.v1.schema.json` and `docs/schemas/strategy.v1.schema.json`):

| Question | Endpoint | Future MCP tool |
|---|---|---|
| What is this strategy? | `GET /api/strategies/:id` | `get_strategy` |
| What changed? | `GET /api/strategies/:id/versions` | `get_strategy_history` |
| What exactly did version N commit to? | `GET /api/strategies/:id/versions/:v` (bag.json) | `get_strategy_definition` |
| What is allowed? | `POST /api/strategies/validate` (bag.json definition) | `validate_bag` |
| What happened (to me)? | `GET /api/users/me/strategies/:id/executions` | `get_my_executions` |

The `/api/bags/*` routes (Passport, Version Timeline, validate, executions)
stay as they are for the app; the Strategy API composes the same builders.

## bag.json v1: definition vs state

bag.json is the canonical **definition** of one strategy version: only what the
creator committed to in that version (assets, weights, rules, mutability).
Design and rationale: `docs/BAG_JSON_V1_DESIGN.md`.

- **Not in bag.json:** state (NAV, TVL, holders, route checks), BAG's
  enforcement claims (the policy view) and execution data (receipts).
- **`null` = not set by the creator.** Defaults are never written into
  bag.json, so a stored version's document and hash never change when a BAG
  default changes. The policy view shows which default applies today.
- **`definitionHash`** = `keccak256(utf8("bag.json/v1\n" + JCS(definition)))`
  (RFC 8785; EVM addresses lowercase; assets sorted by chain, then address,
  by code unit). Covers the definition only: identity (`ref`), display
  `metadata`, `network` and `commitments` are not hashed. Test vectors:
  `docs/schemas/bag-json.v1.vectors.json`.
- **Content vs strategy identity:** two Bags with the same definition share a
  `definitionHash`; their strategy identity (`strategyId` + `version`) differs.
- **`metadata`** holds display values as recorded with the version; the
  current (freely editable) ones are in the Strategy object's `state.display`.
- **Performance fee:** bag.json keeps the declared fee; once it locks at Bag
  level, `state.performanceFee.effectiveBps` is the one that applies.
- **`commitments.compositionCommittedOnchain`:** BAG re-derived the on-chain
  composition hash from the stored recipe and compared it with the recorded
  one. A BAG check, not a chain read. The on-chain `compositionHash` uses its
  own (older) canonical form and is not recomputable from bag.json alone.

## Validation vs quoting: three separate capabilities

Keep these apart, in the API and in MCP:

| Capability | Depends on | Status |
|---|---|---|
| `validate_bag` | the request + the asset registry only. Deterministic. | Exists (`schemaVersion: 2`) |
| `quote_bag` | the market: live routes, prices, price impact | Not built |
| `validate_purchase` | a specific deposit: amount, input token, current routes and market | Not built |

`validate_bag` refuses purchase-time inputs (`investmentUsd`, `amount`,
`inputAsset`) instead of silently ignoring them, and states its own scope in the
response (`scope.dependsOn`, `scope.excludes`).

## Personal executions vs strategy execution provenance

Two different questions, which must not be merged into one endpoint:

- **Personal execution history** ("my executions"): private. Today's
  `GET /api/bags/:id/executions` returns only the signed-in user's own receipts
  (`scope: VIEWER_OWN_EXECUTIONS`). Keep this model.
- **Strategy execution provenance** ("how has this strategy executed?":
  providers used, success/revert rates, realized vs minimum output): may become
  aggregate and public, but must never expose individual wallets or execution
  ids. A future design should give it its own path (e.g.
  `/strategies/:id/executions` for aggregates vs `/users/me/strategies/:id/executions`
  for personal receipts).

## Execution receipts: public contract (schemaVersion 2)

JSON Schema: `docs/schemas/execution-history.v2.schema.json`; TypeScript:
`types/execution-receipt.ts`. A test keeps the two in sync. The contract is
independent of BAG's internal state machines: internal statuses are mapped
and never exposed.

**Outcome (receipt)**

| Internal intent status | `outcome` | `isFinal` |
|---|---|---|
| COMPLETED | SUCCEEDED | true |
| PARTIAL_SUCCESS | PARTIAL | false (advances to reconciliation) |
| RECONCILIATION_REQUIRED | PARTIAL | true |
| FAILED | FAILED | true |
| SUBMITTED, CONFIRMING | PENDING | false |
| anything else / unknown | UNKNOWN | per terminal set |

Draft/quote/expired/cancelled intents are not executions and are never
returned. PARTIAL only happens when swaps run as separate transactions; a
single Composer or BAG Router transaction is all-or-nothing.

**Outcome (step)**: FILLED (swap verified), HELD (keep step: no swap, stayed
in the input token), FAILED, PENDING (tx submitted, not verified),
NOT_SUBMITTED (no tx ever submitted), UNKNOWN.

**Evidence summary** (`evidence.level`, over FILLED swaps only; keep steps
and quotes never count): ONCHAIN (every actual output ONCHAIN_DERIVED),
PROVIDER (every filled swap has an actual output, at least one only
PROVIDER_REPORTED), PARTIAL (a filled swap has no recorded actual output),
NONE (nothing filled). It summarizes; each output's `actualSource` stays
authoritative.

**Pagination**: newest first (`createdAt` desc, then `executionId` asc, at
microsecond precision). `?limit=` 1–50 (default 50); `hasMore` and an opaque
`nextCursor` (pass back as `?cursor=`). The same cursor always returns the
same page. A cursor is bound to its Bag, only moves the position within the
caller's own executions, and is validated before it reaches any query.

**Identity**: assets (including skipped no-route assets) are identified by
`chain` + `address`; `symbol` is display only. `chainId` (EIP-155) comes from
BAG's chain config, never from the request; null for non-EVM chains.

**Forward-open fields**: `blockNumber`, `blockTimestamp` and
`policySnapshotAvailable` are typed for real values (`number | null`,
`string | null`, `boolean`) even though they are null/false today.

## Execution receipts: known limitations

These are deliberate and documented, not bugs. Receipts never paper over them.

1. **No policy snapshot.** BAG does not store the full policy as it was at
   execution time. Receipts say `policySnapshotAvailable: false` and only
   reference the strategy version the execution used (`evaluatedAgainstVersion`).
   Today's policy must never be presented as the policy at execution. Saying
   "Execution #912 ran under Strategy v5 / Policy v3" needs an immutable policy
   history (planned with Strategy Commitment), not a reconstruction.
2. **Sequential LI.FI actual output.** The sequential path verifies through
   LI.FI's status API or, as a same-chain fallback, the transaction receipt;
   which one was used is not recorded. Its actual output is therefore labelled
   `PROVIDER_REPORTED` (the weaker claim), and `null` when no minimum forced a
   received amount to exist. Raising this to `ONCHAIN_DERIVED` needs the
   sequential adapter to record its exact verification source.
3. **Approval transactions are not verified.** Approval tx hashes are reported
   by the client and never checked. They are labelled `REPORTED_UNVERIFIED`;
   the point is not that they are unverified, but that they are never called
   verified.

Also not recorded today, so always `null` in receipts: block number and block
timestamp, the strategy version of a redeem, and the quote of a step that
completed (it is replaced by the verified amount).

## Words

- **guaranteed / on-chain enforced**: only for rules the transaction itself
  reverts on (today: the per-swap minimum output, `maxSlippageBps`).
- **verified**: BAG checked it against the execution. Never used for values BAG
  only stored.
- **attested**: BAG's own claim that cannot be checked independently.
- **declared**: stated by the creator; nothing executes it.
- **on-chain record**: BAG's record of a confirmed transaction. Checkable via the
  tx hash; not re-read from the chain per request (`readFromChainThisRequest: false`).
