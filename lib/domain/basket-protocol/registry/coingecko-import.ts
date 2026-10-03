import { CanonicalAsset, ChainId } from '@/types/basket-protocol';
import { assetIdentityKey } from '../asset-identity';
import { CHAIN_TO_PLATFORM } from '../pricing/coingecko-provider';
import { RegisterAssetInput, RegisterAssetResult } from '@/lib/server/asset-repo';

// -----------------------------------------------------------------------------
// Imports cryptocurrencies into the BAG Asset Registry (lib/server/asset-repo.ts),
// same role for `cryptoAssets` (lib/create-assets-data.ts) that
// robinhood-import.ts plays for Robinhood Stock Tokens. Same plan/apply split,
// same "never hardcode a contract address" rule — the two things this module
// hardcodes are the LOCAL_COIN_CANDIDATES symbol/name list (that's just
// "which of our static demo coins to look up", not a financial value) and
// CHAIN_TO_PLATFORM's chain->CoinGecko-platform-id strings (also just a
// lookup key, re-exported from coingecko-provider.ts so there's one place
// that mapping lives, not two that could drift). Every contract address and
// decimals value is fetched live from CoinGecko for every run — never
// memorized, never copy-pasted from a block explorer once and left to rot.
//
// Why this module exists: `/api/bags` (app/api/bags/route.ts's
// `buildAssetAddressLookup`) only resolves a composition symbol to a real
// chain/address if it's VERIFIED in this registry — otherwise it falls back
// to the literal string '__PENDING__', which `validateBasketRecipe`
// correctly rejects (INVALID_ADDRESS, severity ERROR). Until this module
// runs, every coin in `cryptoAssets` fails bag creation exactly that way,
// on any chain.
//
//        LOCAL_COIN_CANDIDATES (symbol + name only, no addresses)
//                       |
//                       v
//        GET /search?query=<name>            <- resolve name/symbol -> CoinGecko coin id
//                       |
//                       v
//        GET /coins/{id}?market_data=false... <- detail_platforms[platform].contract_address/decimal_place
//                       |
//                       v
//              planCoinImportForChain()   <-- pure, no I/O, no writes
//                       |
//                       v
//              CoinImportPlan { toRegister, alreadyRegistered, skipped }
//                       |
//                       v (only if the caller decides to)
//              applyCoinImportPlan(admin, plan)
//
// A coin with no deployment on the requested chain (BTC/SOL/DOGE on
// ethereum/base/arbitrum — these are native assets elsewhere, not ERC-20s
// here) is correctly SKIPPED, never fabricated as some "wrapped" stand-in —
// WBTC/WETH are different assets with their own addresses, and this module
// never assumes an equivalence the person didn't ask for.
// -----------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.coingecko.com/api/v3';
const PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3';
const FETCH_TIMEOUT_MS = 10_000;
/** Free/demo CoinGecko tier is rate-limited (~10-30 req/min); this is a per-request delay, not a retry budget, so a 20+ coin run without an API key doesn't get itself 429'd. Skipped entirely when `apiKey` is set. */
const NO_KEY_THROTTLE_MS = 1_500;

/**
 * The static demo coins this importer knows how to look up (from
 * `cryptoAssets`, lib/create-assets-data.ts) — symbol + name ONLY, no
 * addresses. This list exists so the importer has something to search
 * CoinGecko for; it is not itself a source of truth for any contract
 * address, decimals, or even which CoinGecko id is correct — all of that
 * is resolved live, every run, from CoinGecko's own `/search` + `/coins/{id}`
 * responses.
 */
export const LOCAL_COIN_CANDIDATES: { symbol: string; name: string }[] = [
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'ETH', name: 'Ethereum' },
  { symbol: 'SOL', name: 'Solana' },
  { symbol: 'DOGE', name: 'Dogecoin' },
  { symbol: 'SHIB', name: 'Shiba Inu' },
  { symbol: 'ARB', name: 'Arbitrum' },
  { symbol: 'OP', name: 'Optimism' },
  { symbol: 'MATIC', name: 'Polygon' },
  { symbol: 'STG', name: 'Stargate' },
  { symbol: 'UNI', name: 'Uniswap' },
  { symbol: 'AAVE', name: 'Aave' },
  { symbol: 'CRV', name: 'Curve' },
  { symbol: 'MKR', name: 'Maker' },
  { symbol: 'LDO', name: 'Lido' },
  { symbol: 'FET', name: 'Fetch.ai' },
  { symbol: 'AGIX', name: 'SingularityNET' },
  { symbol: 'ONDO', name: 'Ondo Finance' },
  { symbol: 'GHO', name: 'Aave GHO' },
  { symbol: 'STRK', name: 'StarkNet' },
  { symbol: 'PEPE', name: 'Pepe' },
  { symbol: 'BONK', name: 'Bonk' },
  { symbol: 'WIF', name: 'dogwifhat' },
  // Majors every Bag creator expects to find: stablecoins, wrapped/staked
  // ETH and BTC, blue-chip DeFi, and the largest ecosystem tokens.
  { symbol: 'USDC', name: 'USD Coin' },
  { symbol: 'USDT', name: 'Tether USD' },
  { symbol: 'DAI', name: 'Dai Stablecoin' },
  { symbol: 'USDS', name: 'USDS Stablecoin' },
  { symbol: 'USDE', name: 'Ethena USDe' },
  { symbol: 'PYUSD', name: 'PayPal USD' },
  { symbol: 'WETH', name: 'Wrapped Ether' },
  { symbol: 'STETH', name: 'Liquid staked Ether 2.0' },
  { symbol: 'WSTETH', name: 'Wrapped liquid staked Ether 2.0' },
  { symbol: 'RETH', name: 'Rocket Pool ETH' },
  { symbol: 'CBETH', name: 'Coinbase Wrapped Staked ETH' },
  { symbol: 'WEETH', name: 'Wrapped eETH' },
  { symbol: 'WBTC', name: 'Wrapped BTC' },
  { symbol: 'CBBTC', name: 'Coinbase Wrapped BTC' },
  { symbol: 'LINK', name: 'Chainlink' },
  { symbol: 'POL', name: 'Polygon Ecosystem Token' },
  { symbol: 'COMP', name: 'Compound' },
  { symbol: 'SNX', name: 'Synthetix Network Token' },
  { symbol: 'SUSHI', name: 'Sushi' },
  { symbol: '1INCH', name: '1inch' },
  { symbol: 'BAL', name: 'Balancer' },
  { symbol: 'YFI', name: 'yearn.finance' },
  { symbol: 'GRT', name: 'The Graph' },
  { symbol: 'ENS', name: 'Ethereum Name Service' },
  { symbol: 'APE', name: 'ApeCoin' },
  { symbol: 'SAND', name: 'The Sandbox' },
  { symbol: 'MANA', name: 'Decentraland' },
  { symbol: 'RENDER', name: 'Render' },
  { symbol: 'IMX', name: 'Immutable X' },
  { symbol: 'PENDLE', name: 'Pendle' },
  { symbol: 'EIGEN', name: 'Eigen' },
  { symbol: 'ENA', name: 'Ethena' },
  { symbol: 'SKY', name: 'Sky' },
  { symbol: 'MORPHO', name: 'Morpho' },
  { symbol: 'WLD', name: 'Worldcoin' },
  { symbol: 'FLOKI', name: 'Floki' },
  { symbol: 'BLUR', name: 'Blur' },
  { symbol: 'GMX', name: 'GMX' },
  { symbol: 'AERO', name: 'Aerodrome Finance' },
  { symbol: 'DEGEN', name: 'Degen' },
  { symbol: 'BRETT', name: 'Brett' },
  { symbol: 'VIRTUAL', name: 'Virtual Protocol' },
  { symbol: 'USDG', name: 'Global Dollar' },
  // 'AGI' ("Artificial Intelligence" in create-assets-data.ts) deliberately
  // excluded — too ambiguous a name/symbol to resolve safely by search
  // (multiple unrelated tokens share it); review and add explicitly once a
  // specific CoinGecko id is confirmed, rather than guessing here.
];

export type CoinTargetChain = Extract<ChainId, 'ethereum' | 'base' | 'arbitrum'>;

export type SkippedCoinReason =
  | 'NOT_FOUND_ON_COINGECKO'
  | 'NO_DEPLOYMENT_ON_CHAIN'
  | 'MISSING_DECIMALS'
  | 'FETCH_ERROR';

export interface SkippedCoin {
  symbol: string;
  reason: SkippedCoinReason;
  detail?: string;
}

export class CoinGeckoFetchError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CoinGeckoFetchError';
  }
}

export interface CoinGeckoImportOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable so tests never actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface SearchCoin {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
}

interface CoinDetailPlatform {
  decimal_place: number | null;
  contract_address: string;
}

interface CoinDetail {
  id: string;
  symbol: string;
  name: string;
  detail_platforms?: Record<string, CoinDetailPlatform>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, options: CoinGeckoImportOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const headers: Record<string, string> = {};
  if (options.apiKey) headers['x-cg-demo-api-key'] = options.apiKey;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers, cache: 'no-store' });
  } catch (err) {
    throw new CoinGeckoFetchError(`Failed to reach ${url}`, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new CoinGeckoFetchError(`${url} responded ${res.status} ${res.statusText}`);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new CoinGeckoFetchError('Response was not valid JSON', err);
  }
}

/**
 * Resolves one local {symbol, name} to a CoinGecko coin id via `/search`,
 * requiring an exact (case-insensitive) symbol match among the results —
 * `/search` ranks by relevance to the query text, not by symbol match, so
 * this re-filters rather than trusting result order alone. When more than
 * one result shares the symbol (common — many tokens reuse tickers), picks
 * the lowest (best) `market_cap_rank`, since a name-search match plus
 * "highest market cap" is the same heuristic a person doing this by hand
 * would use, not a guess this module invented silently.
 */
async function resolveCoinGeckoId(
  candidate: { symbol: string; name: string },
  baseUrl: string,
  options: CoinGeckoImportOptions
): Promise<string | null> {
  const url = `${baseUrl}/search?query=${encodeURIComponent(candidate.name)}`;
  const data = (await fetchJson(url, options)) as { coins?: SearchCoin[] };
  const coins = Array.isArray(data.coins) ? data.coins : [];

  const symbolMatches = coins.filter((c) => c.symbol?.toUpperCase() === candidate.symbol.toUpperCase());
  if (symbolMatches.length === 0) return null;

  symbolMatches.sort((a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity));
  return symbolMatches[0].id;
}

/** Fetches one coin's `detail_platforms` map — the only field this module needs, but `/coins/{id}` doesn't support selecting a subset of fields, so the other flags just turn off the heaviest unused sections (market/community/developer data, tickers, localization). */
async function fetchCoinDetail(id: string, baseUrl: string, options: CoinGeckoImportOptions): Promise<CoinDetail> {
  const url =
    `${baseUrl}/coins/${encodeURIComponent(id)}` +
    '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false';
  return (await fetchJson(url, options)) as CoinDetail;
}

export interface CoinCandidateResult {
  candidates: RegisterAssetInput[];
  skipped: SkippedCoin[];
}

/**
 * Live-resolves `LOCAL_COIN_CANDIDATES` (or a caller-supplied subset) to
 * `RegisterAssetInput`s for one target chain. Sequential, not
 * `Promise.all` — deliberately, to respect CoinGecko's rate limit (see
 * `NO_KEY_THROTTLE_MS`) rather than firing 20+ concurrent requests at a
 * free-tier key.
 */
export async function fetchCoinCandidatesForChain(
  targetChain: CoinTargetChain,
  options: CoinGeckoImportOptions = {},
  localCoins: { symbol: string; name: string }[] = LOCAL_COIN_CANDIDATES
): Promise<CoinCandidateResult> {
  const platform = CHAIN_TO_PLATFORM[targetChain];
  if (!platform) {
    throw new Error(`No CoinGecko platform mapping for chain "${targetChain}" (see CHAIN_TO_PLATFORM).`);
  }

  const baseUrl = options.baseUrl ?? (options.apiKey ? PRO_BASE_URL : DEFAULT_BASE_URL);
  const throttleMs = options.apiKey ? 0 : NO_KEY_THROTTLE_MS;
  const sleepImpl = options.sleepImpl ?? sleep;

  const candidates: RegisterAssetInput[] = [];
  const skipped: SkippedCoin[] = [];

  for (const local of localCoins) {
    try {
      const id = await resolveCoinGeckoId(local, baseUrl, options);
      if (!id) {
        skipped.push({ symbol: local.symbol, reason: 'NOT_FOUND_ON_COINGECKO' });
        continue;
      }
      if (throttleMs > 0) await sleepImpl(throttleMs);

      const detail = await fetchCoinDetail(id, baseUrl, options);
      if (throttleMs > 0) await sleepImpl(throttleMs);

      const onChain = detail.detail_platforms?.[platform];
      if (!onChain || !onChain.contract_address) {
        skipped.push({ symbol: local.symbol, reason: 'NO_DEPLOYMENT_ON_CHAIN' });
        continue;
      }
      if (typeof onChain.decimal_place !== 'number') {
        skipped.push({ symbol: local.symbol, reason: 'MISSING_DECIMALS' });
        continue;
      }

      candidates.push({
        chain: targetChain,
        address: onChain.contract_address,
        symbol: local.symbol,
        decimals: onChain.decimal_place,
        name: detail.name || local.name,
        assetType: 'crypto',
      });
    } catch (err) {
      skipped.push({
        symbol: local.symbol,
        reason: 'FETCH_ERROR',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { candidates, skipped };
}

export interface CoinImportPlan {
  /** Not yet in the registry at this (chain, address) — safe to `registerAsset()`. */
  toRegister: RegisterAssetInput[];
  /** Already registered — no action needed. */
  alreadyRegistered: CanonicalAsset[];
  /** Remote lookups that couldn't be mapped, and why. */
  skipped: SkippedCoin[];
}

/** Pure diff between freshly-fetched candidates and the current registry state — no I/O. Identity is `(chain, address)`, same as robinhood-import.ts's `planRobinhoodImportForChain`. */
export function planCoinImportForChain(
  candidateResult: CoinCandidateResult,
  existingAssets: CanonicalAsset[]
): CoinImportPlan {
  const { candidates, skipped } = candidateResult;

  const existingByKey = new Map(
    existingAssets.map((a) => [assetIdentityKey({ chain: a.chain, address: a.address }), a])
  );

  const toRegister = candidates.filter(
    (c) => !existingByKey.has(assetIdentityKey({ chain: c.chain, address: c.address }))
  );
  const alreadyRegistered = candidates
    .map((c) => existingByKey.get(assetIdentityKey({ chain: c.chain, address: c.address })))
    .filter((a): a is CanonicalAsset => Boolean(a));

  return { toRegister, alreadyRegistered, skipped };
}

export interface ApplyCoinImportResult {
  registered: CanonicalAsset[];
  failed: { input: RegisterAssetInput; error: string }[];
}

/** Writes `plan.toRegister` via `registerAsset()` — same admin/service-role-only trust boundary as `applyRobinhoodImportPlan()`. Continues past individual failures; every outcome is reported back. */
export async function applyCoinImportPlan(
  registerAssetFn: (input: RegisterAssetInput) => Promise<RegisterAssetResult>,
  plan: CoinImportPlan
): Promise<ApplyCoinImportResult> {
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
