// -----------------------------------------------------------------------------
// Failure classification for the LI.FI / Robinhood RPC diagnostic scripts
// (scripts/spike/lifi-quote-test.ts, scripts/spike/lifi-e2e-execute.ts).
//
// The point is to never collapse different failures into one "it didn't
// work": a sandbox egress proxy denying the host, an unreachable RPC, an RPC
// on the wrong chain, LI.FI not listing the chain, LI.FI having no route for a
// pair, rate limiting and a LI.FI server error all need different fixes.
// Pure functions — no I/O — so the classification itself is unit-tested.
// -----------------------------------------------------------------------------

export type Diagnosis =
  | 'OK'
  | 'ENV_MISSING'
  /** An egress proxy (not the real service) refused the host — e.g. `x-deny-reason: host_not_allowed`. Says nothing about the service. */
  | 'EGRESS_BLOCKED'
  | 'RPC_UNREACHABLE'
  | 'RPC_HTTP_ERROR'
  | 'RPC_JSONRPC_ERROR'
  | 'RPC_WRONG_CHAIN'
  | 'LIFI_UNREACHABLE'
  /** LI.FI lists no tokens for the chain / rejects the chain id. */
  | 'LIFI_UNSUPPORTED_CHAIN'
  /** The chain is known but LI.FI has no route for this pair/amount. */
  | 'LIFI_UNSUPPORTED_ROUTE'
  | 'LIFI_RATE_LIMITED'
  | 'LIFI_AUTH_ERROR'
  | 'LIFI_SERVER_ERROR'
  | 'LIFI_CLIENT_ERROR'
  /** 200, but the body does not describe the request that was sent (stale/cached/wrong response). */
  | 'LIFI_RESPONSE_MISMATCH';

export interface HttpOutcome {
  status: number | null;
  headers: Record<string, string> | null;
  body: unknown;
  rawBody: string | null;
  networkError: string | null;
}

/** An egress/proxy denial carries a deny-reason header or body — never produced by li.quest or a real RPC. */
export function isEgressDenial(o: HttpOutcome): boolean {
  const h = o.headers ?? {};
  const denyHeader = Object.keys(h).some((k) => k.toLowerCase() === 'x-deny-reason');
  const denyBody = typeof o.rawBody === 'string' && /host_not_allowed|egress|proxy.*(denied|blocked)/i.test(o.rawBody);
  return (o.status === 403 || o.status === 407) && (denyHeader || denyBody);
}

export interface RpcOutcome extends HttpOutcome {
  jsonRpcError: unknown | null;
  result: unknown;
}

export function classifyRpcChainId(o: RpcOutcome, expectedChainId: number): { diagnosis: Diagnosis; detail: string } {
  if (o.networkError) return { diagnosis: 'RPC_UNREACHABLE', detail: o.networkError };
  if (isEgressDenial(o)) return { diagnosis: 'EGRESS_BLOCKED', detail: `HTTP ${o.status} from an egress proxy (${o.headers?.['x-deny-reason'] ?? 'deny body'})` };
  if (o.status !== 200) return { diagnosis: 'RPC_HTTP_ERROR', detail: `HTTP ${o.status}` };
  if (o.jsonRpcError) return { diagnosis: 'RPC_JSONRPC_ERROR', detail: JSON.stringify(o.jsonRpcError) };
  const hex = typeof o.result === 'string' ? o.result : null;
  if (!hex || !/^0x[0-9a-f]+$/i.test(hex)) return { diagnosis: 'RPC_JSONRPC_ERROR', detail: `malformed eth_chainId result ${JSON.stringify(o.result)}` };
  const id = parseInt(hex, 16);
  if (id !== expectedChainId) return { diagnosis: 'RPC_WRONG_CHAIN', detail: `RPC reports chain ${id}, expected ${expectedChainId}` };
  return { diagnosis: 'OK', detail: `chain ${id}` };
}

function lifiMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; code?: unknown; errors?: unknown };
    return [b.message, b.code !== undefined ? `code ${String(b.code)}` : null].filter(Boolean).join(' / ');
  }
  return typeof body === 'string' ? body : '';
}

/** Classifies a LI.FI HTTP response (registry or quote). `kind` decides how an empty/404 answer is read. */
export function classifyLifiResponse(o: HttpOutcome, kind: 'registry' | 'quote'): { diagnosis: Diagnosis; detail: string } {
  if (o.networkError) return { diagnosis: 'LIFI_UNREACHABLE', detail: o.networkError };
  if (isEgressDenial(o)) return { diagnosis: 'EGRESS_BLOCKED', detail: `HTTP ${o.status} from an egress proxy — li.quest was never reached` };
  const msg = lifiMessage(o.body) || (o.rawBody ?? '').slice(0, 300);
  if (o.status === 429) return { diagnosis: 'LIFI_RATE_LIMITED', detail: msg };
  if (o.status === 401 || o.status === 403) return { diagnosis: 'LIFI_AUTH_ERROR', detail: msg };
  if (o.status !== null && o.status >= 500) return { diagnosis: 'LIFI_SERVER_ERROR', detail: `HTTP ${o.status}: ${msg}` };
  if (o.status !== 200) {
    if (/chain/i.test(msg) && /(not supported|unsupported|invalid|unknown)/i.test(msg)) return { diagnosis: 'LIFI_UNSUPPORTED_CHAIN', detail: msg };
    if (kind === 'quote' && (o.status === 404 || /no (available )?(quote|route)s?|unable to find|NoQuote/i.test(msg))) {
      return { diagnosis: 'LIFI_UNSUPPORTED_ROUTE', detail: msg };
    }
    return { diagnosis: 'LIFI_CLIENT_ERROR', detail: `HTTP ${o.status}: ${msg}` };
  }
  return { diagnosis: 'OK', detail: 'HTTP 200' };
}

/** Registry-specific: HTTP 200 with zero tokens for the chain means LI.FI does not list the chain. */
export function classifyRegistryTokens(tokenCount: number): { diagnosis: Diagnosis; detail: string } {
  return tokenCount > 0 ? { diagnosis: 'OK', detail: `${tokenCount} tokens` } : { diagnosis: 'LIFI_UNSUPPORTED_CHAIN', detail: 'registry lists zero tokens for the chain' };
}
