import { describe, expect, it } from 'vitest';
import { BagFetchError, fetchBag, MAX_BAG_JSON_BYTES } from '../src/adapters/http';
import { externalBagText } from './helpers';

const mockFetch = (response: Response): typeof fetch => (async () => response) as unknown as typeof fetch;

describe('fetchBag HTTP boundary', () => {
  it('strictly parses a successful response from its original UTF-8 bytes', async () => {
    const result = await fetchBag('https://assets.example/strategies/demo.bag.json', {
      fetch: mockFetch(new Response(externalBagText(), { status: 200 })),
    });

    expect(result.ok).toBe(true);
  });

  it('enforces the limit on actual UTF-8 bytes while reading, not JavaScript string length', async () => {
    // A multibyte body has fewer UTF-16 code units than UTF-8 bytes.
    const body = JSON.stringify({ description: 'é'.repeat(600_000) });
    expect(body.length).toBeLessThan(MAX_BAG_JSON_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_BAG_JSON_BYTES);

    await expect(
      fetchBag('https://assets.example/large.bag.json', { fetch: mockFetch(new Response(body, { status: 200 })) }),
    ).rejects.toMatchObject<Partial<BagFetchError>>({ name: 'BagFetchError', code: 'BODY_TOO_LARGE' });
  });

  it('refuses an oversized Content-Length before parsing and does not read the URL into errors', async () => {
    const response = new Response(externalBagText(), {
      status: 200,
      headers: { 'content-length': String(MAX_BAG_JSON_BYTES + 1) },
    });
    const url = 'https://assets.example/private?apiKey=must-not-leak';

    let thrown: unknown;
    try {
      await fetchBag(url, { fetch: mockFetch(response) });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: 'BagFetchError', code: 'BODY_TOO_LARGE' });
    expect((thrown as Error).message).not.toContain('assets.example');
    expect((thrown as Error).message).not.toContain('must-not-leak');
  });

  it('returns a typed HTTP status error without echoing the requested URL or response body', async () => {
    const url = 'https://assets.example/private?apiKey=must-not-leak';
    const result = fetchBag(url, { fetch: mockFetch(new Response('provider secret body', { status: 403 })) });

    await expect(result).rejects.toMatchObject({ name: 'BagFetchError', code: 'HTTP_STATUS', status: 403 });
    await expect(result).rejects.not.toThrow(/assets\.example|must-not-leak|provider secret body/);
  });

  it('wraps network failures in a stable, secret-safe error', async () => {
    const failingFetch = (async () => {
      throw new Error('failed URL https://rpc.example/private?apiKey=must-not-leak');
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await fetchBag('https://assets.example/private?apiKey=also-secret', { fetch: failingFetch });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: 'BagFetchError', code: 'NETWORK_ERROR' });
    expect((thrown as Error).message).not.toContain('apiKey');
    expect((thrown as Error).message).not.toContain('rpc.example');
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('rejects malformed UTF-8 rather than silently replacing invalid bytes', async () => {
    const invalidUtf8 = new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 });

    await expect(fetchBag('https://assets.example/invalid.bag.json', { fetch: mockFetch(invalidUtf8) })).rejects.toMatchObject({
      name: 'BagFetchError',
      code: 'INVALID_UTF8',
    });
  });
});
