import { parseBag, type ParseResult } from '../parse';
import { BagSdkError } from '../errors';

/** Limit UTF-8 bytes, including streamed responses without Content-Length. */
export const MAX_BAG_JSON_BYTES = 1_000_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface FetchBagOptions {
  fetch?: typeof fetch;
  /** Cancels both request and body reading; the caller's abort reason is never exposed. */
  signal?: AbortSignal;
  /** One deadline for request + body, not a new timer per chunk. Default 15000 ms. */
  timeoutMs?: number;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => undefined); } catch { /* Best-effort cleanup. */ }
}

async function readBoundedText(res: Response, setReader: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void): Promise<string> {
  const declaredLength = res.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BAG_JSON_BYTES) {
    cancelBody(res.body);
    throw new BagSdkError('HTTP_RESPONSE_TOO_LARGE', `fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  setReader(reader);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let text = '';
  const decode = (bytes?: Uint8Array, stream = false): string => {
    try { return decoder.decode(bytes, { stream }); }
    catch { throw new BagSdkError('HTTP_INVALID_UTF8', 'fetchBag: could not read a valid UTF-8 response body.'); }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BAG_JSON_BYTES) throw new BagSdkError('HTTP_RESPONSE_TOO_LARGE', `fetchBag: response is larger than ${MAX_BAG_JSON_BYTES} bytes.`);
      text += decode(value, true);
    }
    return text + decode();
  } catch (error) {
    // A custom stream's cancel hook may never finish: do not await it.
    try { void reader.cancel().catch(() => undefined); } catch { /* Best effort. */ }
    if (error instanceof BagSdkError) throw error;
    throw new BagSdkError('HTTP_BODY_READ_ERROR', 'fetchBag: could not read the response body.');
  } finally {
    setReader(null);
    reader.releaseLock();
  }
}

/** Retrieve and strictly parse untrusted bytes. Validation/hash verification remain separate steps. */
export async function fetchBag(url: string, options: FetchBagOptions = {}): Promise<ParseResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new BagSdkError('INVALID_ARGUMENT', 'fetchBag: timeoutMs must be a positive integer no greater than 2147483647.');
  }
  if (options.signal?.aborted) throw new BagSdkError('HTTP_ABORTED');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let abortCode: 'HTTP_TIMEOUT' | 'HTTP_ABORTED' | null = null;
  let rejectAbort!: (error: BagSdkError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (code: 'HTTP_TIMEOUT' | 'HTTP_ABORTED') => {
    if (abortCode !== null) return;
    abortCode = code;
    rejectAbort(new BagSdkError(code));
    controller.abort();
    try { void reader?.cancel().catch(() => undefined); } catch { /* Best effort. */ }
  };
  const onCallerAbort = () => abort('HTTP_ABORTED');
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => abort('HTTP_TIMEOUT'), timeoutMs);
  try {
    if (options.signal?.aborted) onCallerAbort();
    const operation = (async () => {
      if (abortCode !== null) throw new BagSdkError(abortCode);
      let res: Response;
      try {
        res = await (options.fetch ?? globalThis.fetch)(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal: controller.signal });
      } catch {
        throw new BagSdkError(abortCode ?? 'HTTP_NETWORK_ERROR', 'fetchBag: request failed.');
      }
      if (abortCode !== null) { cancelBody(res.body); throw new BagSdkError(abortCode); }
      if (!res.ok) {
        cancelBody(res.body);
        throw new BagSdkError('HTTP_STATUS_ERROR', `fetchBag: response answered ${res.status}.`);
      }
      try {
        const text = await readBoundedText(res, value => { reader = value; });
        if (abortCode !== null) throw new BagSdkError(abortCode);
        return parseBag(text);
      } catch (error) {
        if (error instanceof BagSdkError) throw error;
        throw new BagSdkError('HTTP_BODY_READ_ERROR', 'fetchBag: could not read the response body.');
      }
    })();
    // Bounds custom fetch implementations even when they ignore AbortSignal.
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}
