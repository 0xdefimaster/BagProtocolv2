import { createComposeSdk, guards, materialisers, resources } from '@lifi/composer-sdk';
import type { Bindable, ComposeSdkOptions } from '@lifi/composer-sdk';
import type { ComposerCompileRequest, ComposerCompileResult, ComposerProvider } from '../execution';

// -----------------------------------------------------------------------------
// Routing adapter: LI.FI Composer (@lifi/composer-sdk, optional peer
// dependency). Builds the same flow BAG's own single-transaction purchase
// uses (lib/blockchain/lifi-composer-adapter.ts):
//   - a cascade of `core.split` by the plan's bps,
//   - one `lifi.swap` per leg with the plan's slippage and an unspent-input guard,
//   - outputs swept to the signer,
// then compiles it with Composer's documented API.
//
// Credentials and endpoint are the CALLER's: `apiKey` is required (Composer
// rejects unauthenticated requests) and is never stored or logged by the SDK;
// `baseUrl` is required too (the SDK owns no endpoint; BAG itself uses the
// production Composer API documented in LI.FI's quickstart).
// Compile only: nothing is signed or sent.
// -----------------------------------------------------------------------------

export interface LifiComposerOptions {
  /** Your LI.FI API key. */
  apiKey: string;
  /** Composer API base URL (e.g. LI.FI's production Composer API from its docs). */
  baseUrl: string;
  fetch?: typeof fetch;
}

const legNode = (i: number) => `swap_${i}`;

export function lifiComposer(options: LifiComposerOptions): ComposerProvider {
  if (!options.apiKey) throw new Error('lifiComposer: apiKey is required (your own LI.FI API key).');
  if (!options.baseUrl) throw new Error('lifiComposer: baseUrl is required (the Composer API to call).');
  return {
    name: 'lifi-composer',
    async compile(req: ComposerCompileRequest): Promise<ComposerCompileResult> {
      const sdkOptions: ComposeSdkOptions = { baseUrl: options.baseUrl, apiKey: options.apiKey };
      if (options.fetch) (sdkOptions as { fetch?: typeof fetch }).fetch = options.fetch;
      const sdk = createComposeSdk(sdkOptions);
      const chainId = req.chainId;

      const builder = sdk.flow(chainId, {
        name: `bag-sdk-purchase-${req.legs.length}-legs`,
        inputs: { amountIn: resources.erc20(req.inputToken as `0x${string}`, chainId) },
      });

      const swap = (i: number, amountIn: Bindable<'resource'>) =>
        builder.lifi.swap(legNode(i), {
          bind: { amountIn },
          config: { resourceOut: { kind: 'erc20', token: req.legs[i].token as `0x${string}`, chainId }, slippage: req.slippageBps / 10000 },
          guards: [guards.slippage({ port: 'unspentIn', bps: req.slippageBps })],
        });

      let remaining: Bindable<'resource'> = builder.inputs.amountIn;
      for (let i = 0; i < req.legs.length - 1; i++) {
        const { a, b } = builder.core.split(`split_${i}`, { bind: { source: remaining }, config: { bps: req.cascadeSplitBps[i] } });
        swap(i, a);
        remaining = b;
      }
      swap(req.legs.length - 1, remaining);

      const result = await builder.compile({
        signer: req.signer as `0x${string}`,
        inputs: { amountIn: materialisers.directDeposit({ amount: req.amountRaw }) },
        sweepTo: { $ref: 'context.sender' },
        checkOnChainAllowances: true,
        maxPriceImpactBps: req.maxPriceImpactBps,
      });
      if (result.status !== 'success') throw new Error(`LI.FI Composer could not compile the purchase: ${result.error.kind} — ${result.error.message}`);
      if (!result.transactionRequest) throw new Error('LI.FI Composer reported success without a transaction.');

      const produced = result.producedResources as Record<string, { token?: string; simulated?: { amountOut?: unknown; amountOutMin?: unknown } } | undefined>;
      const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
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
          // Composer keys produced resources by output port (`swap_<i>.amountOut`).
          const r = produced[`${legNode(i)}.amountOut`];
          return { token: r?.token ?? null, expectedOutRaw: str(r?.simulated?.amountOut), minOutRaw: str(r?.simulated?.amountOutMin) };
        }),
        priceImpactBps: result.priceImpact?.impactBps ?? null,
        gasLimit: result.transactionRequest.gasLimit ?? null,
        fees: (result.fees ?? []).map((f) => ({ token: f.token, recipient: f.recipient, bps: f.bps, amountRaw: f.amount ?? null })),
      };
    },
  };
}
