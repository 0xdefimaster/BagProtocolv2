import { createClient, SDKClient } from '@lifi/sdk';
import { ChainId } from '@/types/basket-protocol';

// -----------------------------------------------------------------------------
// Phase 14 — LI.FI SDK setup shared by lifi-execution-adapter.ts.
//
// This project's own `ChainId` type (types/basket-protocol.ts:
// `'ethereum' | 'base' | 'arbitrum' | 'solana'`) is a closed, human-readable
// union chosen for the protocol layer — it is NOT the same thing as LI.FI's
// numeric chain ids (spec section 6/8). This file is the ONE place that
// translation happens, so nothing else in the codebase needs to know LI.FI's
// numbering scheme.
//
// Numeric values below are LI.FI's own `ChainId` enum (`@lifi/types`,
// installed transitively via `@lifi/sdk`): `ChainId.ETH = 1`,
// `ChainId.ARB = 42161`, `ChainId.BAS = 8453`, `ChainId.SOL =
// 1151111081099710`. Copied as plain numbers (verified directly against the
// installed `@lifi/types` package, not from memory) rather than importing
// that enum, so this map reads as "this protocol's chain -> this number",
// independent of whichever export path LI.FI's own enum happens to live at.
//
// Only the core `@lifi/sdk` package is a dependency (no
// `@lifi/sdk-provider-ethereum`/`-solana`/etc.) — those provider packages
// are only needed to EXECUTE a route through the SDK (wallet signing), and
// this phase never does that (spec section 0/21). `getQuote()` alone needs
// nothing beyond `createClient()`.
// -----------------------------------------------------------------------------

// Phase 16 — 'robinhood' (Robinhood Chain, the Stock Token registry's
// chain — `lib/domain/basket-protocol/registry/robinhood-import.ts`) is
// now mapped. Verified (not guessed) two ways as of this phase: (1)
// Robinhood Chain is a standard Arbitrum Orbit L2 settling on Ethereum,
// and its own docs/RPC config give its EVM chain id as plain decimal
// 4663 — the same number this file already used for `ROBINHOOD_CHAIN_ID`
// in robinhood-import.ts, so no separate "LI.FI's own numbering" exists
// here the way Solana's non-EVM id required; (2) LI.FI's own
// announcement confirms it supports swaps/routing into Robinhood Chain
// "from day one", including routing into Stock Tokens specifically — so
// this is a live, routable chain for `getQuote()`, not just a chain id
// that happens to exist. `UnsupportedChainError` below still exists and
// still applies to any FUTURE chain added to `ChainId` before its LI.FI
// support is verified the same way — this map stays partial by design.
const LIFI_CHAIN_IDS: Partial<Record<ChainId, number>> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  solana: 1151111081099710,
  robinhood: 4663,
};

/** Thrown by `toLiFiChainId()` for a `ChainId` this file hasn't been taught LI.FI's numeric id for yet — never silently falls back to a guess. */
export class UnsupportedChainError extends Error {
  constructor(public readonly chain: string) {
    super(`No LI.FI chain id mapping for chain "${chain}".`);
    this.name = 'UnsupportedChainError';
  }
}

export function toLiFiChainId(chain: ChainId): number {
  const id = LIFI_CHAIN_IDS[chain];
  if (id === undefined) throw new UnsupportedChainError(chain);
  return id;
}

let client: SDKClient | null = null;

/**
 * Lazily creates (and memoizes) the shared `@lifi/sdk` client. Server-only
 * (spec section 16) — this module is only ever imported from
 * `lifi-execution-adapter.ts`, itself only ever imported from a Next.js API
 * route, never from client code, so `LIFI_API_KEY` never reaches the
 * browser bundle.
 */
export function getLiFiClient(): SDKClient {
  if (client) return client;
  client = createClient({
    integrator: process.env.LIFI_INTEGRATOR ?? 'bag-protocol',
    apiKey: process.env.LIFI_API_KEY,
  });
  return client;
}

/** Test-only: drop the memoized client so a new `LIFI_INTEGRATOR`/`LIFI_API_KEY` (or a mocked `createClient`) takes effect on the next call. */
export function resetLiFiClientForTests(): void {
  client = null;
}
