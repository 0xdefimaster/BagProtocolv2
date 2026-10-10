# Strategy API semantics (V2)

How BAG describes a strategy to people and agents: what each endpoint answers,
where every value comes from, and what is deliberately not claimed. Applies to
the HTTP API and to the MCP server built on it (`docs/MCP.md`).

**Unified Strategy API** (canonical for agents and MCP; schemas in
`docs/schemas/bag.v1.schema.json` and `docs/schemas/strategy.v1.schema.json`):

| Question | Endpoint | MCP tool (`docs/MCP.md`) |
|---|---|---|
| Which strategies exist? | (Explore: `GET /api/bags`) | `list_strategies` |
| What is this strategy? | `GET /api/strategies/:id` | `get_strategy` |
| What changed? | `GET /api/strategies/:id/versions` | `get_strategy_history` |
| What exactly did version N commit to? | `GET /api/strategies/:id/versions/:v` (bag.json) | `get_strategy_definition` |
| What is allowed? | `POST /api/strategies/validate` (bag.json definition) | `validate_bag` |
| What happened (to me)? | `GET /api/users/me/strategies/:id/executions` | not exposed yet (needs agent auth) |

The `/api/bags/*` routes (Passport, Version Timeline, validate, executions)
stay as they are for the app; the Strategy API composes the same builders.

## bag.json v1: definition vs state

bag.json is the canonical **definition** of one strategy version.
Design and rationale: `docs/BAG_JSON_V1_DESIGN.md`.

**What `definitionHash` commits to (one sentence):** `definitionHash` is the
cryptographic commitment to the semantic definition the creator declared for
one strategy version (strategy type, chain, mutability, each asset's identity
`chain + address` with its decimals and target weight, and the creator-declared
rules), and to nothing else: not identity, authorship, version number, lineage,
display metadata, or how BAG enforces the rules.

- **Formula:** `keccak256(utf8("bag.json/v1\n" + JCS(definition)))` (RFC 8785;
  EVM addresses lowercase; assets sorted by chain, then address, by code unit;
  numbers canonical by value, so `1`, `1.0` and `1e0` hash the same). Test
  vectors: `docs/schemas/bag-json.v1.vectors.json`.
- **Rules, not enforcement:** the hash binds the rules the creator declared. It
  does not bind BAG's enforcement mechanism: the same `definitionHash` can be
  enforced differently after a BAG release. The policy view (`policy`) says how
  each rule is enforced today. The hash is not an immutability guarantee of
  behavior.
- **Content vs strategy identity:** a copy or fork that changes nothing has the
  same `definitionHash`; strategy identity is `strategyId` + `version`.
- **Authorship is not hashed; it has its own provenance.** The creator is in the
  Strategy object (`state.creator`); for deployed Bags the on-chain record
  binds the creator: `onChainBagId = keccak256(abi.encode(creator, offChainRef))`
  (`state.onchain.onChainCreator`, `state.onchain.onChainBagId`).
- **Asset identity is `chain + address`.** Symbols are display: they live in
  `metadata.assets` and never change the hash.
- **`metadata` is display only** (name, symbol, description, asset symbols, as
  recorded with the version; current values are in `state.display`). It is
  never a rule: agents must not read intent or constraints from it.

**Standalone SDK:** `packages/bag-sdk` parses, validates, normalizes, hashes
and registry-verifies a bag.json with no BAG server. Its README is the frozen v1
spec. The registry creator is a verification input there, never taken from
`commitments.registry`. It also compiles unsigned purchases (`compileBag`). A purchase
made that way is an execution of the strategy into the buyer's wallet, not a BAG
position: BAG fees apply only to executions explicitly originated and accounted for by BAG.

**`null`, omitted and default**

- Every definition key is required. An omitted key is rejected (400 /
  validation error), never treated as `null`.
- `null` = "not set by the creator in this version": the field is absent from
  the stored recipe. It is never replaced by a default, so a stored version's
  hash never moves when a BAG default changes. The policy view shows which
  default applies.
- An explicit value is kept, including a valid `0` (`performanceFeeBps: 0` is
  "no fee", and hashes differently from `null`).
- The one normalization: `swapSlippageBps` is `null` unless the stored slippage
  is positive. 0 is not a usable slippage (recipe validation rejects it and the
  policy applies the protocol default), so it is recorded as "not set".

**Lineage is authoritative.** `forkedFrom` is outside the hash, but lineage is
economic state: `root_bag_id` decides who is paid the fork royalty. It is set
only by the fork operation (derived server-side from the source Bag), never
from a request, and the database keeps it consistent at insert and immutable
afterwards (`0046_bag_lineage_integrity.sql`).

**On-chain commitment (`commitments.onchainComposition`)**

| `status` | Meaning |
|---|---|
| `MATCHES_RECORDED` | BAG recomputed the on-chain composition hash from the stored recipe and it equals the hash recorded from the version's verified transaction receipt |
| `MISMATCH` | Same comparison, different hashes |
| `NOT_RECORDED` | No on-chain hash recorded for this version (never recorded, or version 1: its deploy-time hash is checked at deploy but not stored) |

`recordedFrom: VERIFIED_TX_RECEIPT`, `comparedBy: BAG` and
`readFromChainThisRequest: false` say how BAG knows it: this response never
reads the chain. The on-chain `compositionHash` has its own (older) canonical
form and is not recomputable from bag.json alone.

**Performance fee:** bag.json keeps the declared fee; once it locks at Bag
level, `state.performanceFee.effectiveBps` is the one that applies.

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
authoritative. A filled swap with no per-step actual counts as on-chain
evidenced (`coveredByTotal`) only when an ONCHAIN_DERIVED `totalReceived`
covers it.

**Redeem receipts**: each output names the holding it sold (`soldAsset` +
`inputAmountRaw`); `input`/`shares` are the legacy share unit and are not
authoritative since A4. `totalReceived` is what reached the wallet in the
output asset, only once every swap filled. In a one-transaction (LI.FI
Composer) redeem every leg pays the same token in the same transaction, so
only the total is observable: it is read from the receipt's Transfer logs
(ONCHAIN_DERIVED) and the legs' own `actualRaw` stay null — an apportionment
is never shown as a per-leg outcome. With one transaction per asset the total
is the sum of the legs' actuals, with the weakest of their sources.

**Settled sales** (fee-paying sales through RedeemSettlement) add an optional
`settlement` block, read from the contract's `Settled` event as verification
recorded it — never a quote: `grossProceedsRaw` (the event's `received`),
`feeBaseRaw`, `performanceFeeRaw`, `netProceedsRaw` (what reached the wallet
= gross − fee), `feeRateBps`, `consumedBasisRaw` (as signed into the
settlement), `realizedPnlRaw` (gross − basis, before the fee) and
`netRealizedPnlRaw` (after it), and `feeReason`: `CHARGED`, `NO_GAIN` (no gain
over basis and earlier losses), `GAIN_TOO_SMALL` (floors to 0) or
`NO_FEE_RATE`. For such a sale `totalReceived` is the gross amount, so the UI
shows the settlement block instead of it.

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
