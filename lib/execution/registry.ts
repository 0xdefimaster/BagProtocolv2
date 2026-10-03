import { BagRouterProvider, BagRouterProviderConfig } from './providers/bag-router-provider';
import { LiFiComposerProvider, LiFiComposerProviderConfig } from './providers/lifi-composer-provider';
import { LiFiSequentialProvider } from './providers/lifi-sequential-provider';
import { BagExecutionProvider } from './providers/types';

// -----------------------------------------------------------------------------
// lib/execution/registry.ts
//
// The ONE place BAG's default provider fallback order is declared (spec
// item 6). `compiler.ts` itself has no opinion on ordering — it just tries
// providers in the order it's given. Today's default order:
//   BAG Router (only when configured) → LI.FI Composer → sequential LI.FI.
// Composer is the single-signature path whenever the router isn't
// configured or can't serve the graph; sequential LI.FI is the catch-all
// fallback for everything Composer can't do (cross-chain, wrong chain,
// mixed input assets).
//
// A future `BagRouterProvider` or direct-DEX provider (spec items 7/9)
// slots into this same array — inserted wherever its priority belongs,
// never by editing `compiler.ts`.
// -----------------------------------------------------------------------------

export interface DefaultProvidersConfig {
  /**
   * Omit entirely (not just an empty `apiKey`) to exclude
   * `LiFiComposerProvider` from the registry altogether — mirrors the
   * existing `process.env.LIFI_API_KEY` check in
   * `purchase-execution.ts`'s legacy path: no key means Composer is never
   * even attempted, not "attempted and always ineligible".
   */
  lifiComposer?: LiFiComposerProviderConfig;
  /**
   * Item 7 — BAG's own on-chain router (`contracts/BagExecutionRouter.sol`).
   * Omitted by default, and omitted ENTIRELY (never registered-but-failing)
   * when a deployment hasn't configured a deployed router address, a leg
   * builder, and a plan signer — same "no key, never attempted" rule as
   * Composer above. A deployment that has none of those is byte-for-byte
   * unchanged from before item 7 existed.
   */
  bagRouter?: BagRouterProviderConfig;
}

export function buildDefaultProviders(config: DefaultProvidersConfig = {}): BagExecutionProvider[] {
  const providers: BagExecutionProvider[] = [];
  // Ordered FIRST when configured: it is BAG's own execution boundary, so
  // when it can serve a graph at all it is preferred over routing the same
  // basket through a third-party aggregator. It only claims same-chain,
  // single-input graphs on the one chain the router is deployed to (see
  // `BagRouterProvider.supports()`), so everything else still falls
  // through to Composer and then sequential LI.FI exactly as before —
  // `compiler.ts` is untouched by this.
  if (config.bagRouter) {
    providers.push(new BagRouterProvider(config.bagRouter));
  }
  if (config.lifiComposer) {
    providers.push(new LiFiComposerProvider(config.lifiComposer));
  }
  providers.push(new LiFiSequentialProvider());
  return providers;
}
