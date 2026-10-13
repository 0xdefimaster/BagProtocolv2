import { getTokens } from '@lifi/sdk';
import { TokenTag } from '@lifi/types';
import { ChainId, CanonicalAsset } from '@/types/basket-protocol';
import { assetIdentityKey } from '../asset-identity';
import { RegisterAssetInput, RegisterAssetResult } from '@/lib/server/asset-repo';
import { getLiFiClient } from '@/lib/blockchain/lifi-config';
import { toLiFiChainId } from '@/lib/blockchain/lifi-config';
import { LOCAL_COIN_CANDIDATES } from './coingecko-import';
import { ROBINHOOD_REWARD_TOKEN, ROBINHOOD_WETH_ADDRESS } from '@/lib/config/robinhood-chain';
import { LogoUpdate, planLogoUpdates, sanitizeLogoUrl } from './logo-url';

// -----------------------------------------------------------------------------
// "Which coins/stocks exist on which network, per LI.FI" — same plan/apply
// role for `cryptoAssets`/EVM chains that coingecko-import.ts already
// plays, but sourced from LI.FI's own `getTokens()` instead of CoinGecko.
// This is a strictly better resolution source for the one thing this
// registry actually needs to know: not just "does this coin have SOME
// contract address on this chain" (CoinGecko's `detail_platforms`), but
// "can BAG's own execution layer (LI.FI Sequential/Composer,
// lib/execution/providers/) actually route a real swap into it on this
// chain" — which is exactly what a token appearing in LI.FI's own
// `getTokens()` response for that chain means.
//
// Deliberately still CANDIDATE-LIST-DRIVEN (`LOCAL_COIN_CANDIDATES`, reused
// verbatim from coingecko-import.ts — one list, not two independently
// drifting ones), never a blind bulk-import of LI.FI's entire per-chain
// token universe: LI.FI aggregates thousands of tokens per chain, and
// `VERIFIED` in this registry carries real trust weight (any VERIFIED
// asset becomes something a real Bag's real money can be routed into) —
// auto-registering "every token LI.FI happens to have heard of" would be a
// governance regression, not an improvement, no matter how good the data
// source is. One `getTokens()` call per chain fetches the FULL per-chain
// list once; matching against the curated candidate list happens locally,
// so this never fires one request per candidate the way the CoinGecko path
// (rate-limited, no bulk endpoint) had to.
//
// Scope: `ethereum`/`base`/`arbitrum`, plus the CRYPTO side of `robinhood`
// (WETH, USDG, ...). Robinhood Stock Tokens keep their own live, first-party
// source (robinhood-import.ts); on `robinhood` this module skips anything
// LI.FI tags `rwa` and never writes a stock row.
// -----------------------------------------------------------------------------

export type LiFiImportTargetChain = Extract<ChainId, 'ethereum' | 'base' | 'arbitrum' | 'robinhood'>;

export class LiFiTokensFetchError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LiFiTokensFetchError';
  }
}

/**
 * One raw token entry from LI.FI's `getTokens()` response — the subset
 * this module reads. Kept as its own local shape (rather than importing
 * `@lifi/types`'s full `Token` interface) so a test can build one without
 * needing every field LI.FI's real type happens to require.
 */
export interface LiFiRawToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tags?: string[];
  logoURI?: string;
  verificationStatus?: 'verified' | 'unverified' | 'flagged';
  marketCapUSD?: number | null;
}

export type SkippedLiFiTokenReason =
  | 'NOT_REQUESTED'
  | 'NATIVE_TOKEN'
  | 'STOCK_TOKEN'
  | 'FLAGGED_BY_LIFI'
  | 'UNVERIFIED_BY_LIFI'
  | 'NOT_PINNED_ADDRESS'
  | 'NAME_MISMATCH'
  | 'LOW_MARKET_CAP'
  | 'AMBIGUOUS_SYMBOL';

export interface SkippedLiFiToken {
  symbol: string;
  address: string;
  name: string;
  reason: SkippedLiFiTokenReason;
}

/**
 * A symbol alone is not an identity: LI.FI's per-chain list holds many
 * unrelated tokens that reuse a famous ticker (a live ethereum run matched
 * "SHIB" to "NicCageWaluigiElmo42069Inu" and "PEPE" to "Pepe Community").
 * A token is only accepted when its name is the candidate's own name or one
 * of these known names for the same coin. A symbol with no entry here is
 * accepted only under its candidate `name`, so BTC/SOL/DOGE never match a
 * "Wrapped BTC" / "Wrapped SOL (Wormhole)" stand-in.
 */
const ACCEPTED_NAMES: Record<string, string[]> = {
  SHIB: ['Shiba Inu'],
  MATIC: ['Matic', 'Polygon Ecosystem Token'],
  STG: ['Stargate'],
  CRV: ['Curve DAO'],
  LDO: ['Lido DAO'],
  FET: ['Fetch', 'Artificial Superintelligence Alliance'],
  ONDO: ['Ondo'],
  GHO: ['GHO'],
  USDC: ['USDC'],
  USDT: ['Tether', 'USDT', 'USDT0'],
  DAI: ['Dai'],
  USDS: ['USDS'],
  USDE: ['USDe'],
  WETH: ['Wrapped ETH', 'WETH'],
  STETH: ['stETH', 'Lido Staked ETH'],
  WSTETH: ['Wrapped stETH', 'wstETH', 'Arbitrum Bridged wstETH'],
  WBTC: ['Wrapped Bitcoin', 'WBTC'],
  LINK: ['ChainLink'],
  SNX: ['Synthetix', 'SNX'],
  YFI: ['yearn'],
  GRT: ['Graph'],
  SAND: ['SAND'],
  MANA: ['Decentraland MANA'],
  IMX: ['ImmutableX', 'Immutable', 'IMX'],
  SKY: ['SKY Governance'],
  WLD: ['World', 'WLD'],
  EIGEN: ['Eigenlayer'],
  VIRTUAL: ['Virtuals Protocol'],
  AERO: ['Aerodrome'],
  USDG: ['USDG'],
};

/**
 * Contracts the protocol already pins in its own config, verified against
 * Robinhood's documentation (lib/config/robinhood-chain.ts). LI.FI marks
 * every token on Robinhood Chain unverified, so without this nothing there
 * could be registered. For a pinned symbol ONLY the pinned address is
 * accepted — any other contract reusing the symbol is rejected — and the
 * name / market-cap / LI.FI-verification checks are not needed.
 */
const PINNED_ADDRESSES: Partial<Record<LiFiImportTargetChain, Record<string, string>>> = {
  robinhood: {
    USDG: ROBINHOOD_REWARD_TOKEN.address,
    WETH: ROBINHOOD_WETH_ADDRESS,
  },
};

/**
 * Community tokens the project owner explicitly chose to list on a chain even
 * though LI.FI marks them unverified (on Robinhood Chain LI.FI marks every
 * token unverified). Their contract comes from LI.FI's own token list at
 * import time — never hard-coded here — and they still have to be the ONLY
 * LI.FI token with that symbol on the chain (a second one means a possible
 * impostor, and neither is registered). Not flagged, not native, not a Stock
 * Token. Name and market-cap checks are skipped: these are small-cap tokens
 * by nature. Listing one is a product decision about higher-risk assets.
 */
export const COMMUNITY_TOKENS: Partial<Record<LiFiImportTargetChain, readonly string[]>> = {
  robinhood: ['CASHCAT', 'PONS'],
};

/** Floor applied only when LI.FI reports a market cap — never inferred when it doesn't. */
const MIN_MARKET_CAP_USD = 1_000_000;

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Lowercase alphanumerics only, a trailing "(...)" qualifier and a trailing "token" dropped. */
function normalizeTokenName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/token$/, '');
}

function nameMatchesCandidate(tokenName: string, candidate: { symbol: string; name: string }): boolean {
  const normalized = normalizeTokenName(tokenName);
  if (!normalized) return false;
  const accepted = [candidate.name, ...(ACCEPTED_NAMES[candidate.symbol.toUpperCase()] ?? [])];
  return accepted.some((n) => normalizeTokenName(n) === normalized);
}

/**
 * Classifies a LI.FI token as `'stock'` when it carries LI.FI's own `rwa`
 * (real-world-asset) tag — the same signal LI.FI uses for tokenized
 * equities like Robinhood Stock Tokens — and `'crypto'` otherwise. Never
 * invented locally: this is LI.FI's own classification, read straight off
 * the token's `tags`.
 */
function classifyLiFiToken(token: LiFiRawToken): 'stock' | 'crypto' {
  return token.tags?.includes(TokenTag.RWA) ? 'stock' : 'crypto';
}

/**
 * Fetches LI.FI's full known token list for `targetChain` ONCE, then keeps
 * only the entries that are unambiguously one of `localCoins` — never
 * anything else LI.FI happens to also know about on that chain. A symbol
 * match is necessary but not sufficient (see `ACCEPTED_NAMES`); every
 * rejected match is reported in `skipped` with its reason. When more than
 * one token survives for a symbol, none is registered — the importer never
 * guesses which one is real. Never throws: a network/API failure resolves
 * to `{ candidates: [], skipped: [], fetchError }` so a caller can report it
 * per-chain without one chain's failure aborting a multi-chain run.
 */
export async function fetchLiFiTokenCandidatesForChain(
  targetChain: LiFiImportTargetChain,
  localCoins: { symbol: string; name: string }[] = LOCAL_COIN_CANDIDATES
): Promise<{ candidates: RegisterAssetInput[]; skipped: SkippedLiFiToken[]; fetchError?: string }> {
  const wantedSymbols = new Map(localCoins.map((c) => [c.symbol.toUpperCase(), c]));
  const communitySymbols = new Set((COMMUNITY_TOKENS[targetChain] ?? []).map((sym) => sym.toUpperCase()));
  for (const sym of communitySymbols) {
    if (!wantedSymbols.has(sym)) wantedSymbols.set(sym, { symbol: sym, name: sym });
  }
  if (wantedSymbols.size === 0) return { candidates: [], skipped: [] };

  let rawTokens: LiFiRawToken[];
  try {
    const numericChainId = toLiFiChainId(targetChain);
    const client = getLiFiClient();
    const response = await getTokens(client, { chains: [numericChainId], extended: true });
    rawTokens = (response.tokens[numericChainId] ?? []) as unknown as LiFiRawToken[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { candidates: [], skipped: [], fetchError: message };
  }

  const skipped: SkippedLiFiToken[] = [];
  const survivorsBySymbol = new Map<string, { token: LiFiRawToken; local: { symbol: string; name: string } }[]>();
  for (const token of rawTokens) {
    const local = wantedSymbols.get(token.symbol.toUpperCase());
    if (!local) continue; // not one of our curated candidates — never registered
    if (typeof token.decimals !== 'number' || !token.address) continue; // never fabricate a missing field

    const skip = (reason: SkippedLiFiTokenReason) =>
      skipped.push({ symbol: local.symbol, address: token.address, name: token.name, reason });

    if (token.address.toLowerCase() === NATIVE_TOKEN_ADDRESS) {
      skip('NATIVE_TOKEN'); // the chain's gas token, not an ERC-20 a Bag can hold
      continue;
    }
    if (targetChain === 'robinhood' && classifyLiFiToken(token) === 'stock') {
      skip('STOCK_TOKEN'); // owned by robinhood-import.ts
      continue;
    }
    const pinned = PINNED_ADDRESSES[targetChain]?.[local.symbol.toUpperCase()];
    if (pinned) {
      if (token.address.toLowerCase() !== pinned.toLowerCase()) {
        skip('NOT_PINNED_ADDRESS');
        continue;
      }
      const list = survivorsBySymbol.get(local.symbol) ?? [];
      list.push({ token, local });
      survivorsBySymbol.set(local.symbol, list);
      continue;
    }
    if (token.verificationStatus === 'flagged') {
      skip('FLAGGED_BY_LIFI');
      continue;
    }
    if (communitySymbols.has(local.symbol.toUpperCase())) {
      // Owner-approved community token — see COMMUNITY_TOKENS. Still subject
      // to the single-survivor (AMBIGUOUS_SYMBOL) rule below.
      const list = survivorsBySymbol.get(local.symbol) ?? [];
      list.push({ token, local });
      survivorsBySymbol.set(local.symbol, list);
      continue;
    }
    if (token.verificationStatus === 'unverified') {
      skip('UNVERIFIED_BY_LIFI');
      continue;
    }
    if (!nameMatchesCandidate(token.name, local)) {
      skip('NAME_MISMATCH');
      continue;
    }
    if (typeof token.marketCapUSD === 'number' && token.marketCapUSD < MIN_MARKET_CAP_USD) {
      skip('LOW_MARKET_CAP');
      continue;
    }

    const list = survivorsBySymbol.get(local.symbol) ?? [];
    list.push({ token, local });
    survivorsBySymbol.set(local.symbol, list);
  }

  const candidates: RegisterAssetInput[] = [];
  for (const [symbol, survivors] of survivorsBySymbol) {
    if (survivors.length > 1) {
      for (const { token } of survivors) {
        skipped.push({ symbol, address: token.address, name: token.name, reason: 'AMBIGUOUS_SYMBOL' });
      }
      continue;
    }
    const { token, local } = survivors[0];
    candidates.push({
      chain: targetChain,
      address: token.address,
      symbol: local.symbol,
      decimals: token.decimals,
      name: token.name || local.name,
      assetType: classifyLiFiToken(token),
      logoUrl: sanitizeLogoUrl(token.logoURI),
    });
  }

  return { candidates, skipped };
}

/** Networks whose tokenized stocks are imported from LI.FI. Robinhood Stock Tokens keep their first-party source (robinhood-import.ts). */
export type LiFiStockImportChain = Extract<LiFiImportTargetChain, 'ethereum' | 'base' | 'arbitrum'>;

export interface LiFiStockCandidate extends RegisterAssetInput {
  /** LI.FI's market cap and USD price, printed for the owner's review; never written to the registry. */
  marketCapUSD: number | null;
  priceUSD: string | null;
  /** Why this token counts as a stock: LI.FI's `rwa` tag, or a known issuer's naming. Printed only. */
  signal: LiFiStockSignal;
}

export type LiFiStockSignal = 'rwa' | 'backed' | 'xstock' | 'ondo';

/**
 * Tokenized-stock issuers whose tokens LI.FI lists without its `rwa` tag
 * (Jumper shows Backed's bNVDA on Arbitrum, Ondo's NVDAon on Ethereum).
 * Both the name and the symbol must follow the issuer's own scheme; the
 * token must still be LI.FI-verified, unambiguous, and named by the owner
 * in `--only` before anything is written.
 */
const ISSUER_STOCK_PATTERNS: { signal: Exclude<LiFiStockSignal, 'rwa'>; name: RegExp; symbol: RegExp }[] = [
  { signal: 'backed', name: /^Backed\s/i, symbol: /^b[A-Z0-9.]+$/ },
  { signal: 'xstock', name: /\bxStock$/i, symbol: /^[A-Z0-9.]+x$/ },
  { signal: 'ondo', name: /\bOndo Tokenized\b/i, symbol: /^[A-Z0-9.]+on$/ },
];

function stockSignal(token: LiFiRawToken): LiFiStockSignal | null {
  if (classifyLiFiToken(token) === 'stock') return 'rwa';
  const name = token.name ?? '';
  const symbol = token.symbol ?? '';
  return ISSUER_STOCK_PATTERNS.find((p) => p.name.test(name) && p.symbol.test(symbol))?.signal ?? null;
}

/**
 * Tokenized stocks LI.FI lists on an EVM network, for the owner to review: every
 * token LI.FI tags `rwa` (its tokenized-equity signal), or that follows a known
 * issuer's naming (`ISSUER_STOCK_PATTERNS`), and that LI.FI marks VERIFIED. No
 * exception for an unverified or flagged token, no native token, no missing
 * field, and a symbol more than one such token claims is skipped as ambiguous.
 * `only`, when given, keeps just those symbols; every other stock is reported
 * as NOT_REQUESTED. Addresses, decimals and names come from LI.FI's response,
 * never from this code. Never throws: a fetch failure is returned as `fetchError`.
 */
export async function fetchLiFiStockCandidatesForChain(
  targetChain: LiFiStockImportChain,
  options: { only?: string[] } = {}
): Promise<{ candidates: LiFiStockCandidate[]; skipped: SkippedLiFiToken[]; fetchError?: string }> {
  let rawTokens: (LiFiRawToken & { priceUSD?: string })[];
  try {
    const numericChainId = toLiFiChainId(targetChain);
    const response = await getTokens(getLiFiClient(), { chains: [numericChainId], extended: true });
    rawTokens = (response.tokens[numericChainId] ?? []) as unknown as (LiFiRawToken & { priceUSD?: string })[];
  } catch (err) {
    return { candidates: [], skipped: [], fetchError: err instanceof Error ? err.message : String(err) };
  }

  const only = options.only && options.only.length > 0 ? new Set(options.only.map((s) => s.toUpperCase())) : null;
  const skipped: SkippedLiFiToken[] = [];
  const bySymbol = new Map<string, (LiFiRawToken & { priceUSD?: string })[]>();
  for (const token of rawTokens) {
    if (stockSignal(token) === null) continue;
    if (typeof token.decimals !== 'number' || !token.address || !token.symbol) continue; // never fabricate a missing field
    const skip = (reason: SkippedLiFiTokenReason) => skipped.push({ symbol: token.symbol, address: token.address, name: token.name, reason });
    if (token.address.toLowerCase() === NATIVE_TOKEN_ADDRESS) {
      skip('NATIVE_TOKEN');
      continue;
    }
    if (token.verificationStatus === 'flagged') {
      skip('FLAGGED_BY_LIFI');
      continue;
    }
    if (token.verificationStatus !== 'verified') {
      skip('UNVERIFIED_BY_LIFI');
      continue;
    }
    if (only && !only.has(token.symbol.toUpperCase())) {
      skip('NOT_REQUESTED');
      continue;
    }
    const key = token.symbol.toUpperCase();
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), token]);
  }

  const candidates: LiFiStockCandidate[] = [];
  for (const tokens of bySymbol.values()) {
    if (tokens.length > 1) {
      for (const t of tokens) skipped.push({ symbol: t.symbol, address: t.address, name: t.name, reason: 'AMBIGUOUS_SYMBOL' });
      continue;
    }
    const [t] = tokens;
    candidates.push({
      chain: targetChain,
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      name: t.name || t.symbol,
      assetType: 'stock',
      logoUrl: sanitizeLogoUrl(t.logoURI),
      marketCapUSD: typeof t.marketCapUSD === 'number' ? t.marketCapUSD : null,
      priceUSD: typeof t.priceUSD === 'string' ? t.priceUSD : null,
      signal: stockSignal(t) ?? 'rwa',
    });
  }
  candidates.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { candidates, skipped };
}

/**
 * Read-only lookup for the owner: every token in LI.FI's list for `targetChain`
 * whose symbol or name contains `term` (case-insensitive), with LI.FI's own
 * verification status and tags, so a stock LI.FI lists under an unexpected
 * name can be found before any import rule is written for it. Never writes;
 * never throws (a fetch failure is returned as `fetchError`).
 */
export async function searchLiFiTokens(
  targetChain: LiFiImportTargetChain,
  term: string
): Promise<{ matches: Pick<LiFiRawToken, 'address' | 'symbol' | 'name' | 'decimals' | 'tags' | 'verificationStatus'>[]; fetchError?: string }> {
  const needle = term.trim().toLowerCase();
  if (!needle) return { matches: [] };
  let rawTokens: LiFiRawToken[];
  try {
    const numericChainId = toLiFiChainId(targetChain);
    const response = await getTokens(getLiFiClient(), { chains: [numericChainId], extended: true });
    rawTokens = (response.tokens[numericChainId] ?? []) as unknown as LiFiRawToken[];
  } catch (err) {
    return { matches: [], fetchError: err instanceof Error ? err.message : String(err) };
  }
  const matches = rawTokens
    .filter((t) => (t.symbol ?? '').toLowerCase().includes(needle) || (t.name ?? '').toLowerCase().includes(needle))
    .map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, tags: t.tags, verificationStatus: t.verificationStatus }))
    .sort((a, b) => (a.symbol ?? '').localeCompare(b.symbol ?? ''));
  return { matches };
}

export interface LiFiImportPlan {
  /** Not yet in the registry at this (chain, address) — safe to `registerAsset()`. */
  toRegister: RegisterAssetInput[];
  /** Already registered — no action needed. */
  alreadyRegistered: CanonicalAsset[];
  /**
   * VERIFIED crypto rows on this chain whose symbol is a curated candidate
   * but whose address is no longer an accepted candidate — typically an
   * impostor that an earlier, symbol-only run of this importer let in.
   * Never touched by `applyLiFiImportPlan()`; the script only deprecates
   * them when explicitly asked to.
   */
  staleVerified: CanonicalAsset[];
  /**
   * DEPRECATED rows that now pass every check again — e.g. a real token an
   * earlier, stricter name list rejected. The script sets them back to
   * VERIFIED on --apply and prints each one.
   */
  toReverify: CanonicalAsset[];
  /** Already-registered candidates whose LI.FI `logoURI` is new or changed. */
  logoUpdates: LogoUpdate[];
}

/** Pure diff between freshly-fetched LI.FI candidates and the current registry state — no I/O. Identity is `(chain, address)`, same convention every other importer in this file's directory already uses. */
export function planLiFiImportForChain(
  candidates: RegisterAssetInput[],
  existingAssets: CanonicalAsset[],
  curatedSymbols: string[] = LOCAL_COIN_CANDIDATES.map((c) => c.symbol)
): LiFiImportPlan {
  const existingByKey = new Map(existingAssets.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a]));
  const candidateKeys = new Set(candidates.map((c) => assetIdentityKey({ chain: c.chain, address: c.address })));
  const curated = new Set(curatedSymbols.map((s) => s.toUpperCase()));

  const toRegister = candidates.filter((c) => !existingByKey.has(assetIdentityKey({ chain: c.chain, address: c.address })));
  const alreadyRegistered = candidates
    .map((c) => existingByKey.get(assetIdentityKey({ chain: c.chain, address: c.address })))
    .filter((a): a is CanonicalAsset => Boolean(a));
  const staleVerified = existingAssets.filter(
    (a) =>
      a.status === 'VERIFIED' &&
      a.assetType === 'crypto' &&
      curated.has(a.symbol.toUpperCase()) &&
      !candidateKeys.has(assetIdentityKey({ chain: a.chain, address: a.address }))
  );

  const logoUpdates = planLogoUpdates(
    alreadyRegistered,
    new Map(candidates.map((c) => [assetIdentityKey({ chain: c.chain, address: c.address }), c.logoUrl])),
    (a) => assetIdentityKey({ chain: a.chain, address: a.address })
  );

  const toReverify = alreadyRegistered.filter((a) => a.status === 'DEPRECATED');

  return { toRegister, alreadyRegistered, staleVerified, toReverify, logoUpdates };
}

export interface ApplyLiFiImportResult {
  registered: CanonicalAsset[];
  failed: { input: RegisterAssetInput; error: string }[];
}

/** Writes `plan.toRegister` via `registerAsset()` — same admin/service-role-only trust boundary as `applyCoinImportPlan()`/`applyRobinhoodImportPlan()`. Continues past individual failures; every outcome is reported back. */
export async function applyLiFiImportPlan(
  registerAssetFn: (input: RegisterAssetInput) => Promise<RegisterAssetResult>,
  plan: LiFiImportPlan
): Promise<ApplyLiFiImportResult> {
  const registered: CanonicalAsset[] = [];
  const failed: { input: RegisterAssetInput; error: string }[] = [];

  for (const input of plan.toRegister) {
    const result = await registerAssetFn(input);
    if (result.ok) {
      registered.push(result.asset);
    } else {
      failed.push({ input, error: result.message });
    }
  }

  return { registered, failed };
}
