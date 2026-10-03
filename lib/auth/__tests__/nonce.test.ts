import { describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: () => ({ rpc: rpcMock }),
}));

const { consumeNonce, buildSignMessage, siteFromRequest } = await import('../nonce');

// -----------------------------------------------------------------------------
// Production-hardening P0-7 — fast, mocked-RPC unit tests for
// `consumeNonce()`'s own validation logic (nonce match, expiry, error
// handling). The genuine ATOMICITY property (two concurrent callers, only
// one gets the row) cannot be proven with a mock — see
// lib/server/__tests__/integration/nonce-consume.integration.test.ts for
// that, against a real Postgres.
// -----------------------------------------------------------------------------

describe('consumeNonce', () => {
  it('resolves the exact signed message when the RPC returns a matching, unexpired row', async () => {
    const wallet = '0xAAAA000000000000000000000000000000aaaa';
    const message = 'signed message';
    rpcMock.mockResolvedValue({
      data: [{ nonce: 'nonce-1', message, expires_at: new Date(Date.now() + 60_000).toISOString() }],
      error: null,
    });

    const result = await consumeNonce(wallet, 'nonce-1');

    expect(result).toBe(message);
    expect(rpcMock).toHaveBeenCalledWith('consume_auth_nonce', { p_wallet_address: wallet.toLowerCase(), p_nonce: 'nonce-1' });
  });

  it('returns null when the supplied nonce does not match the row the RPC returned', async () => {
    rpcMock.mockResolvedValue({
      data: [{ nonce: 'real-nonce', message: 'msg', expires_at: new Date(Date.now() + 60_000).toISOString() }],
      error: null,
    });

    const result = await consumeNonce('0xAAAA000000000000000000000000000000aaaa', 'wrong-guess');

    expect(result).toBeNull();
  });

  it('returns null when the row the RPC returned has already expired', async () => {
    rpcMock.mockResolvedValue({
      data: [{ nonce: 'nonce-1', message: 'msg', expires_at: new Date(Date.now() - 1000).toISOString() }],
      error: null,
    });

    const result = await consumeNonce('0xAAAA000000000000000000000000000000aaaa', 'nonce-1');

    expect(result).toBeNull();
  });

  it('returns null (never throws) when the RPC finds no row at all — nothing pending, or already consumed', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });

    const result = await consumeNonce('0xAAAA000000000000000000000000000000aaaa', 'nonce-1');

    expect(result).toBeNull();
  });

  it('fails closed with a visible reason on an RPC error — never reports a database fault as an expired nonce', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'function consume_auth_nonce does not exist' } });

    await expect(consumeNonce('0xAAAA000000000000000000000000000000aaaa', 'nonce-1')).rejects.toThrow(
      /Sign-in storage error: function consume_auth_nonce does not exist/
    );
  });

  it('normalizes the wallet address to lowercase before calling the RPC', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });

    await consumeNonce('0xABCDEF0000000000000000000000000000ABCD', 'nonce-1');

    expect(rpcMock).toHaveBeenCalledWith('consume_auth_nonce', {
      p_wallet_address: '0xabcdef0000000000000000000000000000abcd',
      p_nonce: 'nonce-1',
    });
  });
});

describe('buildSignMessage (EIP-4361)', () => {
  it('binds the domain, checksummed address, URI, chain, nonce and expiry', () => {
    const message = buildSignMessage({
      domain: 'bagprotocol.com',
      uri: 'https://bagprotocol.com',
      walletAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      nonce: 'abc123def456',
      issuedAt: '2026-09-28T12:00:00.000Z',
      expirationTime: '2026-09-28T12:05:00.000Z',
    });
    expect(message.split('\n')).toEqual([
      'bagprotocol.com wants you to sign in with your Ethereum account:',
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      '',
      'Sign in to Bag Protocol. This request will not trigger a blockchain transaction or cost any gas.',
      '',
      'URI: https://bagprotocol.com',
      'Version: 1',
      'Chain ID: 4663',
      'Nonce: abc123def456',
      'Issued At: 2026-09-28T12:00:00.000Z',
      'Expiration Time: 2026-09-28T12:05:00.000Z',
    ]);
  });
});

describe('siteFromRequest', () => {
  const spoofed = () =>
    new Request('https://bag.example/api/auth/nonce', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } });

  it('uses APP_ORIGIN when set, ignoring forwarded headers', () => {
    vi.stubEnv('APP_ORIGIN', 'https://bagprotocol.xyz');
    try {
      expect(siteFromRequest(spoofed())).toEqual({ domain: 'bagprotocol.xyz', uri: 'https://bagprotocol.xyz' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to the request host when APP_ORIGIN is unset (local dev)', () => {
    vi.stubEnv('APP_ORIGIN', '');
    try {
      expect(siteFromRequest(new Request('http://localhost:3000/api/auth/nonce')).domain).toBe('localhost:3000');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
