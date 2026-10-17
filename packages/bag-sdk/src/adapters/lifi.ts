import { createComposeSdk, materialisers, resources } from '@lifi/composer-sdk';
import type { Bindable } from '@lifi/composer-sdk';
import type { ComposerCompileRequest, ComposerCompileResult, ComposerProvider } from '../execution';

// -----------------------------------------------------------------------------
// Routing adapter: LI.FI Composer (@lifi/composer-sdk, optional peer
// dependency). Builds the same flow BAG's own single-transaction purchase
// uses (lib/blockchain/lifi-composer-adapter.ts):
//   - a cascade of `core.split` by the plan's bps,
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
// -----------------------------------------------------------------------------

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
          // Composer keys outputs by output port (`swap_<i>.amountOut`). A missing minimum means no floor is enforced (never 0).
          const o = outputs[`${legNode(i)}.amountOut`];
          return {
            token: o && o.resource.kind === 'erc20' ? o.resource.token : null,
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
