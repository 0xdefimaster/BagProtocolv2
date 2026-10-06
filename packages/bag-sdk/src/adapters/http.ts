import { parseBag, type ParseResult } from '../parse';

// -----------------------------------------------------------------------------
// Transport adapter: bag.json over HTTP(S). Not part of the strategy core
// (parse → validate → normalize → hash → verify), which never fetches: a
// bag.json may come from a file, HTTPS, IPFS, wallet storage or a registry
// `uri`, and every source ends in the same `parseBag(text)`.
// The SDK owns no endpoint: the caller passes the URL and, optionally, `fetch`.
// -----------------------------------------------------------------------------

/** A bag.json is a few KB; anything far larger is refused before parsing. */
export const MAX_BAG_JSON_BYTES = 1_000_000;

/** Fetches a bag.json and parses it strictly from the text. The result is parsed, never trusted: validate and hash it. */
export async function fetchBag(url: string, options: { fetch?: typeof fetch } = {}): Promise<ParseResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`fetchBag: ${url} answered ${res.status}.`);
  const text = await res.text();
  if (text.length > MAX_BAG_JSON_BYTES) throw new Error(`fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
  return parseBag(text);
}
