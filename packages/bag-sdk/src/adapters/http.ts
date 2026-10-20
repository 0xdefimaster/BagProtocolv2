import { parseBag, type ParseResult } from '../parse';

// -----------------------------------------------------------------------------
// Transport adapter: bag.json over HTTP(S). Not part of the strategy core
// (parse → validate → normalize → hash → verify), which never fetches: a
// bag.json may come from a file, HTTPS, IPFS, wallet storage or a registry
// uri, and every source ends in the same parseBag(text).
// The SDK owns no endpoint: the caller passes the URL and, optionally, fetch.
// -----------------------------------------------------------------------------

/** A bag.json is a few KB; anything larger than this UTF-8 byte limit is refused. */
export const MAX_BAG_JSON_BYTES = 1_000_000;

export type BagFetchErrorCode = 'NETWORK_ERROR' | 'HTTP_STATUS' | 'BODY_TOO_LARGE' | 'INVALID_UTF8';

/** A transport error with a stable code and no secret-bearing URL or response body in its message. */
export class BagFetchError extends Error {
  readonly code: BagFetchErrorCode;
  readonly status?: number;

  constructor(code: BagFetchErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BagFetchError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; the original failure is what the caller needs.
  }
}

/** Reads and decodes a response incrementally, enforcing the limit on actual bytes, not UTF-16 code units. */
async function readBoundedUtf8(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(MAX_BAG_JSON_BYTES)) {
    await cancelBody(response);
    throw new BagFetchError('BODY_TOO_LARGE', `fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_BAG_JSON_BYTES) {
        await reader.cancel();
        throw new BagFetchError('BODY_TOO_LARGE', `fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures and preserve the primary error.
    }
    if (error instanceof BagFetchError) throw error;
    throw new BagFetchError('NETWORK_ERROR', 'fetchBag: failed while reading the response body.', { cause: error });
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BagFetchError('INVALID_UTF8', 'fetchBag: response body is not valid UTF-8.', { cause: error });
  }
}

/**
 * Fetches a bag.json and parses it strictly from the original response bytes.
 * The result is parsed, never trusted: the caller must validate and hash it.
 */
export async function fetchBag(url: string, options: { fetch?: typeof fetch } = {}): Promise<ParseResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;

  try {
    response = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
  } catch (error) {
    throw new BagFetchError('NETWORK_ERROR', 'fetchBag: request failed.', { cause: error });
  }

  if (!response.ok) {
    await cancelBody(response);
    throw new BagFetchError('HTTP_STATUS', `fetchBag: server answered HTTP ${response.status}.`, { status: response.status });
  }

  const text = await readBoundedUtf8(response);
  return parseBag(text);
}
