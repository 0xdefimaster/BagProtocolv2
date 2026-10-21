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

async function readBoundedText(res: Response): Promise<string> {
  const declaredLength = res.headers.get('content-length');
  if (declaredLength && /^\\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BAG_JSON_BYTES) {
    throw new Error(`fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
  }

  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BAG_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('fetchBag:')) throw error;
    throw new Error('fetchBag: could not read a valid UTF-8 response body.');
  } finally {
    reader.releaseLock();
  }
}

/** Fetches a bag.json and parses it strictly from the text. The result is parsed, never trusted: validate and hash it. */
export async function fetchBag(url: string, options: { fetch?: typeof fetch } = {}): Promise<ParseResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
  } catch {
    // Do not echo the caller URL: it can contain a signed query string or credentials.
    throw new Error('fetchBag: request failed.');
  }
  if (!res.ok) throw new Error(`fetchBag: response answered ${res.status}.`);
  return parseBag(await readBoundedText(res));
}
