import { createComposeSdk, materialisers, resources } from '@lifi/composer-sdk';
import type { Bindable } from '@lifi/composer-sdk';
import type { ComposerCompileRequest, ComposerCompileResult, ComposerProvider } from '../execution';
import { planPartition } from '../partition';

// -----------------------------------------------------------------------------
// Routing adapter: LI.FI Composer (@lifi/composer-sdk, optional peer
// dependency, tested against Composer 0.11.x — see COMPOSER_SDK_COMPAT). Builds
// the same flow BAG's own single-transaction purchase uses
// (lib/blockchain/lifi-composer-adapter.ts):
//   - one `core.partition` of the input by the legs' bps (partition.ts
//     `planPartition`: a second level of nodes above 16 legs),
//   - one `lifi.swap` per leg with the plan's slippage (Composer turns it into
//     that swap's on-chain `amountOutMin`),
//   - outputs swept to the signer,
// then compiles it with Composer's documented API.
//
// Credentials and endpoint are the CALLER's: `apiKey` is required (Composer
// rejects unauthenticated requests) and is never stored or logged by the SDK;
// `baseUrl` is required too (the SDK owns no endpoint; BAG itself uses the
// production Composer API documented in LI.FI's quickstart).
// Compile only: nothing is signed or sent. A refusal is thrown as the Compose
// SDK's own typed `ComposeError` (`kind`, `failedOps`, …), unchanged, so a
// consumer can branch on it with `isComposeError` / `isComposePreparationError`.
// A version mismatch with the Composer server is one of those:
// `isComposeSdkOutdatedError` (install a newer 0.x the server accepts) or
// `isComposeServerOutdatedError` (pin to the server's major.minor).
// -----------------------------------------------------------------------------

/**
 * The @lifi/composer-sdk line this adapter is written and tested for. Composer accepts a client from the server's
 * `major.minor.0` up to the server's own version, so a minor bump on either side needs a new adapter release.
 */
export const COMPOSER_SDK_COMPAT = Object.freeze({ range: '>=0.11.0 <0.12.0', testedWith: '0.11.3' });

type PartitionBuilder = {
  core: { partition: (id: string, args: { bind: { source: Bindable<'resource'> }; config: { bps: number[] } }) => { parts: readonly Bindable<'resource'>[] } };
};

/** The partition node(s) for `legBps` under ids `alloc` / `alloc_g<n>`; one resource per leg, in order. */
function partitionAcross(builder: PartitionBuilder, source: Bindable<'resource'>, legBps: readonly number[]): Bindable<'resource'>[] {
  if (legBps.length === 1) return [source];
  const plan = planPartition(legBps);
  const outer = Array.from(builder.core.partition('alloc', { bind: { source }, config: { bps: plan.outerBps } }).parts);
  const out: Bindable<'resource'>[] = new Array(legBps.length);
  plan.groups.forEach((g, gi) => {
    const inner = g.innerBps ? Array.from(builder.core.partition(`alloc_g${gi}`, { bind: { source: outer[gi] }, config: { bps: g.innerBps } }).parts) : [outer[gi]];
    g.legs.forEach((leg, k) => (out[leg] = inner[k]));
  });
  return out;
}

export interface LifiComposerOptions {
  /** Your LI.FI API key. */
  apiKey: string;
  /** Composer API base URL (e.g. LI.FI's production Composer API from its docs). */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Deadline on each Composer request, enforced by aborting it. Default 15000 ms. */
  timeoutMs?: number;
}

const legNode = (i: number) => `swap_${i}`;

export function lifiComposer(options: LifiComposerOptions): ComposerProvider {
  if (!options.apiKey) throw new Error('lifiComposer: apiKey is required (your own LI.FI API key).');
  if (!options.baseUrl) throw new Error('lifiComposer: baseUrl is required (the Composer API to call).');
  return {
    name: 'lifi-composer',
    async compile(req: ComposerCompileRequest): Promise<ComposerCompileResult> {
      const base = options.fetch ?? fetch;
      const timeoutMs = options.timeoutMs ?? 15_000;
      const sdk = createComposeSdk({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        fetch: (url, init) => {
          const deadline = AbortSignal.timeout(timeoutMs);
          return base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
        },
      });
      const chainId = req.chainId;

      const builder = sdk.flow(chainId, {
        name: `bag-sdk-purchase-${req.legs.length}-legs`,
        // Native ETH is deposited as msg.value by `directDeposit` ("native via msg.value, ERC-20 via transferFrom").
        inputs: { amountIn: req.inputKind === 'native' ? resources.native(chainId) : resources.erc20(req.inputToken as `0x${string}`, chainId) },
      });

      const swap = (i: number, amountIn: Bindable<'resource'>) =>
        builder.lifi.swap(legNode(i), {
          bind: { amountIn },
          config: { resourceOut: { kind: 'erc20', token: req.legs[i].token as `0x${string}`, chainId }, slippage: req.slippageBps / 10000 },
        });

      const legInputs = partitionAcross(builder as unknown as PartitionBuilder, builder.inputs.amountIn, req.legs.map((l) => l.legBps));
      legInputs.forEach((amountIn, i) => swap(i, amountIn));

      const result = await builder.compile({
        signer: req.signer as `0x${string}`,
        inputs: { amountIn: materialisers.directDeposit({ amount: req.amountRaw }) },
        sweepTo: { $ref: 'context.sender' },
        checkOnChainAllowances: true,
        maxPriceImpactBps: req.maxPriceImpactBps,
      });
      // Under the default 'strict' simulation a refusal is thrown, never returned; 'partial' needs 'allow-revert'.
      if (result.status !== 'success') throw new Error(`LI.FI Composer returned a partial result (${result.error.kind}) under strict simulation.`);
      if (!result.transactionRequest) throw new Error('LI.FI Composer reported success without a transaction.');

      const outputs = result.outputs;
      return {
        transaction: {
          to: result.transactionRequest.to,
          data: result.transactionRequest.data,
          value: result.transactionRequest.value ?? '0',
          chainId: result.transactionRequest.chainId ?? null,
        },
        executor: result.userProxy ?? null,
        approvals: (result.approvals ?? []).map((a) => ({ token: a.token, spender: a.spender, amountRaw: String(a.amount) })),
        legs: req.legs.map((_, i) => {
          // Composer keys outputs by output port (`swap_<i>.amountOut`). A missing minimum means no floor is reported;
          // the core execution boundary rejects that response instead of returning an apparently safe transaction.
          const o = outputs[`${legNode(i)}.amountOut`];
          return {
            token: o && o.resource.kind === 'erc20' ? o.resource.token : null,
            recipient: o && typeof o.owner === 'string' ? o.owner : null,
            deliveryWhen: o?.delivery?.when === 'now' || o?.delivery?.when === 'later' ? o.delivery.when : null,
            expectedOutRaw: o?.amount.estimate ? o.amount.estimate.value.toString() : null,
            minOutRaw: o?.amount.minimum ? o.amount.minimum.value.toString() : null,
          };
        }),
        priceImpactBps: result.priceImpact?.impactBps ?? null,
        gasLimit: result.transactionRequest.gasLimit ?? null,
        fees: (result.fees ?? []).map((f) => ({ token: f.token, recipient: f.recipient, bps: f.bps, amountRaw: f.amount ?? null })),
      };
    },
  };
}
