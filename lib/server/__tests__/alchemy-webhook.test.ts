import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { addressesInActivity, verifyAlchemySignature } from '../alchemy-webhook';

const KEY = 'whsec_test_key';
const sign = (body: string, key = KEY) => createHmac('sha256', key).update(body, 'utf8').digest('hex');
const A = '0x49Da000000000000000000000000000000000001';
const B = '0x49da000000000000000000000000000000000002';

describe('verifyAlchemySignature', () => {
  const body = JSON.stringify({ event: { activity: [] } });
  it('accepts the HMAC-SHA256 of the raw body with the webhook key', () => {
    expect(verifyAlchemySignature(body, sign(body), KEY)).toBe(true);
    expect(verifyAlchemySignature(body, sign(body).toUpperCase(), KEY)).toBe(true);
  });
  it('rejects another key, a changed body, a missing or malformed signature', () => {
    expect(verifyAlchemySignature(body, sign(body, 'other'), KEY)).toBe(false);
    expect(verifyAlchemySignature(body + ' ', sign(body), KEY)).toBe(false);
    expect(verifyAlchemySignature(body, null, KEY)).toBe(false);
    expect(verifyAlchemySignature(body, 'sha256=' + sign(body), KEY)).toBe(false);
  });
});

describe('addressesInActivity', () => {
  it('collects senders and receivers, lowercased and de-duplicated; ignores everything else', () => {
    const payload = { event: { activity: [{ fromAddress: A, toAddress: B, value: 999 }, { fromAddress: B, toAddress: 'nope' }, null] } };
    expect(addressesInActivity(payload).sort()).toEqual([A.toLowerCase(), B].sort());
  });
  it('anything that is not an activity list yields nothing', () => {
    expect(addressesInActivity(null)).toEqual([]);
    expect(addressesInActivity({ event: {} })).toEqual([]);
  });
});
