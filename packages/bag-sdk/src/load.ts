import type { BagChain } from './chains';
import type { BagDefinition } from './types';
import { parseBag, type ParseResult } from './parse';
import type { ContractReader } from './registry';
import type { TokenInfo } from './validate';

// -----------------------------------------------------------------------------
// I/O helpers. The SDK owns no endpoint, RPC or credential: the caller passes
// its own `fetch` and its own viem client.
// -----------------------------------------------------------------------------

/** A bag.json is a few KB; anything far larger is refused before parsing. */
export const MAX_BAG_JSON_BYTES = 1_000_000;

/**
 * Fetches a bag.json from a URL and parses it (strictly, from the text). Uses the standard Fetch API; pass
 * `fetch` to use your own (proxies, tests). The response is parsed, never trusted: validate and hash it.
 */
export async function fetchBag(url: string, options: { fetch?: typeof fetch } = {}): Promise<ParseResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`fetchBag: ${url} answered ${res.status}.`);
  const text = await res.text();
  if (text.length > MAX_BAG_JSON_BYTES) throw new Error(`fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
  return parseBag(text);
}

const ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

/**
 * Reads `decimals()` of every asset of a definition, for `validateBag(bag, { tokens })`. `clientFor` returns
 * a client for a chain (v1 definitions are single-chain, so this is usually one client).
 */
export async function readTokenDecimals(definition: BagDefinition, clientFor: (chain: BagChain) => ContractReader): Promise<TokenInfo[]> {
  return Promise.all(
    definition.assets.map(async (a) => ({
      chain: a.chain,
      address: a.address,
      decimals: Number(await clientFor(a.chain).readContract({ address: a.address as `0x${string}`, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })),
    }))
  );
}
