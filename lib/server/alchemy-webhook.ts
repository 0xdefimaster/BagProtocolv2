import { createHmac, timingSafeEqual } from 'crypto';

// Alchemy webhook authenticity: `X-Alchemy-Signature` is the hex HMAC-SHA256
// of the RAW request body, keyed with the webhook's own signing key.

export function verifyAlchemySignature(rawBody: string, signature: string | null, signingKey: string): boolean {
  if (!signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Every wallet address mentioned as sender or receiver in an ADDRESS_ACTIVITY payload, lowercased. Amounts are ignored on purpose. */
export function addressesInActivity(payload: unknown): string[] {
  const activity = (payload as { event?: { activity?: unknown } } | null)?.event?.activity;
  if (!Array.isArray(activity)) return [];
  const out = new Set<string>();
  for (const a of activity) {
    for (const key of ['fromAddress', 'toAddress'] as const) {
      const v = (a as Record<string, unknown> | null)?.[key];
      if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase());
    }
  }
  return [...out];
}
