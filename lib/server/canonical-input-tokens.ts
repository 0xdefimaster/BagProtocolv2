import { SupabaseClient } from '@supabase/supabase-js';
import { CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { listAssets } from './asset-repo';
import { ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// H1 follow-up (Bag Router execution hardening security audit) — the single
// place "which ERC-20s should this chain's on-chain router(s) accept" is
// derived, so `scripts/deploy-bag-execution-router.ts`,
// `scripts/deploy-redeem-fee-router.ts`, and
// `scripts/sync-router-token-allowlist.ts` all read from ONE function
// instead of each re-deriving (or, as `deploy-bag-execution-router.ts` used
// to, requiring a human to hand-type `CANONICAL_TOKEN_ADDRESSES`) their own
// answer. "Canonical Asset Registry -> Supported Input Tokens -> router
// token allowlist" is the whole point: a token this returns is a token the
// registry itself considers real for this chain, never a hardcoded second
// list that can silently drift from it.
//
// TWO kinds of canonical token, combined here because both routers need
// both kinds, just in different mixes:
//
//   1. The chain's SETTLEMENT/INPUT currency (`ROBINHOOD_REWARD_TOKEN` on
//      Robinhood Chain, USDG) — not a registry `assets` row at all. It is
//      the currency a purchase's input is denominated in AND the currency
//      a redemption's fee/proceeds settle in — a fixed protocol-level
//      constant (`lib/config/robinhood-chain.ts`), not something the asset
//      importers (coingecko-import.ts/robinhood-import.ts) ever register,
//      since it is never itself a Bag composition's OUTPUT asset.
//   2. Registry `assets` rows for the chain — the actual strategy
//      holdings a Bag can be composed of, and therefore also the possible
//      INPUT side of a redemption (redeeming OUT of a held asset back to
//      the settlement currency).
//
// `includeDeprecated` exists because these two use cases need DIFFERENT
// registry scopes: a PURCHASE-side allowlist (BagExecutionRouter) only
// ever needs to accept NEWLY VERIFIED assets — there is no reason to let a
// new purchase route into something the registry has since deprecated.
// A REDEMPTION-side allowlist (RedeemFeeRouter) is different: a Bag
// created while some asset was VERIFIED can still be holding it after
// that asset is later marked DEPRECATED, and that Bag's investors must
// still be able to redeem out of it — so redemption-side callers pass
// `includeDeprecated: true` to also cover DEPRECATED assets, never just
// VERIFIED ones.
// -----------------------------------------------------------------------------

export interface CanonicalInputToken {
  chain: ChainId;
  address: string;
  symbol: string;
  /** `'settlement'` for the chain's fixed input/settlement currency (never a registry row); `'registry-asset'` for an actual Bag-composition asset. */
  purpose: 'settlement' | 'registry-asset';
}

/** This protocol's per-chain settlement/input currency, or `null` for a chain with none configured (every chain other than `'robinhood'` today — `RedeemFeeRouter`/`CreatorRewardsVault` are Robinhood-Chain-only, per their own contract-level doc). Pure — no I/O — so tests never need to touch Supabase to exercise this. */
export function getSettlementTokenForChain(chain: ChainId): CanonicalInputToken | null {
  if (chain !== 'robinhood') return null;
  return {
    chain,
    address: ROBINHOOD_REWARD_TOKEN.address,
    symbol: ROBINHOOD_REWARD_TOKEN.symbol,
    purpose: 'settlement',
  };
}

/**
 * Pure merge step: settlement token (if any) + registry assets -> one
 * deduplicated `CanonicalInputToken[]`, identity keyed on `(chain,
 * address)` case-insensitively — never on symbol alone (two different
 * chains, or a real asset and an impostor, can share a symbol; they can
 * never share a lowercased address on the same chain, since `assets` has a
 * `unique(chain, address)` constraint). The settlement token always wins a
 * collision (kept first) since it is the more specific, authoritative
 * source for that one address.
 */
export function mergeCanonicalInputTokens(
  settlementToken: CanonicalInputToken | null,
  registryAssets: CanonicalAsset[]
): CanonicalInputToken[] {
  const seen = new Set<string>();
  const merged: CanonicalInputToken[] = [];

  const add = (token: CanonicalInputToken) => {
    const key = `${token.chain}:${token.address.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(token);
  };

  if (settlementToken) add(settlementToken);
  for (const asset of registryAssets) {
    add({ chain: asset.chain, address: asset.address, symbol: asset.symbol, purpose: 'registry-asset' });
  }

  return merged;
}

/**
 * The canonical input-token list for one chain, combining
 * `getSettlementTokenForChain()` with a registry lookup scoped to that
 * chain — never all chains at once (a token real on `ethereum` is not
 * thereby real on `robinhood`; each on-chain router only ever needs, and
 * only ever should accept, its OWN chain's tokens).
 */
export async function getCanonicalInputTokensForChain(
  admin: SupabaseClient,
  chain: ChainId,
  options: { includeDeprecated?: boolean } = {}
): Promise<CanonicalInputToken[]> {
  const statuses = options.includeDeprecated ? (['VERIFIED', 'DEPRECATED'] as const) : (['VERIFIED'] as const);
  const registryAssets = await listAssets(admin, { chain, status: [...statuses], limit: 1000 });
  return mergeCanonicalInputTokens(getSettlementTokenForChain(chain), registryAssets);
}

// -----------------------------------------------------------------------------
// Drift detection — `scripts/sync-router-token-allowlist.ts`'s pure core.
// Kept separate from that script's RPC/log-reading I/O so the actual
// decision logic ("what's missing, what's extra") has its own unit tests
// that never need a real chain.
// -----------------------------------------------------------------------------

export interface AllowlistDrift {
  /** Canonical says this SHOULD be allowed on-chain, but it currently isn't — the dangerous direction (a legitimate purchase/redemption will revert) and the one `--apply` fixes. */
  missing: CanonicalInputToken[];
  /** On-chain currently allows this address, but the canonical list (as of THIS run) does not include it — NEVER auto-removed (see this file's module doc: a redemption-side allowlist must keep letting a Bag redeem an asset even after it's deprecated, so "extra" is not automatically "wrong", only "needs a human to check why"). */
  extra: string[];
}

/**
 * Pure diff: which canonical tokens aren't yet allowed on-chain, and which
 * on-chain-allowed addresses the canonical list (as fetched for THIS run)
 * doesn't currently name. Case-insensitive on addresses throughout — an
 * on-chain read and a Supabase-stored address can differ only in
 * checksum casing and must still be treated as the same token.
 */
export function computeAllowlistDrift(canonical: CanonicalInputToken[], onChainAllowed: Set<string>): AllowlistDrift {
  const onChainLower = new Set(Array.from(onChainAllowed, (a) => a.toLowerCase()));
  const canonicalLower = new Set(canonical.map((t) => t.address.toLowerCase()));

  const missing = canonical.filter((t) => !onChainLower.has(t.address.toLowerCase()));
  const extra = Array.from(onChainLower).filter((addr) => !canonicalLower.has(addr));

  return { missing, extra };
}
