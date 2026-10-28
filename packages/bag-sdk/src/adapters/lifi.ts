import { BagSdkError } from '../errors';
import { createComposeSdk, materialisers, resources } from '@lifi/composer-sdk';
import type { Bindable } from '@lifi/composer-sdk';
import type { ComposerCompileRequest, ComposerCompileResult, ComposerProvider } from '../execution';
import { markSignedUsdPriceImpactProvider, ProviderResponseError } from '../execution';
import { planPartition } from '../partition';
import type { ComposerAccount } from './composer-account';
export { resolveLifiComposerAccount, type ComposerAccount, type ComposerAccountClient, type ComposerDeployment } from './composer-account';

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
  /** Independent chain observation from resolveLifiComposerAccount; never derive this from the compile response. */
  account?: ComposerAccount;
}

const legNode = (i: number) => `swap_${i}`;

export function lifiComposer(options: LifiComposerOptions): ComposerProvider {
  if (!options.apiKey) throw new BagSdkError('COMPOSER_CONFIGURATION_INVALID', 'lifiComposer: apiKey is required (your own LI.FI API key).');
  if (!options.baseUrl) throw new BagSdkError('COMPOSER_CONFIGURATION_INVALID', 'lifiComposer: baseUrl is required (the Composer API to call).');
  let endpoint: URL;
  try {
    endpoint = new URL(options.baseUrl);
  } catch {
    throw new BagSdkError('COMPOSER_CONFIGURATION_INVALID', 'lifiComposer: baseUrl must be a valid HTTPS URL.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new BagSdkError('COMPOSER_CONFIGURATION_INVALID', 'lifiComposer: baseUrl must use HTTPS and cannot contain credentials, a query, or a fragment.');
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new BagSdkError('COMPOSER_CONFIGURATION_INVALID', 'lifiComposer: invalid timeoutMs.');
  // Composer reports a signed, USD-based impact; only this adapter's providers may report a negative one.
  return markSignedUsdPriceImpactProvider({
    name: 'lifi-composer',
    async compile(req: ComposerCompileRequest): Promise<ComposerCompileResult> {
      const account = options.account;
      if (account && (account.chainId !== req.chainId || account.signer.toLowerCase() !== req.signer.toLowerCase())) {
        throw new BagSdkError('ACCOUNT_PROXY_MISMATCH', 'LI.FI Composer account observation belongs to a different chain or signer.');
      }
      const base = options.fetch ?? fetch;
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
      if (result.status !== 'success') throw new BagSdkError('COMPOSER_PARTIAL_RESULT', `LI.FI Composer returned a partial result (${result.error.kind}) under strict simulation.`);
      if (!result.transactionRequest) throw new BagSdkError('COMPOSER_PARTIAL_RESULT', 'LI.FI Composer reported success without a transaction.');
      if (account) {
        const target = account.proxyDeployed ? account.proxy : account.factory;
        if (result.transactionRequest.to.toLowerCase() !== target.toLowerCase() || result.userProxy?.toLowerCase() !== account.proxy.toLowerCase()) {
          throw new BagSdkError('ACCOUNT_PROXY_MISMATCH', 'LI.FI Composer target or user proxy differs from the independently resolved account.');
        }
        if ((result.approvals ?? []).some(a => a.spender.toLowerCase() !== account.proxy.toLowerCase())) {
          throw new BagSdkError('ACCOUNT_PROXY_MISMATCH', 'LI.FI Composer approval spender differs from the independently resolved proxy.');
        }
      }

      const outputs = result.outputs;
      const fees = result.fees ?? [];
      const warnings = result.warnings ?? [];
      if (!Array.isArray(fees) || fees.some(f => !f || typeof f !== 'object' || Array.isArray(f))) throw new ProviderResponseError('lifi-composer: malformed fee list.', 'FEE_METADATA_INVALID');
      if (!Array.isArray(warnings) || warnings.some(w => !w || typeof w !== 'object' || Array.isArray(w))) throw new ProviderResponseError('lifi-composer: malformed warning list.', 'WARNING_METADATA_INVALID');
      if (result.fill != null && (typeof result.fill !== 'object' || Array.isArray(result.fill))) throw new ProviderResponseError('lifi-composer: malformed quote validity metadata.', 'QUOTE_TIMING_INVALID');
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
          if (o && (o.role !== 'terminal' || o.owner?.toLowerCase() !== req.signer.toLowerCase() || o.delivery.when !== 'now' || o.resource.chainId !== chainId)) {
            throw new BagSdkError('OUTPUT_INVALID', 'LI.FI Composer output is not immediate terminal delivery on the requested chain to the signer.');
          }
          return {
            token: o && o.resource.kind === 'erc20' ? o.resource.token : null,
            expectedOutRaw: o?.amount.estimate ? o.amount.estimate.value.toString() : null,
            minOutRaw: o?.amount.minimum ? o.amount.minimum.value.toString() : null,
          };
        }),
        // Raw values, never clamped: a negative impactBps stays negative and is judged by compileBag.
        priceImpactBps: result.priceImpact?.impactBps ?? null,
        priceImpactUsd: result.priceImpact ? {
          inputValueUsd: result.priceImpact.inputValueUsd,
          outputValueUsd: result.priceImpact.outputValueUsd,
          unpricedInputs: result.priceImpact.unpricedInputs as string[],
          unpricedOutputs: result.priceImpact.unpricedOutputs as string[],
        } : null,
        gasLimit: result.transactionRequest.gasLimit ?? null,
        fees: fees.map((f) => ({ token: f.token, recipient: f.recipient, recipientAddress: f.recipientAddress, bps: f.bps, amountRaw: f.amount ?? null })),
        validUntilMs: result.fill?.validUntilMs ?? null,
        warnings: warnings.map((w) => ({ kind: w.kind, message: w.message,
          ...(w.path !== undefined ? { path: w.path } : {}),
          ...(w.port !== undefined ? { port: w.port } : {}),
          ...(w.fix !== undefined ? { fix: w.fix } : {}),
        })),
      };
    },
  });
}
