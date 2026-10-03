# BAG MCP server

BAG's access layer for AI agents: a [Model Context Protocol](https://modelcontextprotocol.io)
server over the Unified Strategy API (`docs/STRATEGY_API_SEMANTICS.md`).

- Endpoint: `POST /api/mcp` (Streamable HTTP, stateless, JSON responses).
- Implementation: `lib/mcp/bag-mcp-server.ts`, route `app/api/mcp/route.ts`.

## Connect

Any MCP client that speaks Streamable HTTP. For example, Claude Code:

```bash
claude mcp add --transport http bag https://<your-bag-v2-host>/api/mcp
```

No API key: every tool is read-only and serves public data.

## Tools

| Tool | Answers | Returns (schema) |
|---|---|---|
| `list_strategies` | Which public strategies exist? (newest first, `limit` 1–50) | `{ strategies: [...] }` |
| `get_strategy` | What is this strategy? | Strategy object (`strategy.v1.json#/definitions/strategy`) |
| `get_strategy_history` | What changed, version by version? | versions (`strategy.v1.json#/definitions/versions`) |
| `get_strategy_definition` | What exactly did version N commit to? | bag.json v1 (`bag.v1.json`) |
| `validate_bag` | Is this definition allowed by BAG's rules? | validation (`strategy.v1.json#/definitions/validation`) |

Each result carries the object as `structuredContent` and the same JSON as text.

Resources: `bag://schemas/bag.v1.json`, `bag://schemas/strategy.v1.json`,
`bag://schemas/bag-json.v1.vectors.json` (definitionHash test vectors).

## Semantics (kept from the API)

- `validate_bag` is **deterministic**: the request plus the asset registry
  only. It never quotes prices or routes and never says a purchase will
  succeed. `quote_bag` and `validate_purchase` (market-dependent) do not exist.
- bag.json `null` means "not set by the creator"; the policy view says which
  protocol default applies.
- Provenance words mean the same as in the API: on-chain enforced, verified,
  attested, declared.

## Security model

- **Anonymous and read-only.** The route never reads a session or cookie, so a
  browser cannot be used to act with a signed-in user's authority, and an agent
  sees exactly what a logged-out visitor sees: ACTIVE strategies only.
- **No transactions.** No tool builds, signs, sends or prepares a transaction.
- **Uniform not-found.** Unknown, malformed and non-public ids return the same
  error; malformed ids never reach the database.
- **No internals.** Unexpected errors return a generic message; no database
  error text, user ids or row ids reach the agent.
- **Limits.** 60 requests per minute per IP (the existing database-backed rate
  limiter), 256 KB bodies, at most 100 assets per definition. GET/DELETE are 405.

## Not included yet

- **Personal executions** (`get_my_executions`): needs an agent auth design
  (OAuth or API keys bound to a wallet). The HTTP route
  `GET /api/users/me/strategies/:id/executions` exists for signed-in users.
- Aggregate strategy-level execution provenance (`/api/strategies/:id/executions`).
- Any write or transaction tool.
