import { NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isSupabaseConfigured, supabaseAdmin } from '@/lib/supabase/server';
import { checkRateLimit, getClientIp, rateLimitedResponseBody } from '@/lib/server/rate-limit';
import { createBagMcpServer } from '@/lib/mcp/bag-mcp-server';

// /api/mcp — BAG's MCP server (Model Context Protocol, Streamable HTTP).
// Stateless: a fresh server and transport per request, JSON responses (no SSE
// streams), no session ids. Read-only and anonymous: no cookie or session is
// read, so a browser cannot be used to act with a user's authority.
// Tools and semantics: lib/mcp/bag-mcp-server.ts, docs/MCP.md.

export const dynamic = 'force-dynamic';

const RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 };
const MAX_BODY_BYTES = 256 * 1024;

async function handle(req: Request): Promise<Response> {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase is not configured on this deployment yet.' }, { status: 503 });
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large.' }, { status: 413 });
  }

  const admin = supabaseAdmin();
  const limit = await checkRateLimit(admin, `mcp:ip:${getClientIp(req)}`, RATE_LIMIT);
  if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

  // Read the body once, with a real size check (content-length can be absent or wrong).
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Request body too large.' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, { status: 400 });
  }

  const server = createBagMcpServer({ admin });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req, { parsedBody: body });
  } finally {
    void server.close();
  }
}

export const POST = handle;

// Stateless JSON mode has no standalone SSE stream (GET) and no session to end (DELETE).
const methodNotAllowed = () =>
  NextResponse.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { status: 405, headers: { Allow: 'POST' } });
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
