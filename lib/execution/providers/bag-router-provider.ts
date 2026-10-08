import { encodeFunctionData, type Hex } from 'viem';
import { BagExecutionGraph, BagExecutionIntent, CompiledExecution, ExpectedOutput } from '../types';
import { computeBagExecutionGraphHash } from '../plan';
import { getEvmChainIdFor } from '@/lib/blockchain/evm/config';
import { BagExecutionProvider, ProviderCapabilities } from './types';
import { isNativeAssetIdentity } from '@/lib/domain/basket-protocol/asset-identity';

// -----------------------------------------------------------------------------
// lib/execution/providers/bag-router-provider.ts
//
// Item 7's TypeScript half: exposes `contracts/BagExecutionRouter.sol` to
// the EXISTING compiler through the EXISTING `BagExecutionProvider`
// interface. Deliberately no new execution abstraction (item 2) — this is
// the same seam `LiFiComposerProvider` and `LiFiSequentialProvider` sit on,
// so `compileBagExecution()`, `purchase-intent-bridge.ts`,
// `purchase-execution.ts`, and the `BAG_EXECUTION_COMPILER_ENABLED` flag
// all keep working untouched.
//
// What this provider does NOT do, on purpose:
//   - it does not quote, price, or route anything itself. Producing a
//     leg's `target`/`callData` is a DEX/aggregator concern; this provider
//     takes an injected `legBuilder` for that (see `BagRouterLegBuilder`).
//     Inventing swap calldata here is exactly the "fabricated calldata"
//     failure mode the 19.X spikes were written to avoid.
//   - it does not hold, or have any access to, the plan-signing key. It
//     takes an injected async `signPlan`, which in production is a
//     server-only call into whatever holds `BAG_ROUTER_PLAN_SIGNER_KEY`.
//     `signPlan` is called from EXACTLY ONE place in this file — `compile()`
//     — never from `compileQuote()` (the candidate-comparison sibling
//     `compileBagExecutionCandidates()` calls instead; see
//     providers/types.ts's `BagExecutionProvider.compileQuote` doc). A
//     comparison request must never mint a real, signed execution
//     authorization for a route nobody has chosen yet.
//   - it does not touch Permit2 (item 7's explicit deferral). The router's
//     on-chain model is still "user approves the router, then calls
//     execute()", so `requiresApproval: true` below is the honest answer,
//     and `supportsPermit: false` stays false until that phase happens.
//
// Because both dependencies are injected and neither has a safe default,
// a deployment that hasn't configured them simply doesn't register this
// provider at all (see `registry.ts`) — the same "no key, never attempted"
// pattern `LiFiComposerProvider` already uses, rather than registering a
// provider that would fail at compile() time on every call.
// -----------------------------------------------------------------------------

export const BAG_ROUTER_PROVIDER_ID = 'bag-router';

const CAPABILITIES: ProviderCapabilities = {
  sameChain: true,
  crossChain: false, // One `execute()` call is one EVM transaction on one chain, by construction.
  multiAsset: true,
  singleTransaction: true,
  requiresApproval: true, // The router pulls input via `transferFrom` — a prior ERC-20 approval is still required (Permit2 is a later phase).
  requiresMultipleSignatures: false,
  nativeAsset: false, // `execute()` accepts native `value` for legs, but the INPUT asset is pulled as an ERC-20; native-input plans aren't built yet.
  erc20: true,
  atomic: true,
  supportsRecipient: false, // Deliberate: the router always pays out to `msg.sender`. See its NatSpec trust boundary #4.
  supportsPermit: false,
  supportsComposer: false,
};

/** The router's `execute(ExecutionPlan,bytes)` ABI — kept minimal and local rather than importing a generated artifact, so this module has no build-order dependency on `hardhat compile`. */
export const BAG_EXECUTION_ROUTER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'plan',
        type: 'tuple',
        components: [
          { name: 'bagId', type: 'bytes32' },
          { name: 'executionPlanHash', type: 'bytes32' },
          { name: 'wallet', type: 'address' },
          { name: 'inputToken', type: 'address' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          {
            name: 'legs',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'callData', type: 'bytes' },
              { name: 'value', type: 'uint256' },
              { name: 'approveToken', type: 'address' },
              { name: 'approveAmount', type: 'uint256' },
            ],
          },
          {
            name: 'minOutputs',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'minAmountOut', type: 'uint256' },
            ],
          },
        ],
      },
      { name: 'planSignature', type: 'bytes' },
    ],
    outputs: [{ name: 'outputAmounts', type: 'uint256[]' }],
  },
] as const;

/** One built leg, as returned by the injected builder — mirrors the contract's own `Leg` struct field-for-field. */
export interface BuiltRouterLeg {
  target: Hex;
  callData: Hex;
  value: bigint;
  approveToken: Hex;
  approveAmount: bigint;
  /** The builder's own quote for THIS leg's target asset, before slippage (expected, not guaranteed). */
  quotedOutputRaw: string;
  /** Slippage-adjusted floor for THIS leg's target asset. Never fabricated here — it flows straight into the plan's `minOutputs` (enforced on-chain) and into `expectedOutputs`. */
  minimumGuaranteedOutputRaw: string;
}

/**
 * Turns one `BagExecutionLeg` into executable router calldata. Implemented
 * by whatever actually knows how to route on the target chain (a direct
 * Uniswap builder, an aggregator adapter, ...). Throwing here is a normal
 * provider failure: `compileBagExecution()` catches it and falls through to
 * the next eligible provider, exactly as it already does for Composer.
 */
export type BagRouterLegBuilder = (leg: BagExecutionGraph['legs'][number], graph: BagExecutionGraph) => Promise<BuiltRouterLeg>;

/** Signs the EIP-712 `ExecutionPlan`. Server-only in production; the key never reaches this module or the browser. */
export type BagRouterPlanSigner = (plan: RouterExecutionPlan, chainId: number, router: Hex) => Promise<Hex>;

export interface RouterExecutionPlan {
  bagId: Hex;
  executionPlanHash: Hex;
  wallet: Hex;
  inputToken: Hex;
  inputAmount: bigint;
  deadline: bigint;
  legs: { target: Hex; callData: Hex; value: bigint; approveToken: Hex; approveAmount: bigint }[];
  minOutputs: { token: Hex; minAmountOut: bigint }[];
}

export interface BagRouterProviderConfig {
  /** Deployed `BagExecutionRouter` address. */
  routerAddress: Hex;
  /** EVM chain id the router is deployed on — a graph for any other chain is refused by `supports()`. */
  chainId: number;
  /** `bags.id` (UUID) -> bytes32, using the SAME encoding `BagFactory.bagOf` expects (`computeOnChainBagId()`); injected rather than re-implemented so there is one encoder in the codebase. */
  toOnChainBagId: (bagId: string) => Hex;
  legBuilder: BagRouterLegBuilder;
  signPlan: BagRouterPlanSigner;
  /** Seconds the signed plan stays valid. Short by design — the router rejects an expired plan outright. */
  planTtlSeconds?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

const DEFAULT_PLAN_TTL_SECONDS = 300;

export class BagRouterProvider implements BagExecutionProvider {
  constructor(private readonly config: BagRouterProviderConfig) {}

  identify(): string {
    return BAG_ROUTER_PROVIDER_ID;
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  /**
   * Same-chain only, on the ONE chain this router is actually deployed on,
   * with every leg sharing the graph's single input asset (the router pulls
   * exactly one input token). Never throws — speculative-call safe, per the
   * interface contract.
   *
   * Chain binding: `graph.chainId` is BAG's own string `ChainId`
   * ('robinhood', 'base', ...); `config.chainId` is the numeric EVM id the
   * router contract lives on (and signs plans for). They are compared via the
   * repository's canonical mapping (`getEvmChainIdFor`, lib/blockchain/evm/
   * config.ts) — never by string/number coercion. A provider wired for the
   * wrong network answers "not eligible" here, so `compileBagExecution()`
   * falls through to the next provider instead of producing a transaction
   * for a router that does not exist on that chain.
   */
  supports(intent: BagExecutionIntent, graph: BagExecutionGraph): boolean {
    try {
      if (!graph || !Array.isArray(graph.legs) || graph.legs.length === 0) return false;
      const chain = graph.chainId;
      if (intent.chainId !== chain) return false;
      if (getEvmChainIdFor(chain) !== this.config.chainId) return false;
      if (graph.inputAsset.chain !== chain) return false;
      if (isNativeAssetIdentity(graph.inputAsset)) return false;
      const input = graph.inputAsset.address.toLowerCase();
      return graph.legs.every(
        (leg) =>
          leg.chain === chain &&
          leg.sourceAsset.chain === chain &&
          leg.targetAsset.chain === chain &&
          leg.sourceAsset.address.toLowerCase() === input
      );
    } catch {
      // Malformed graph/intent — "not eligible", never an exception out of a speculative check.
      return false;
    }
  }

  /**
   * Builds everything `compile()` and `compileQuote()` share — real quoted
   * legs (via the injected `legBuilder`, never fabricated calldata/minimums)
   * assembled into the UNSIGNED `RouterExecutionPlan` shape the contract
   * expects. Deliberately stops BEFORE anything that only makes sense once
   * a provider has actually been selected to execute: no `signPlan()` call,
   * no `execute()` calldata encoding (encoding requires the signature as an
   * argument, so it cannot happen before one exists). Extracted so the two
   * public methods can never independently drift on how a leg becomes a
   * plan entry, a leg's minimum becomes `minOutputs`, or a deadline is
   * computed — there is exactly ONE implementation of each, here.
   */
  private async buildUnsignedPlan(graph: BagExecutionGraph): Promise<{
    plan: RouterExecutionPlan;
    builtLegs: BuiltRouterLeg[];
    expectedOutputs: ExpectedOutput[];
  }> {
    const built: BuiltRouterLeg[] = [];
    for (const leg of graph.legs) {
      built.push(await this.config.legBuilder(leg, graph));
    }

    // One `minOutputs` entry per DISTINCT target token — the contract
    // rejects duplicates outright (it measures a per-token balance delta,
    // so a token listed twice would be counted and paid out twice). Two
    // legs landing in the same asset therefore have their minimums summed
    // here rather than emitted separately.
    const minByToken = new Map<string, bigint>();
    graph.legs.forEach((leg, i) => {
      const token = leg.targetAsset.address.toLowerCase();
      minByToken.set(token, (minByToken.get(token) ?? BigInt(0)) + BigInt(built[i].minimumGuaranteedOutputRaw));
    });

    const now = this.config.now ? this.config.now() : Date.now();
    const deadline = BigInt(Math.floor(now / 1000) + (this.config.planTtlSeconds ?? DEFAULT_PLAN_TTL_SECONDS));

    const plan: RouterExecutionPlan = {
      bagId: this.config.toOnChainBagId(graph.bagId),
      // The compiler re-stamps `executionPlanHash` on the returned object,
      // but the (eventually) SIGNED plan has to carry it too — that
      // on-chain field is what ties this transaction to one specific
      // compiled graph, and it must be inside the signature to mean
      // anything. Stamped here already, unsigned, so `compileQuote()`'s
      // result carries the same value `compile()` will later sign.
      executionPlanHash: `0x${computeGraphHashHex(graph)}` as Hex,
      wallet: graph.wallet as Hex,
      inputToken: graph.inputAsset.address as Hex,
      inputAmount: BigInt(graph.inputAmountRaw),
      deadline,
      legs: built.map((b) => ({
        target: b.target,
        callData: b.callData,
        value: b.value,
        approveToken: b.approveToken,
        approveAmount: b.approveAmount,
      })),
      minOutputs: Array.from(minByToken.entries()).map(([token, minAmountOut]) => ({
        token: token as Hex,
        minAmountOut,
      })),
    };

    const expectedOutputs: ExpectedOutput[] = graph.legs.map((leg, i) => ({
      legId: leg.id,
      asset: leg.targetAsset,
      quotedOutputRaw: built[i].quotedOutputRaw,
      quotedOutputBasis: 'PROVIDER_QUOTE',
      // Enforced by the router contract (`InsufficientOutput` revert) — a real guarantee.
      minimumGuaranteedOutputRaw: built[i].minimumGuaranteedOutputRaw,
    }));

    return { plan, builtLegs: built, expectedOutputs };
  }

  /**
   * The EXECUTABLE path — `BagExecutionProvider.compile()`. Only ever
   * called once this provider has actually been selected to run (the
   * single-winner result of `compileBagExecution()`, or a fresh
   * re-compilation of a candidate the user picked — see
   * `purchase-execution.ts`'s `createPurchaseIntentForUser`). This is the
   * ONLY method on this class that calls `signPlan()` or produces a
   * real, executable `execute()` calldata — see `compileQuote()` below for
   * the comparison-only sibling that deliberately does neither.
   */
  async compile(_intent: BagExecutionIntent, graph: BagExecutionGraph): Promise<CompiledExecution> {
    const { plan, builtLegs, expectedOutputs } = await this.buildUnsignedPlan(graph);

    const signature = await this.config.signPlan(plan, this.config.chainId, this.config.routerAddress);

    const data = encodeFunctionData({
      abi: BAG_EXECUTION_ROUTER_ABI,
      functionName: 'execute',
      args: [plan, signature],
    });

    const totalValue = builtLegs.reduce((sum, b) => sum + b.value, BigInt(0));

    return {
      mode: 'SINGLE_TX',
      chainId: this.config.chainId,
      transactions: [
        {
          to: this.config.routerAddress,
          data,
          value: totalValue.toString(),
          chainId: this.config.chainId,
        },
      ],
      expectedOutputs,
      providerId: BAG_ROUTER_PROVIDER_ID,
      // Re-stamped by the compiler from its own computation; set here only
      // to satisfy the type (same as every other provider does).
      executionPlanHash: computeGraphHashHex(graph),
      providerMetadata: {
        routerAddress: this.config.routerAddress,
        planDeadline: plan.deadline.toString(),
        // Kept so an execute-time verifier can compare the on-chain
        // `ExecutionCompleted` event's fields against what was signed,
        // without re-deriving them.
        signedPlan: {
          ...plan,
          inputAmount: plan.inputAmount.toString(),
          deadline: plan.deadline.toString(),
          legs: plan.legs.map((l) => ({ ...l, value: l.value.toString(), approveAmount: l.approveAmount.toString() })),
          minOutputs: plan.minOutputs.map((o) => ({ ...o, minAmountOut: o.minAmountOut.toString() })),
        },
      },
    };
  }

  /**
   * The COMPARISON-ONLY path — `BagExecutionProvider.compileQuote()`
   * (providers/types.ts's own doc). Called by
   * `compileBagExecutionCandidates()` (compiler.ts) instead of `compile()`
   * whenever this provider is one of several being compared — i.e. exactly
   * the `POST /purchase-options` request this architecture was split for.
   *
   * Builds the SAME unsigned plan `compile()` would, quoting REAL legs from
   * the SAME injected `legBuilder` (never fabricated numbers — the
   * candidate's `expectedOutputs`/metrics are as real here as on the
   * executable path), but stops there: `this.config.signPlan()` is NEVER
   * called, and no `execute()` calldata is encoded (there is nothing valid
   * to encode without a signature). `transactions` is therefore empty —
   * this result is display/estimation data only, exactly like every other
   * provider's candidate output (see `ExecutionCandidate.compiled`'s own
   * doc on why nothing here is ever executed directly) — and
   * `providerMetadata` carries no `signedPlan`, because none exists yet.
   *
   * Selecting this candidate always triggers a FRESH `compile()` call
   * through `compileBagExecution()` (never a re-use of this result) — that
   * is the one and only place this provider's `signPlan()` may run.
   */
  async compileQuote(_intent: BagExecutionIntent, graph: BagExecutionGraph): Promise<CompiledExecution> {
    const { plan, expectedOutputs } = await this.buildUnsignedPlan(graph);

    return {
      mode: 'SINGLE_TX',
      chainId: this.config.chainId,
      // Deliberately empty — see this method's own doc. A comparison
      // candidate is never executed directly regardless of provider, but
      // this provider specifically has nothing SAFE to put here before a
      // route is chosen: unlike LI.FI's candidate transactions (unsigned
      // calldata the wallet itself will sign later), this router's only
      // valid calldata embeds a signature that must not exist yet.
      transactions: [],
      expectedOutputs,
      providerId: BAG_ROUTER_PROVIDER_ID,
      executionPlanHash: computeGraphHashHex(graph),
      providerMetadata: {
        routerAddress: this.config.routerAddress,
        planDeadline: plan.deadline.toString(),
        // Server-side-only debugging aid (never reaches the client — see
        // `ExecutionCandidateView`'s own doc) confirming this quote was
        // built for the SAME wallet the eventual signed plan will bind to.
        wallet: plan.wallet,
        quoteOnly: true,
      },
    };
  }
}

/**
 * The graph fingerprint, from the compiler's OWN hash function — never a
 * second implementation. The signed plan must carry the same value the
 * compiler stamps on the returned `CompiledExecution`, otherwise the
 * on-chain `executionPlanHash` would attest to a different graph than the
 * one `purchase-execution.ts` re-verifies at execute time.
 */
function computeGraphHashHex(graph: BagExecutionGraph): string {
  return computeBagExecutionGraphHash(graph);
}
