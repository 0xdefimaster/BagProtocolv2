import { SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Thin wrapper around the `check_rate_limit()` Postgres function (migration
// 0027_add_rate_limiting.sql). See that migration's own doc for why this is
// Postgres-backed rather than in-memory, and why a fixed window rather than
// a sliding one.
//
// FAIL OPEN, deliberately, on any error talking to the rate-limit table
// itself (network hiccup, RPC error): this is an abuse/availability
// safeguard, not this app's actual security boundary — every route this is
// applied to already has its own independent, real enforcement (session
// auth, ownership checks, on-chain verification, EIP-712 attestation). If
// the rate-limit check itself is unavailable, blocking all legitimate
// traffic behind it would turn a minor infra hiccup in a best-effort
// subsystem into a full outage of the actual feature — worse than
// temporarily allowing a burst through. This mirrors the DEFAULT policy
// this codebase already applies to its OTHER non-critical-path checks: fail
// closed for anything that moves money or asserts an on-chain fact, fail
// open for a request-shaping safeguard that isn't either.
// -----------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Width of the fixed window, in seconds. */
  windowSeconds: number;
  /** Max requests allowed per bucket per window. */
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window rolls over — only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

const ALLOW_ON_ERROR: RateLimitResult = { allowed: true, retryAfterSeconds: 0 };

/**
 * Checks and increments the counter for `bucketKey` in one atomic
 * Postgres call. Callers should build `bucketKey` from a route-specific
 * prefix plus the identity being throttled — e.g. `` `purchase-intent:${userId}` ``
 * or `` `nonce:ip:${ip}` `` — so different routes/identities never share a
 * bucket by accident.
 */
export async function checkRateLimit(admin: SupabaseClient, bucketKey: string, config: RateLimitConfig): Promise<RateLimitResult> {
  try {
    const { data, error } = await admin.rpc('check_rate_limit', {
      p_bucket_key: bucketKey,
      p_window_seconds: config.windowSeconds,
      p_max_requests: config.maxRequests,
    });
    if (error) {
      console.error(`checkRateLimit(${bucketKey}): RPC error, failing open:`, error.message);
      return ALLOW_ON_ERROR;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; retry_after_seconds: number } | undefined;
    if (!row) {
      console.error(`checkRateLimit(${bucketKey}): RPC returned no row, failing open.`);
      return ALLOW_ON_ERROR;
    }
    return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds };
  } catch (err) {
    console.error(`checkRateLimit(${bucketKey}): threw, failing open:`, err instanceof Error ? err.message : err);
    return ALLOW_ON_ERROR;
  }
}

/**
 * Best-effort client IP for building a per-IP bucket key. A throttle, not an
 * auth decision. Prefers headers the hosting edge sets itself and a client
 * cannot supply: Netlify's `x-nf-client-connection-ip`, then `x-real-ip`.
 * The first `x-forwarded-for` entry is a last resort — on hosts that APPEND
 * to a client-sent header it is attacker-chosen.
 */
export function getClientIp(req: Request): string {
  const netlify = req.headers.get('x-nf-client-connection-ip');
  if (netlify) return netlify.trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

/** A standard 429 response body/status for a rate-limited route. */
export function rateLimitedResponseBody(retryAfterSeconds: number) {
  return { error: 'Too many requests. Please try again shortly.', retryAfterSeconds };
}
