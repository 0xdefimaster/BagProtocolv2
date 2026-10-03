import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import bagSchema from '@/docs/schemas/bag.v1.schema.json';
import strategySchema from '@/docs/schemas/strategy.v1.schema.json';
import vectors from '@/docs/schemas/bag-json.v1.vectors.json';
import { RebalanceFrequency, STRATEGY_TYPES, SUPPORTED_CHAINS, UNROUTABLE_POLICIES } from '@/types/basket-protocol';
import { getAssetsByIdentities } from '@/lib/server/asset-repo';
import {
  MAX_STRATEGY_LIST,
  buildBagJson,
  buildStrategyVersions,
  listPublicStrategies,
  loadPublicStrategy,
  loadStrategyObject,
  loadStrategyVersionRows,
  parseDefinition,
  validateDefinition,
} from '@/lib/server/strategy-api';
import { ValidateBagInputError } from '@/lib/server/validate-bag';

// -----------------------------------------------------------------------------
// BAG MCP server: the access layer for AI agents over the Unified Strategy API
// (lib/server/strategy-api.ts). Read-only, public data only:
//
//   - Never reads a session or cookie, so it has no ambient authority: every
//     caller is anonymous and sees only ACTIVE strategies.
//   - No tool signs, sends or prepares a transaction, and none quotes a market:
//     `validate_bag` is deterministic (request + asset registry only).
//   - Personal executions (`get_my_executions`) need an agent auth design
//     (OAuth / API keys) and are not exposed yet.
//
// Tools return the API's own objects (structuredContent + the same JSON as
// text); their JSON Schemas are published as resources.
// -----------------------------------------------------------------------------

export const BAG_MCP_SERVER_NAME = 'bag-protocol';
export const BAG_MCP_SERVER_VERSION = '1.0.0';

export const BAG_MCP_INSTRUCTIONS = [
  'BAG strategies are on-chain token baskets ("Bags"). This server is read-only and serves public (ACTIVE) strategies only.',
  'get_strategy returns the Strategy object: `definition` (bag.json v1: what the creator committed to in the current version), `state` (what it looks like now), `policy` (how BAG applies each rule and who enforces it) and `lineage`.',
  'bag.json `null` means "not set by the creator"; the policy view says which protocol default applies. definitionHash = keccak256(utf8("bag.json/v1\\n" + RFC 8785 JCS(definition))).',
  'validate_bag is deterministic: it checks a definition against BAG rules and the asset registry only. It does not quote prices or routes and does not say a purchase will succeed.',
  'Words: "on-chain enforced" means the transaction reverts otherwise; "verified" means BAG checked it; "attested" means BAG states it and it cannot be checked independently; "declared" means the creator states it and nothing executes it.',
  'Schemas: bag://schemas/bag.v1.json and bag://schemas/strategy.v1.json.',
].join('\n');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

// Input schema for validate_bag: bag.json v1 `definition` (docs/schemas/bag.v1.schema.json). Shape only;
// parseDefinition re-checks strictly and validate_bag checks the values.
const FREQUENCIES: [RebalanceFrequency, ...RebalanceFrequency[]] = ['MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY', 'THRESHOLD_ONLY'];
const nullableNumber = z.number().nullable();
export const definitionInputSchema = z
  .object({
    kind: z.enum(STRATEGY_TYPES).nullable(),
    chain: z.enum(SUPPORTED_CHAINS),
    mutability: z.enum(['MUTABLE', 'IMMUTABLE']).nullable(),
    assets: z
      .array(
        z
          .object({ chain: z.enum(SUPPORTED_CHAINS), address: z.string(), symbol: z.string(), decimals: z.number(), weightBps: z.number() })
          .strict()
      )
      .max(100),
    rules: z
      .object({
        weightBounds: z.object({ minBps: nullableNumber, maxBps: nullableNumber }).strict(),
        maxAssets: nullableNumber,
        minInvestment: z
          .object({ amount: z.string().regex(/^\d+(\.\d+)?$/), measuredAs: z.literal('PAYMENT_TOKEN_AMOUNT') })
          .strict()
          .nullable(),
        swapSlippageBps: nullableNumber,
        rebalance: z.object({ frequency: z.enum(FREQUENCIES).nullable(), driftThresholdBps: nullableNumber }).strict().nullable(),
        performanceFeeBps: nullableNumber,
        noRouteAssetPolicy: z.enum(UNROUTABLE_POLICIES).nullable(),
      })
      .strict(),
  })
  .strict();

const strategyId = z.string().describe('Strategy id (the Bag UUID), e.g. from list_strategies.');

function ok(value: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}
function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
const NOT_FOUND = 'Strategy not found (unknown id, or not public).';

/** Unexpected errors are reported without internals (no database messages reach the agent). */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidateBagInputError) return fail(err.message);
    return fail('Internal error while reading BAG data.');
  }
}

export interface BagMcpDeps {
  admin: SupabaseClient;
}

export function createBagMcpServer({ admin }: BagMcpDeps): McpServer {
  const server = new McpServer({ name: BAG_MCP_SERVER_NAME, version: BAG_MCP_SERVER_VERSION }, { instructions: BAG_MCP_INSTRUCTIONS });

  server.registerTool(
    'list_strategies',
    {
      title: 'List strategies',
      description: `Newest public BAG strategies (at most ${MAX_STRATEGY_LIST}). Display fields only; call get_strategy for the full object.`,
      inputSchema: { limit: z.number().int().min(1).max(MAX_STRATEGY_LIST).optional().describe(`1-${MAX_STRATEGY_LIST}, default 20.`) },
      annotations: READ_ONLY,
    },
    ({ limit }) => guarded(async () => ok({ strategies: await listPublicStrategies(admin, limit ?? 20) }))
  );

  server.registerTool(
    'get_strategy',
    {
      title: 'Get strategy',
      description: 'The Strategy object: definition (bag.json v1 of the current version), state, policy and lineage. Schema: bag://schemas/strategy.v1.json#/definitions/strategy.',
      inputSchema: { strategyId },
      annotations: READ_ONLY,
    },
    ({ strategyId: id }) =>
      guarded(async () => {
        const bag = await loadPublicStrategy(admin, id);
        if (!bag) return fail(NOT_FOUND);
        return ok(await loadStrategyObject(admin, bag, null));
      })
  );

  server.registerTool(
    'get_strategy_history',
    {
      title: 'Get strategy history',
      description: 'Every version of a strategy, newest first, with its bag.json definitionHash and on-chain commitment. Schema: bag://schemas/strategy.v1.json#/definitions/versions.',
      inputSchema: { strategyId },
      annotations: READ_ONLY,
    },
    ({ strategyId: id }) =>
      guarded(async () => {
        const bag = await loadPublicStrategy(admin, id);
        if (!bag) return fail(NOT_FOUND);
        return ok(buildStrategyVersions(bag, await loadStrategyVersionRows(admin, bag.id)));
      })
  );

  server.registerTool(
    'get_strategy_definition',
    {
      title: 'Get strategy definition (bag.json)',
      description: 'bag.json v1 of one version: exactly what the creator committed to. A stored version never changes. Schema: bag://schemas/bag.v1.json.',
      inputSchema: { strategyId, version: z.number().int().min(1).describe('Version number, from get_strategy_history.') },
      annotations: READ_ONLY,
    },
    ({ strategyId: id, version }) =>
      guarded(async () => {
        const bag = await loadPublicStrategy(admin, id);
        if (!bag) return fail(NOT_FOUND);
        const row = (await loadStrategyVersionRows(admin, bag.id)).find((r) => r.version === version);
        if (!row) return fail(`Version ${version} not found.`);
        return ok(buildBagJson(bag, row));
      })
  );

  server.registerTool(
    'validate_bag',
    {
      title: 'Validate a strategy definition',
      description:
        'Deterministic check of a bag.json v1 definition against BAG rules and the asset registry. Returns findings, the policy it was checked against, the canonical definition and its definitionHash. Does not quote prices or routes. Use null for "not set". Schema: bag://schemas/strategy.v1.json#/definitions/validation.',
      inputSchema: { definition: definitionInputSchema },
      annotations: READ_ONLY,
    },
    ({ definition }) =>
      guarded(async () => {
        const parsed = parseDefinition({ definition });
        const identities = parsed.assets.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address)).map((a) => ({ chain: a.chain, address: a.address }));
        return ok(validateDefinition(parsed, await getAssetsByIdentities(admin, identities)));
      })
  );

  const jsonResource = (name: string, uri: string, description: string, value: unknown, mimeType = 'application/schema+json') =>
    server.registerResource(name, uri, { description, mimeType }, async () => ({ contents: [{ uri, mimeType, text: JSON.stringify(value) }] }));
  jsonResource('bag-json-v1-schema', 'bag://schemas/bag.v1.json', 'JSON Schema of bag.json v1.', bagSchema);
  jsonResource('strategy-v1-schema', 'bag://schemas/strategy.v1.json', 'JSON Schema of the Unified Strategy API responses (references bag.v1.json).', strategySchema);
  jsonResource('bag-json-v1-vectors', 'bag://schemas/bag-json.v1.vectors.json', 'definitionHash test vectors: input, canonical form, preimage, hash.', vectors, 'application/json');

  return server;
}
