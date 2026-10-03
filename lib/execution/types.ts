import { AssetIdentity, ChainId, ExecutionPlan } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// lib/execution/types.ts
//
// Provider-independent shapes for the "Intent → Portfolio Execution" layer.
// These sit ABOVE `ExecutionPlan`/`ExecutionStep` (types/basket-protocol.ts,
// still the pure allocation-math output of `buildExecutionPlan()`) and
// ABOVE `PurchaseIntent` (types/purchase-intent.ts, still the persisted,
// LI.FI-shaped business record). Nothing here replaces either of those —
// `lib/execution/plan.ts` builds a `BagExecutionGraph` FROM an
// `ExecutionPlan`, and a later integration pass is what teaches
// `lib/server/purchase-execution.ts` to go through the compiler below
// instead of calling `lifi-purchase-quote.ts` directly (see README.md).
//
// Naming: "Bag" prefix throughout (`BagExecutionIntent`, `BagExecutionLeg`,
// ...) to make clear these are BAG's OWN abstraction, not a LI.FI shape —
// LI.FI is one provider among several behind `BagExecutionProvider`
// (providers/types.ts), never the center of this model.
// -----------------------------------------------------------------------------

/** One target the input asset is being split into, as a weight — mirrors `DepositAllocation`'s weight but without that type's KEEP/SWAP/value-math baggage, since a `BagExecutionIntent` is a REQUEST, not a computed plan. */
export interface BagExecutionTarget {
  asset: AssetIdentity;
  weightBps: number;
  /** Display/debugging only — never branched on (same convention as `ExecutionStep.targetSymbol`). */
  symbol?: string;
}

/**
 * A provider-independent execution request. Distinct from `PurchaseIntent`
 * (types/purchase-intent.ts) by design:
 *
 *   `PurchaseIntent`      → persisted, LI.FI-shaped business/execution record
 *                           (status machine, accounting flags, per-step tx
 *                           tracking — see that type's own module doc).
 *   `BagExecutionIntent`  → ephemeral, provider-independent execution
 *                           REQUEST — what goes INTO `compileBagExecution()`.
 *                           Never persisted directly; a `PurchaseIntent` is
 *                           built (or, in the not-yet-integrated future
 *                           path, updated) from a `CompiledExecution`
 *                           produced from one of these.
 *
 * `lib/execution/plan.ts`'s `purchaseIntentToBagExecutionIntent()` is the
 * (one-directional, lossy-by-design) bridge from the existing type to this
 * one for callers that already hold a `PurchaseIntent`.
 */
export interface BagExecutionIntent {
  bagId: string;
  wallet: string;
  chainId: ChainId;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  targets: BagExecutionTarget[];
  maxSlippageBps: number;
  /** Unix ms — mirrors `PurchaseIntent.expiresAt` semantics but as a request field, not a persisted timestamp. */
  deadline: number;
  /** Defaults to `wallet` when omitted — see `PurchaseIntent`'s own doc on why a different recipient isn't wired up end-to-end yet. */
  recipient?: string;
  recipeVersion: number;
  compositionHash: string;
  /**
   * Optional per-call overrides the compiler/providers must respect.
   * Absence of a constraint means "no requirement", never "false" — e.g.
   * omitting `atomic` means "single-tx if a provider can do it, multi-tx
   * fallback is fine", not "must not be atomic".
   */
  constraints?: {
    /** Require a `SINGLE_TX` result or fail with `UNSATISFIABLE_CONSTRAINTS` — never silently degrade to multi-tx. */
    atomic?: boolean;
    /** Restrict provider selection to these `identify()` names (debugging/testing hook, e.g. forcing the sequential provider in a test). */
    allowedProviders?: string[];
  };
}

/** One edge/leg of a `BagExecutionGraph` — a single source→target conversion. Intentionally shaped close to `ExecutionRouteRequest` (types/basket-protocol.ts) so `lib/execution/plan.ts` can build one from the other with a near-direct field mapping. */
export interface BagExecutionLeg {
  id: string;
  sourceAsset: AssetIdentity;
  targetAsset: AssetIdentity;
  /** Raw amount of `sourceAsset` this leg spends. */
  amountRaw: string;
  weightBps: number;
  /** Minimum acceptable raw quantity of `targetAsset` — populated once a provider has quoted this leg; `null` before quoting (see item 11 in README.md — output invariants are enforced from this field, never fabricated). */
  minimumOutputRaw: string | null;
  slippageBps: number;
  chain: ChainId;
  /** Optional hint (a provider `identify()` name) — advisory only, `compileBagExecution()` is free to ignore it if that provider can't actually serve this leg. */
  providerHint?: string;
  /** Ids of other legs in the same graph that must execute (or be confirmed) before this one. Empty for the common flat "one input, N independent targets" basket case — see README.md item 2 for the bridge/stake extension this exists for. */
  dependsOn: string[];
}

/**
 * Provider-independent execution graph — the compiler's INPUT alongside a
 * `BagExecutionIntent`. Flat (`dependsOn: []` on every leg) for today's
 * "one input asset, N independent target legs" basket purchase; the shape
 * is already DAG-capable for a future input→bridge→swap→stake composition
 * (README.md item 2) without another breaking type change.
 */
export interface BagExecutionGraph {
  bagId: string;
  wallet: string;
  chainId: ChainId;
  inputAsset: AssetIdentity;
  inputAmountRaw: string;
  legs: BagExecutionLeg[];
  /** Raw amount of `inputAsset` this graph's legs do NOT allocate — mirrors `ExecutionPlan.unallocatedRaw`. */
  unallocatedRaw: string;
}

export const EXECUTION_MODES = ['SINGLE_TX', 'MULTI_TX', 'CROSS_CHAIN', 'UNSUPPORTED'] as const;
/**
 * The REAL shape of what a compiled execution requires from the wallet —
 * spec item 8: never let the UI say "1 signature" when the compiled result
 * is actually `MULTI_TX`. `CROSS_CHAIN` is its own mode (not just a flavor
 * of `MULTI_TX`) because it additionally implies a bridge-wait step no
 * same-chain multi-tx execution has.
 */
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** One executable transaction a wallet can be asked to sign — provider-agnostic; the wallet layer never needs to know which provider produced it. */
export interface ExecutableTransaction {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/**
 * Where an `ExpectedOutput.quotedOutputRaw` figure came from. Two different
 * semantics that must never be compared as if they were one:
 *   - `PROVIDER_QUOTE` — a provider's price quote for the leg at current
 *     state, before slippage (LI.FI `estimate.toAmount`; Uniswap QuoterV2
 *     `amountOut` for the BAG Router leg builder).
 *   - `SIMULATION`     — a simulated execution result of the whole composed
 *     transaction (LI.FI Composer `producedResources[..].simulated.amountOut`).
 */
export const OUTPUT_QUOTE_BASES = ['PROVIDER_QUOTE', 'SIMULATION'] as const;
export type OutputQuoteBasis = (typeof OUTPUT_QUOTE_BASES)[number];

/**
 * Expected output for one leg (README.md item 11) — populated from each leg's
 * quote, never fabricated when a provider didn't return one.
 *
 * EXPECTED and GUARANTEED are separate fields on purpose — they used to be one
 * `minimumOutputRaw` field that held a slippage-adjusted floor for some
 * providers and a raw simulation for others, which made cross-provider
 * "best output" comparisons meaningless:
 *   - `quotedOutputRaw`            — what the provider EXPECTS the leg to
 *     yield (see `quotedOutputBasis`). Never a promise.
 *   - `minimumGuaranteedOutputRaw` — the floor ENFORCED at execution time
 *     (the transaction reverts below it): LI.FI `estimate.toAmountMin`, or
 *     the BAG Router's on-chain `minOutputs`. `null` when the provider
 *     does not guarantee a floor for what reaches the wallet — Composer:
 *     its swaps do revert below LI.FI's `amountOutMin`, but that floor sits
 *     at the swap boundary inside the Composer proxy, so it is reported
 *     separately as `providerEnforcedMinOutputRaw` — never back-filled
 *     from the expected figure.
 */
export interface ExpectedOutput {
  legId: string;
  asset: AssetIdentity;
  quotedOutputRaw: string | null;
  quotedOutputBasis: OutputQuoteBasis;
  minimumGuaranteedOutputRaw: string | null;
  /**
   * A minimum the PROVIDER itself enforces on chain at its own swap
   * boundary (today only Composer: LI.FI's swap reverts below it). Not
   * BAG's guarantee for what reaches the wallet — that is
   * `minimumGuaranteedOutputRaw` — and never used for verification.
   * Absent/null for providers that report none.
   */
  providerEnforcedMinOutputRaw?: string | null;
}

/**
 * Provider output, normalized. This is the shape `lib/execution/compiler.ts`
 * returns and the ONLY shape a wallet-signing layer should ever look at —
 * never a provider's own internal quote/route object (spec item 4: "Wallet
 * layer provider'ın iç modelini görmek zorunda kalmasın").
 */
export interface CompiledExecution {
  mode: ExecutionMode;
  chainId: number;
  transactions: ExecutableTransaction[];
  expectedOutputs: ExpectedOutput[];
  /** Which provider produced this (`identify()` name) — display/debugging/audit only, never branched on outside the compiler itself. */
  providerId: string;
  /** sha256 (or equivalent) fingerprint of the graph this was compiled from — see README.md item 10; execute-time callers compare this against a freshly recomputed hash before letting a stale compiled execution through. */
  executionPlanHash: string;
  /** Opaque, provider-specific extra data (e.g. Composer's `userProxy`) — never read by generic code, only by the same provider's own execute/verify step. */
  providerMetadata?: Record<string, unknown>;
}

/** Re-exported for convenience — `lib/execution/plan.ts` takes this as its input. */
export type { ExecutionPlan };
