import { keccak256, type Hex } from 'viem';
import { redactRpcUrl, RpcEndpoint } from './endpoints';

// -----------------------------------------------------------------------------
// One JSON-RPC client over an ordered list of endpoints (primary → secondary →
// public). The rest of BAG talks to it through a viem transport
// (lib/blockchain/rpc/clients.ts) and never knows which provider answered.
//
// READS: per-request timeout; on a transport failure (timeout, network, HTTP
//   error, rate limit, "node behind" JSON-RPC errors) the next endpoint is
//   tried; at most `maxRounds` passes over the list with exponential backoff
//   between passes. A deterministic JSON-RPC error (execution reverted,
//   invalid params, …) is returned immediately — asking another node would
//   give the same answer.
// CIRCUIT BREAKER: `circuitFailureThreshold` consecutive failures open an
//   endpoint's circuit for `circuitCooldownMs`; it is skipped until then, then
//   probed again (half-open). If every circuit is open, they are still tried
//   (last) rather than failing without a request.
// STALE DETECTION: every eth_blockNumber answer is recorded per endpoint; an
//   endpoint more than `staleBlockLag` blocks behind the best one seen is
//   demoted behind fresh endpoints until it catches up.
// TRANSACTIONS: eth_sendRawTransaction is NEVER blindly re-broadcast. The hash
//   is computed locally first. After an ambiguous failure (timeout, network,
//   5xx) the hash is looked up on every endpoint; if any node knows it, the
//   transaction was accepted and that hash is returned. Only when no node
//   knows it is the next endpoint used. If all endpoints fail,
//   `TransactionBroadcastUnknownError` carries the hash so the caller checks
//   again later — it never means "not sent".
// LOGGING: structured JSON events; endpoint URLs are redacted (API keys live
//   in the path).
// -----------------------------------------------------------------------------

export type RpcLogger = (level: 'info' | 'warn', event: string, fields: Record<string, unknown>) => void;

export const defaultRpcLogger: RpcLogger = (level, event, fields) => {
  if (level === 'warn') console.warn(JSON.stringify({ level, event, ...fields }));
};

export class JsonRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export class RpcTransportError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'RpcTransportError';
  }
}

export class RpcUnavailableError extends Error {
  constructor(public readonly chain: string, public readonly method: string, public readonly lastError?: unknown) {
    super(`All RPC endpoints failed for ${chain} ${method}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
    this.name = 'RpcUnavailableError';
  }
}

export class TransactionBroadcastUnknownError extends Error {
  constructor(public readonly chain: string, public readonly txHash: Hex, public readonly lastError?: unknown) {
    super(`Broadcast of ${txHash} on ${chain} could not be confirmed by any RPC endpoint. It may still be pending — check by hash before retrying.`);
    this.name = 'TransactionBroadcastUnknownError';
  }
}

/** JSON-RPC errors that mean "this node cannot answer now", not "the answer is an error". */
const RETRYABLE_RPC_CODES = new Set([-32005, -32603, 429]);
const RETRYABLE_RPC_MESSAGE = /rate limit|too many requests|timeout|timed out|header not found|missing trie node|unknown block|capacity|try again/i;
/** A node that already has this transaction. */
const ALREADY_KNOWN = /already known|known transaction|already imported|alreadyknown/i;
/** Deterministic rejections that may also mean our own tx was already mined. */
const NONCE_TOO_LOW = /nonce too low|nonce has already been used/i;

export function isRetryable(err: unknown): boolean {
  if (err instanceof RpcTransportError) return true;
  if (err instanceof JsonRpcError) return RETRYABLE_RPC_CODES.has(err.code) || RETRYABLE_RPC_MESSAGE.test(err.message);
  return true; // unknown failure: treat as transport
}

interface Health {
  consecutiveFailures: number;
  openUntil: number;
  lastBlock?: bigint;
  lastLatencyMs?: number;
  lastError?: string;
}

export interface ResilientRpcOptions {
  chain: string;
  endpoints: RpcEndpoint[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRounds?: number;
  backoffBaseMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  staleBlockLag?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: RpcLogger;
}

export interface EndpointHealthSnapshot {
  tier: RpcEndpoint['tier'];
  provider: RpcEndpoint['provider'];
  url: string;
  circuit: 'closed' | 'open';
  stale: boolean;
  consecutiveFailures: number;
  lastBlock?: string;
  lastLatencyMs?: number;
  lastError?: string;
}

export class ResilientRpc {
  private readonly health: Health[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRounds: number;
  private readonly backoffBaseMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly staleLag: bigint;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: RpcLogger;
  private bestBlock: bigint = BigInt(0);
  private nextId = 1;

  constructor(private readonly opts: ResilientRpcOptions) {
    this.health = opts.endpoints.map(() => ({ consecutiveFailures: 0, openUntil: 0 }));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.maxRounds = opts.maxRounds ?? 2;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
    this.threshold = opts.circuitFailureThreshold ?? 3;
    this.cooldownMs = opts.circuitCooldownMs ?? 30_000;
    this.staleLag = BigInt(opts.staleBlockLag ?? 20);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.logger ?? defaultRpcLogger;
  }

  get endpointCount(): number {
    return this.opts.endpoints.length;
  }

  healthSnapshot(): EndpointHealthSnapshot[] {
    return this.opts.endpoints.map((e, i) => ({
      tier: e.tier,
      provider: e.provider,
      url: redactRpcUrl(e.url),
      circuit: this.health[i].openUntil > this.now() ? 'open' : 'closed',
      stale: this.isStale(i),
      consecutiveFailures: this.health[i].consecutiveFailures,
      lastBlock: this.health[i].lastBlock?.toString(),
      lastLatencyMs: this.health[i].lastLatencyMs,
      lastError: this.health[i].lastError,
    }));
  }

  private isStale(i: number): boolean {
    const b = this.health[i].lastBlock;
    return b !== undefined && this.bestBlock - b > this.staleLag;
  }

  /** Endpoint indices in try-order: closed & fresh, closed & stale, then open circuits (last-ditch probe). */
  private order(): number[] {
    const t = this.now();
    const idx = this.opts.endpoints.map((_, i) => i);
    const closed = idx.filter((i) => this.health[i].openUntil <= t);
    const open = idx.filter((i) => this.health[i].openUntil > t);
    return [...closed.filter((i) => !this.isStale(i)), ...closed.filter((i) => this.isStale(i)), ...open];
  }

  private async call(i: number, method: string, params: unknown[] | undefined, timeoutMs = this.timeoutMs): Promise<unknown> {
    const ep = this.opts.endpoints[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = this.now();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(ep.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params: params ?? [] }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new RpcTransportError(controller.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${(err as Error).message}`);
      }
      if (!res.ok) throw new RpcTransportError(`HTTP ${res.status}`, res.status);
      let body: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try {
        body = await res.json();
      } catch {
        throw new RpcTransportError('invalid JSON-RPC response');
      }
      if (body.error) throw new JsonRpcError(body.error.code, body.error.message, body.error.data);
      if (!('result' in body)) throw new RpcTransportError('JSON-RPC response without result');
      this.markSuccess(i, this.now() - started);
      if (method === 'eth_blockNumber' && typeof body.result === 'string') this.recordBlock(i, BigInt(body.result));
      return body.result;
    } catch (err) {
      if (!(err instanceof JsonRpcError) || isRetryable(err)) this.markFailure(i, method, err as Error);
      else this.markSuccess(i, this.now() - started); // the node answered; the answer is an error
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private markSuccess(i: number, latency: number) {
    this.health[i].consecutiveFailures = 0;
    this.health[i].openUntil = 0;
    this.health[i].lastLatencyMs = latency;
  }

  private markFailure(i: number, method: string, err: Error) {
    const h = this.health[i];
    h.consecutiveFailures++;
    h.lastError = err.message;
    const ep = this.opts.endpoints[i];
    this.log('warn', 'rpc.request.failed', { chain: this.opts.chain, method, tier: ep.tier, provider: ep.provider, endpoint: redactRpcUrl(ep.url), error: err.message, consecutiveFailures: h.consecutiveFailures });
    if (h.consecutiveFailures >= this.threshold && h.openUntil <= this.now()) {
      h.openUntil = this.now() + this.cooldownMs;
      this.log('warn', 'rpc.circuit.open', { chain: this.opts.chain, tier: ep.tier, endpoint: redactRpcUrl(ep.url), cooldownMs: this.cooldownMs });
    }
  }

  private recordBlock(i: number, block: bigint) {
    this.health[i].lastBlock = block;
    if (block > this.bestBlock) this.bestBlock = block;
    if (this.isStale(i)) {
      const ep = this.opts.endpoints[i];
      this.log('warn', 'rpc.endpoint.stale', { chain: this.opts.chain, tier: ep.tier, endpoint: redactRpcUrl(ep.url), block: block.toString(), bestBlock: this.bestBlock.toString() });
    }
  }

  async request(method: string, params?: unknown[]): Promise<unknown> {
    if (this.opts.endpoints.length === 0) throw new RpcUnavailableError(this.opts.chain, method, new Error('no RPC endpoint configured'));
    if (method === 'eth_sendRawTransaction') return this.sendRawTransaction((params?.[0] ?? '0x') as Hex);
    let lastError: unknown;
    for (let round = 0; round < this.maxRounds; round++) {
      if (round > 0) await this.sleep(this.backoffBaseMs * 2 ** (round - 1));
      for (const i of this.order()) {
        try {
          return await this.call(i, method, params);
        } catch (err) {
          if (!isRetryable(err)) throw err;
          lastError = err;
        }
      }
    }
    throw new RpcUnavailableError(this.opts.chain, method, lastError);
  }

  /** True if any endpoint knows the transaction (pending or mined). Errors count as "unknown here". */
  private async findTransaction(hash: Hex): Promise<boolean> {
    for (const i of this.order()) {
      try {
        if ((await this.call(i, 'eth_getTransactionByHash', [hash])) != null) return true;
      } catch {
        /* try the next endpoint */
      }
    }
    return false;
  }

  async sendRawTransaction(raw: Hex): Promise<Hex> {
    const hash = keccak256(raw);
    let lastError: unknown;
    for (const i of this.order()) {
      const ep = this.opts.endpoints[i];
      try {
        const returned = await this.call(i, 'eth_sendRawTransaction', [raw]);
        if (typeof returned === 'string' && returned.toLowerCase() !== hash.toLowerCase()) {
          this.log('warn', 'rpc.tx.hash_mismatch', { chain: this.opts.chain, endpoint: redactRpcUrl(ep.url), computed: hash, returned });
        }
        this.log('info', 'rpc.tx.sent', { chain: this.opts.chain, tier: ep.tier, txHash: hash });
        return hash;
      } catch (err) {
        lastError = err;
        if (err instanceof JsonRpcError && ALREADY_KNOWN.test(err.message)) return hash;
        if (err instanceof JsonRpcError && !isRetryable(err)) {
          // Deterministic rejection. "nonce too low" may mean THIS tx was already mined.
          if (NONCE_TOO_LOW.test(err.message) && (await this.findTransaction(hash))) return hash;
          throw err;
        }
        // Ambiguous: the node may have accepted it before failing. Look it up everywhere first.
        if (await this.findTransaction(hash)) {
          this.log('warn', 'rpc.tx.found_after_error', { chain: this.opts.chain, tier: ep.tier, txHash: hash, error: (err as Error).message });
          return hash;
        }
        this.log('warn', 'rpc.tx.failover', { chain: this.opts.chain, fromTier: ep.tier, txHash: hash, error: (err as Error).message });
      }
    }
    throw new TransactionBroadcastUnknownError(this.opts.chain, hash, lastError);
  }
}
