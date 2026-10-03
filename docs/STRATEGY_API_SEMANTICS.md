# Strategy API semantics (V2)

How BAG describes a strategy to people and agents: what each endpoint answers,
where every value comes from, and what is deliberately not claimed. Applies to
the HTTP API today and to the future MCP tools built on it.

| Question | Endpoint | Future MCP tool |
|---|---|---|
| What is this strategy? | `GET /api/bags/:id/passport` | `get_strategy` |
| What changed? | `GET /api/bags/:id/versions` | `get_strategy_history` |
| What is allowed? | `POST /api/bags/validate` | `validate_bag` |
| What happened (to me)? | `GET /api/bags/:id/executions` | `get_execution_history` (personal) |

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
