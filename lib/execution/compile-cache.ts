import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from './types';
import { BagExecutionProvider } from './providers/types';

// -----------------------------------------------------------------------------
// lib/execution/compile-cache.ts
//
// Short-lived, process-local reuse of a provider's `compile()` result.
//
// The purchase modal runs `POST /purchase-options` in the background (every
// eligible provider compiles), and the Buy button then calls
// `POST /purchase-intent`, which compiled the chosen provider AGAIN for the
// exact same wallet/amount/graph. That second compile was often the longest
// wait before the wallet prompt opened. With this cache the intent reuses
// the result the comparison just produced — or joins it if it is still in
// flight — instead of asking LI.FI again.
//
// Safety rules:
//   - Only providers WITHOUT a separate `compileQuote()` are cached. For
//     those, `compile()` is side-effect free (a quote/transaction request);
//     a provider with `compileQuote()` (BAG Router) signs a plan server-side
//     in `compile()`, and a signed plan must never be handed out twice.
//   - The key covers everything the result depends on: provider, wallet,
//     recipient, chain, input asset and amount, targets, slippage, recipe
//     version, composition hash and the graph itself. `deadline` and
//     `constraints` are left out: `deadline` is "now + TTL" on every request
//     and `constraints` only decide WHICH providers run, not what they build.
//   - TTL is short (COMPILE_CACHE_TTL_MS); a quote older than that is
//     re-fetched. Every downstream check (intent validation, the on-chain
//     dry-run before sending, receipt verification) still runs on a cached
//     result exactly as on a fresh one.
//   - A rejected compile is evicted immediately, never cached.
// -----------------------------------------------------------------------------

export const COMPILE_CACHE_TTL_MS = 20_000;
const MAX_ENTRIES = 200;

interface Entry {
  expiresAt: number;
  promise: Promise<CompiledExecution>;
}

const cache = new Map<string, Entry>();

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

export function compileCacheKey(providerId: string, intent: BagExecutionIntent, graph: BagExecutionGraph): string {
  const stable: Partial<BagExecutionIntent> = { ...intent };
  delete stable.deadline;
  delete stable.constraints;
  return `${providerId}|${stableStringify(stable)}|${stableStringify(graph)}`;
}

function prune(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** `provider.compile(intent, graph)`, reusing a result from the last COMPILE_CACHE_TTL_MS when the provider is cacheable. */
export function compileWithCache(
  provider: BagExecutionProvider,
  intent: BagExecutionIntent,
  graph: BagExecutionGraph,
  now: number = Date.now()
): Promise<CompiledExecution> {
  if (provider.compileQuote) return provider.compile(intent, graph);

  const key = compileCacheKey(provider.identify(), intent, graph);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;

  const promise = provider.compile(intent, graph);
  cache.set(key, { expiresAt: now + COMPILE_CACHE_TTL_MS, promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  prune(now);
  return promise;
}

/** Test hook. */
export function clearCompileCache() {
  cache.clear();
}
