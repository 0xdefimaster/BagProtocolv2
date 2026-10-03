import crypto from 'crypto';
import { getAddress } from 'viem';
import { supabaseAdmin } from '@/lib/supabase/server';

// -----------------------------------------------------------------------------
// Sign-In-With-Ethereum (EIP-4361) nonce. Flow:
//   1. Client asks for a nonce for its wallet address.
//   2. Server generates one, builds the exact EIP-4361 message the wallet will
//      sign (bound to this site's domain/URI, a chain id and an expiry), and
//      stores {nonce, wallet, message, expires_at}.
//   3. Client signs `message` with personal_sign and posts the signature
//      back along with the nonce it received.
//   4. Server consumes the row for exactly (wallet, nonce) — one-time use —
//      and verifies the signature against the *stored* message.
//
// Several nonces may be outstanding for one wallet at once (0040): issuing a
// new one no longer replaces a pending one, and consuming requires BOTH the
// wallet and the nonce to match. Previously a single row per wallet meant
// anyone could request (or "verify" with a junk nonce) for someone else's
// address and wipe that person's pending sign-in, and two overlapping
// sign-ins of the same user invalidated each other.
// -----------------------------------------------------------------------------

export const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete the wallet prompt
/** Robinhood Chain — the chain the protocol settles on; informational in the message (sign-in itself is chain-agnostic). */
export const SIGN_IN_CHAIN_ID = 4663;

function normalize(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

export interface SignMessageParams {
  /** RFC 3986 authority of the site asking for the signature, e.g. `bagprotocol.com` — wallets compare it to the page's origin. */
  domain: string;
  /** Full origin, e.g. `https://bagprotocol.com`. */
  uri: string;
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  chainId?: number;
}

/** EIP-4361 message. The address is EIP-55 checksummed, as the spec requires. */
export function buildSignMessage(p: SignMessageParams): string {
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    getAddress(p.walletAddress),
    '',
    'Sign in to Bag Protocol. This request will not trigger a blockchain transaction or cost any gas.',
    '',
    `URI: ${p.uri}`,
    'Version: 1',
    `Chain ID: ${p.chainId ?? SIGN_IN_CHAIN_ID}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expirationTime}`,
  ].join('\n');
}

export async function issueNonce(
  walletAddress: string,
  site: { domain: string; uri: string }
): Promise<{ nonce: string; message: string }> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + NONCE_TTL_MS).toISOString();
  const message = buildSignMessage({
    domain: site.domain,
    uri: site.uri,
    walletAddress,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expirationTime: expiresAt,
  });

  const { error } = await supabaseAdmin()
    .from('auth_nonces')
    .insert({ nonce, wallet_address: normalize(walletAddress), message, expires_at: expiresAt });

  if (error) throw new Error(error.message);
  return { nonce, message };
}

/**
 * Returns the exact signed message on success, or null if no unexpired row
 * exists for exactly this (wallet, nonce). Always one-time use: the atomic
 * `consume_auth_nonce()` delete only ever removes the matching row, so a
 * wrong guess can no longer destroy someone else's pending sign-in.
 */
export async function consumeNonce(walletAddress: string, nonce: string): Promise<string | null> {
  const admin = supabaseAdmin();

  const { data, error } = await admin.rpc('consume_auth_nonce', {
    p_wallet_address: normalize(walletAddress),
    p_nonce: nonce,
  });
  // A database error (e.g. migration 0040 not applied) is not "expired" —
  // surface it so the real cause is visible instead of an endless retry loop.
  if (error) throw new Error(`Sign-in storage error: ${error.message}`);

  // supabase-js returns a `returns table(...)` RPC as an array of rows.
  const row = (Array.isArray(data) ? data[0] : data) as { nonce: string; message: string; expires_at: string } | undefined;
  if (!row) return null;

  if (row.nonce !== nonce) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  return row.message;
}

/**
 * Domain/URI for the SIWE message. `APP_ORIGIN` (e.g. https://bagprotocol.xyz)
 * is authoritative when set, so the message never names a host taken from a
 * client-supplied header. Without it (local dev), the request's own host is
 * used.
 */
export function siteFromRequest(req: Request): { domain: string; uri: string } {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) {
    const origin = new URL(configured);
    return { domain: origin.host, uri: origin.origin };
  }
  const url = new URL(req.url);
  const forwardedHost = req.headers.get('x-forwarded-host');
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const host = (forwardedHost ?? url.host).split(',')[0].trim();
  const proto = (forwardedProto ?? url.protocol.replace(':', '')).split(',')[0].trim();
  return { domain: host, uri: `${proto}://${host}` };
}
