import { beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import bagSchema from '@/docs/schemas/bag.v1.schema.json';
import vectors from '@/docs/schemas/bag-json.v1.vectors.json';

const getBagById = vi.fn();
const listBags = vi.fn();
const loadStrategyObject = vi.fn();
const loadStrategyVersionRows = vi.fn();
const getAssetsByIdentities = vi.fn();
const checkRateLimit = vi.fn();
const getSession = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ isSupabaseConfigured: () => true, supabaseAdmin: () => ({}) }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/server/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a), getClientIp: () => '203.0.113.7', rateLimitedResponseBody: (s: number) => ({ error: 'rate limited', retryAfterSeconds: s }) }));
vi.mock('@/lib/server/bag-repo', () => ({ getBagById: (...a: unknown[]) => getBagById(...a), listBags: (...a: unknown[]) => listBags(...a) }));
vi.mock('@/lib/server/asset-repo', () => ({ getAssetsByIdentities: (...a: unknown[]) => getAssetsByIdentities(...a) }));
vi.mock('@/lib/server/purchase-execution', () => ({ bagSlippageBps: () => 100 }));
vi.mock('@/lib/server/strategy-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/server/strategy-api')>()),
  loadStrategyObject: (...a: unknown[]) => loadStrategyObject(...a),
  loadStrategyVersionRows: (...a: unknown[]) => loadStrategyVersionRows(...a),
}));

import { DELETE, GET, POST } from '@/app/api/mcp/route';
import { definitionInputSchema } from '../bag-mcp-server';
import { buildBagJson } from '@/lib/server/strategy-api';

const ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const activeBag = { id: ID, status: 'ACTIVE', creatorId: 'internal-user-1', chain: 'robinhood', name: 'AI', symbol: 'AI', currentVersion: 1, currentVersionId: 'row-v1', parentBagId: null, createdAt: '2026-09-01T00:00:00Z' };
const draftBag = { ...activeBag, id: DRAFT_ID, status: 'DRAFT' };
const row = {
  id: 'row-v1', version: 1, created_at: '2026-09-01T00:00:00Z', reason: 'Initial', onchain_tx_hash: null, onchain_composition_hash: null,
  recipe: { chain: 'robinhood', name: 'AI', symbol: 'AI', description: '', assets: [{ chain: 'robinhood', address: addr(1), symbol: 'NVDA', decimals: 18, weightBps: 10000 }] },
};
const definition = (rules: Record<string, unknown> = {}) => ({
  kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'MUTABLE',
  assets: [
    { chain: 'robinhood', address: addr(1), symbol: 'NVDA', decimals: 18, weightBps: 5000 },
    { chain: 'robinhood', address: addr(2), symbol: 'AMD', decimals: 18, weightBps: 5000 },
  ],
  rules: { weightBounds: { minBps: null, maxBps: null }, maxAssets: null, minInvestment: null, swapSlippageBps: null, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: null, ...rules },
});

// The official MCP client, speaking Streamable HTTP straight into the route handler.
async function connect() {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://bag.test/api/mcp'), {
    fetch: async (url, init) => {
      const req = new Request(url, init);
      return req.method === 'POST' ? POST(req) : req.method === 'GET' ? GET() : DELETE();
    },
  });
  await client.connect(transport);
  return client;
}
type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;

beforeEach(() => {
  [getBagById, listBags, loadStrategyObject, loadStrategyVersionRows, getAssetsByIdentities, checkRateLimit, getSession].forEach((m) => m.mockReset());
  getBagById.mockImplementation(async (_a: unknown, id: string) => (id === ID ? activeBag : id === DRAFT_ID ? draftBag : null));
  listBags.mockResolvedValue([activeBag]);
  loadStrategyObject.mockResolvedValue({ schemaVersion: 1, strategyId: ID });
  loadStrategyVersionRows.mockResolvedValue([row]);
  getAssetsByIdentities.mockResolvedValue(
    [[1, 'NVDA'], [2, 'AMD']].map(([n, symbol]) => ({ id: symbol, chain: 'robinhood', address: addr(n as number), symbol, decimals: 18, name: symbol, status: 'VERIFIED', assetType: 'stock', createdAt: '', updatedAt: '' }))
  );
  checkRateLimit.mockResolvedValue({ allowed: true });
});

describe('MCP server over Streamable HTTP (official client)', () => {
  it('initializes with instructions and exposes exactly five read-only tools', async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'bag-protocol' });
    expect(client.getInstructions()).toContain('validate_bag is deterministic');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_strategy', 'get_strategy_definition', 'get_strategy_history', 'list_strategies', 'validate_bag']);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    // Nothing that moves funds or signs.
    expect(tools.map((t) => t.name).join(' ')).not.toMatch(/buy|sell|purchase|redeem|execute|sign|send|quote|deploy/);
  });

  it('get_strategy: a public strategy is returned as-is, read anonymously (no session is ever read)', async () => {
    const client = await connect();
    const r = await call(client, 'get_strategy', { strategyId: ID });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ schemaVersion: 1, strategyId: ID });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    expect(loadStrategyObject.mock.calls[0][2]).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('a non-public, unknown or malformed id gives the same "not found" on every strategy tool', async () => {
    const client = await connect();
    const messages = new Set<string>();
    for (const strategyId of [DRAFT_ID, '44444444-4444-4444-8444-444444444444', 'not-a-uuid', "1' or '1'='1"]) {
      for (const [name, extra] of [['get_strategy', {}], ['get_strategy_history', {}], ['get_strategy_definition', { version: 1 }]] as const) {
        const r = await call(client, name, { strategyId, ...extra });
        expect(r.isError).toBe(true);
        messages.add(r.content[0].text);
      }
    }
    expect([...messages]).toEqual(['Strategy not found (unknown id, or not public).']);
    expect(loadStrategyObject).not.toHaveBeenCalled();
    // A malformed id never reaches the database.
    expect(getBagById.mock.calls.map((c) => c[1])).not.toContain('not-a-uuid');
  });

  it('get_strategy_history and get_strategy_definition return the Strategy API objects (bag.json validates)', async () => {
    const client = await connect();
    const history = await call(client, 'get_strategy_history', { strategyId: ID });
    expect(history.structuredContent).toMatchObject({ schemaVersion: 1, strategyId: ID, currentVersion: 1 });
    const def = await call(client, 'get_strategy_definition', { strategyId: ID, version: 1 });
    expect(new Ajv({ strict: false }).compile(bagSchema)(def.structuredContent)).toBe(true);
    expect((def.structuredContent as { definitionHash: string }).definitionHash).toBe(
      (history.structuredContent as { versions: { definitionHash: string }[] }).versions[0].definitionHash
    );
    expect(JSON.stringify(def.structuredContent)).not.toContain('internal-user-1');
    expect((await call(client, 'get_strategy_definition', { strategyId: ID, version: 2 })).isError).toBe(true);
  });

  it('validate_bag: deterministic findings, canonical definition and hash; bad shapes are refused', async () => {
    const client = await connect();
    const r = await call(client, 'validate_bag', { definition: definition() });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { validation: { errors: unknown[] } }).validation.errors).toEqual([]);
    expect(r.structuredContent).toMatchObject({ schemaVersion: 1, validation: { valid: true } });
    const again = await call(client, 'validate_bag', { definition: definition() });
    expect(again.structuredContent).toEqual(r.structuredContent);
    const bad = await call(client, 'validate_bag', { definition: { ...definition(), extra: true } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect(bad.isError).toBe(true);
    const tooHigh = await call(client, 'validate_bag', { definition: definition({ performanceFeeBps: 99999 }) });
    expect(tooHigh.structuredContent).toMatchObject({ validation: { valid: false } });
  });

  it('list_strategies: public strategies only, bounded', async () => {
    listBags.mockResolvedValue([activeBag, draftBag]);
    const client = await connect();
    const r = await call(client, 'list_strategies', { limit: 5 });
    expect((r.structuredContent as { strategies: { strategyId: string }[] }).strategies.map((s) => s.strategyId)).toEqual([ID]);
    expect(listBags.mock.calls[0][1]).toEqual({ status: 'ACTIVE', limit: 5 });
    const over = await call(client, 'list_strategies', { limit: 51 }).catch(() => ({ isError: true }) as Result);
    expect(over.isError).toBe(true);
  });

  it('internal errors never reach the agent', async () => {
    getBagById.mockRejectedValue(new Error('relation "secret_internal_table" does not exist'));
    const client = await connect();
    const r = await call(client, 'get_strategy', { strategyId: ID });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Internal error while reading BAG data.');
  });

  it('publishes the schemas as resources', async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['bag://schemas/bag-json.v1.vectors.json', 'bag://schemas/bag.v1.json', 'bag://schemas/strategy.v1.json']);
    const read = await client.readResource({ uri: 'bag://schemas/bag.v1.json' });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual(bagSchema);
  });
});

describe('validate_bag input schema ↔ bag.json v1', () => {
  it('accepts every published vector and a real bag.json definition; rejects unknown keys', () => {
    for (const v of vectors.vectors) expect(definitionInputSchema.safeParse(v.input).success).toBe(true);
    expect(definitionInputSchema.safeParse(buildBagJson(activeBag as never, row as never).definition).success).toBe(true);
    expect(definitionInputSchema.safeParse({ ...definition(), x: 1 }).success).toBe(false);
    expect(definitionInputSchema.safeParse(definition({ investmentUsd: 1 })).success).toBe(false);
  });

  it('enums match the published JSON Schema', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'validate_bag')!;
    const def = (tool.inputSchema.properties as Record<string, { properties: Record<string, { enum?: unknown[]; anyOf?: { enum?: unknown[] }[] }> }>).definition;
    const enumOf = (p: { enum?: unknown[]; anyOf?: { enum?: unknown[] }[]; type?: unknown }) => (p.enum ?? p.anyOf?.flatMap((x) => x.enum ?? []) ?? []).filter((x) => x !== null).sort();
    expect(enumOf(def.properties.chain)).toEqual([...bagSchema.definitions.chain.enum].sort());
    expect(enumOf(def.properties.kind)).toEqual(bagSchema.definitions.definition.properties.kind.enum.filter((x) => x !== null).sort());
  });
});

describe('/api/mcp HTTP guards', () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    POST(new Request('http://bag.test/api/mcp', { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }));

  it('GET and DELETE are 405 (stateless, JSON responses only)', async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });

  it('rate-limits per IP, refuses oversized and malformed bodies', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    expect((await post('{}')).status).toBe(429);
    expect(checkRateLimit.mock.calls[0][1]).toBe('mcp:ip:203.0.113.7');
    expect((await post('x'.repeat(300 * 1024))).status).toBe(413);
    expect((await post('{', { 'content-length': '1' })).status).toBe(400);
  });
});
