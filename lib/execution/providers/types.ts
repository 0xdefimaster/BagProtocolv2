import { BagExecutionGraph, BagExecutionIntent, CompiledExecution } from '../types';

// -----------------------------------------------------------------------------
// lib/execution/providers/types.ts
//
// `BagExecutionProvider` — the interface every execution backend (LI.FI
// Composer, plain LI.FI, a future direct-DEX adapter, the future BAG
// Router) implements. `lib/execution/compiler.ts` only ever talks to THIS
// interface — it never imports `@lifi/composer-sdk`, `@lifi/sdk`, or any
// other provider-specific package directly (spec item 3: "Compiler hiçbir
// zaman 'LI.FI kullan' diye hardcode edilmemeli").
// -----------------------------------------------------------------------------

/**
 * What a provider can and can't do — the compiler picks a provider by
 * matching an intent/graph's requirements against these, never by name.
 * Every flag is a plain boolean; a provider that "sometimes" supports a
 * capability (e.g. atomic only below N legs) expresses that nuance in
 * `supports()`, not by fudging one of these into a partial truth.
 */
export interface ProviderCapabilities {
  sameChain: boolean;
  crossChain: boolean;
  multiAsset: boolean;
  singleTransaction: boolean;
  requiresApproval: boolean;
  requiresMultipleSignatures: boolean;
  nativeAsset: boolean;
  erc20: boolean;
  atomic: boolean;
  supportsRecipient: boolean;
  supportsPermit: boolean;
  supportsComposer: boolean;
}

export interface ProviderQuoteLeg {
  legId: string;
  outputAmountRaw: string;
  minimumOutputRaw: string;
}

export interface ProviderQuote {
  legs: ProviderQuoteLeg[];
  /** Provider-reported total fee, in the input asset's raw units — `null` when the provider doesn't report one (never fabricated, same convention as `ExecutionStepQuote`). */
  estimatedFeeRaw: string | null;
}

export interface BagExecutionProvider {
  /** Stable machine-readable name (e.g. `'lifi-composer'`, `'lifi-sequential'`) — used for `providerId` on `CompiledExecution`, `providerHint` matching, and `constraints.allowedProviders`. Never shown to end users as-is. */
  identify(): string;

  getCapabilities(): ProviderCapabilities;

  /**
   * True iff this provider can plausibly serve `intent`/`graph` — never
   * throws, safe to call speculatively (same convention as the existing
   * `isComposerEligible()`). The compiler calls this on every registered
   * provider before choosing one; a provider returning `true` here that
   * then fails in `compile()` is a real failure (`PROVIDER_COMPILE_FAILED`),
   * not an expected/silent case.
   */
  supports(intent: BagExecutionIntent, graph: BagExecutionGraph): boolean;

  /** Optional — a provider without a meaningful pre-compile quote step (e.g. one where quoting and compiling are the same network call) may omit this; the compiler treats a missing `quote()` as "quote unavailable, proceed straight to compile()". */
  quote?(graph: BagExecutionGraph): Promise<ProviderQuote>;

  /**
   * Compiles `graph` into a normalized `CompiledExecution`. Must throw
   * (never return a partially-filled result) if compilation fails for a
   * provider that claimed `supports() === true` — the compiler wraps that
   * throw into `BagExecutionError('PROVIDER_COMPILE_FAILED', ...)`.
   *
   * This is the EXECUTABLE compilation — `compileBagExecution()` (the
   * single-provider path a purchase actually executes against) always calls
   * THIS method, never `compileQuote()` below. A provider that produces a
   * real, server-signed or otherwise irreversible authorization artifact as
   * part of compiling (e.g. `BagRouterProvider` calling its injected
   * `signPlan`) does that HERE — this method is only ever invoked once a
   * specific provider has been selected to actually run, either because it
   * is the single-winner result of `compileBagExecution()` or because a
   * caller re-compiles a user-selected candidate through that same function
   * (see `compileQuote`'s doc for why that distinction exists).
   */
  compile(intent: BagExecutionIntent, graph: BagExecutionGraph): Promise<CompiledExecution>;

  /**
   * OPTIONAL comparison-only compilation. `compileBagExecutionCandidates()`
   * (compiler.ts) — the "try every eligible provider and show the user a
   * comparison" path behind `POST /purchase-options` — calls THIS method
   * when a provider defines it, and falls back to `compile()` only when it
   * doesn't. `compileBagExecution()`, the single-provider EXECUTABLE path,
   * NEVER calls `compileQuote()` — it always calls `compile()`.
   *
   * The reason this seam exists at all: comparing routes must never trigger
   * whatever makes a provider's `compile()` step irreversible or
   * security-sensitive. Most providers have no such step — LI.FI Composer
   * and LI.FI Sequential only build calldata the CONNECTED WALLET signs
   * afterward, client-side, so quoting and compiling are the same safe
   * operation for them and they can simply omit `compileQuote` (the
   * compiler's fallback to `compile()` is exactly today's behavior for
   * those two). `BagRouterProvider` is the provider this seam was added
   * for: its `compile()` calls a server-held EIP-712 plan signer, which
   * must never run for a route the user has not chosen yet — see that
   * provider's own module doc.
   *
   * A provider implementing this MUST NOT do anything inside it that
   * `compile()` would also need to do exactly once per real execution
   * (signing, nonce consumption, any other one-shot/irreversible side
   * effect) — if it can't produce a meaningful pre-selection result without
   * that step, it should return whatever normalized `CompiledExecution` it
   * safely can (real `expectedOutputs`/`mode` from a genuine quote,
   * `transactions: []` when there is nothing safe to hand back before a
   * signature exists) rather than take the shortcut of calling `compile()`
   * from inside `compileQuote()`. Candidate comparison only ever reads
   * `expectedOutputs`/`mode`/`providerMetadata` off the result (see
   * candidate-metrics.ts, candidate-completeness.ts) — `transactions` being
   * empty here has no effect on ranking or on the "is this candidate
   * complete" check.
   */
  compileQuote?(intent: BagExecutionIntent, graph: BagExecutionGraph): Promise<CompiledExecution>;
}
