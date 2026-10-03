import { describe, expect, it } from 'vitest';
import { classifyLifiResponse, classifyRegistryTokens, classifyRpcChainId, HttpOutcome } from '../lifi-diagnostics';

const http = (o: Partial<HttpOutcome>): HttpOutcome => ({ status: 200, headers: {}, body: null, rawBody: '', networkError: null, ...o });

describe('classifyRpcChainId — every RPC failure mode is distinct', () => {
  const rpc = (o: Partial<HttpOutcome> & { jsonRpcError?: unknown; result?: unknown }) => ({ ...http(o), jsonRpcError: o.jsonRpcError ?? null, result: o.result ?? null });
  it('network error → RPC_UNREACHABLE', () => expect(classifyRpcChainId(rpc({ status: null, networkError: 'ECONNREFUSED' }), 4663).diagnosis).toBe('RPC_UNREACHABLE'));
  it('sandbox proxy denial → EGRESS_BLOCKED (not an RPC verdict)', () =>
    expect(classifyRpcChainId(rpc({ status: 403, headers: { 'x-deny-reason': 'host_not_allowed' } }), 4663).diagnosis).toBe('EGRESS_BLOCKED'));
  it('HTTP 502 → RPC_HTTP_ERROR', () => expect(classifyRpcChainId(rpc({ status: 502 }), 4663).diagnosis).toBe('RPC_HTTP_ERROR'));
  it('JSON-RPC error → RPC_JSONRPC_ERROR', () => expect(classifyRpcChainId(rpc({ jsonRpcError: { code: -32601 } }), 4663).diagnosis).toBe('RPC_JSONRPC_ERROR'));
  it('wrong chain → RPC_WRONG_CHAIN', () => expect(classifyRpcChainId(rpc({ result: '0x1' }), 4663)).toMatchObject({ diagnosis: 'RPC_WRONG_CHAIN', detail: expect.stringMatching(/chain 1/) }));
  it('0x1237 → OK (4663)', () => expect(classifyRpcChainId(rpc({ result: '0x1237' }), 4663).diagnosis).toBe('OK'));
});

describe('classifyLifiResponse — chain vs route vs transport', () => {
  it('network error → LIFI_UNREACHABLE', () => expect(classifyLifiResponse(http({ status: null, networkError: 'ETIMEDOUT' }), 'quote').diagnosis).toBe('LIFI_UNREACHABLE'));
  it('proxy denial → EGRESS_BLOCKED', () => expect(classifyLifiResponse(http({ status: 403, rawBody: 'host_not_allowed' }), 'registry').diagnosis).toBe('EGRESS_BLOCKED'));
  it('404 "No available quotes" → LIFI_UNSUPPORTED_ROUTE', () =>
    expect(classifyLifiResponse(http({ status: 404, body: { message: 'No available quotes for the requested transfer', code: 1002 } }), 'quote').diagnosis).toBe('LIFI_UNSUPPORTED_ROUTE'));
  it('400 "chain is not supported" → LIFI_UNSUPPORTED_CHAIN', () =>
    expect(classifyLifiResponse(http({ status: 400, body: { message: 'Chain 4663 is not supported' } }), 'quote').diagnosis).toBe('LIFI_UNSUPPORTED_CHAIN'));
  it('429 → LIFI_RATE_LIMITED; 401 → LIFI_AUTH_ERROR; 503 → LIFI_SERVER_ERROR; other 4xx → LIFI_CLIENT_ERROR', () => {
    expect(classifyLifiResponse(http({ status: 429 }), 'quote').diagnosis).toBe('LIFI_RATE_LIMITED');
    expect(classifyLifiResponse(http({ status: 401 }), 'quote').diagnosis).toBe('LIFI_AUTH_ERROR');
    expect(classifyLifiResponse(http({ status: 503 }), 'quote').diagnosis).toBe('LIFI_SERVER_ERROR');
    expect(classifyLifiResponse(http({ status: 422, body: { message: 'fromAmount invalid' } }), 'quote').diagnosis).toBe('LIFI_CLIENT_ERROR');
  });
  it('registry with zero tokens → LIFI_UNSUPPORTED_CHAIN', () => expect(classifyRegistryTokens(0).diagnosis).toBe('LIFI_UNSUPPORTED_CHAIN'));
});
