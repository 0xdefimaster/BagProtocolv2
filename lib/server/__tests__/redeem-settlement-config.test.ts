import { describe, expect, it, vi } from 'vitest';
import { attestorKeyFromEnv, SettlementMisconfiguredError } from '../redeem-settlement-attestation';
import { redactSecrets, settlementErrorResponse } from '../redeem-settlement-errors';

// The attestor key comes from a dashboard: tolerate how operators paste it, refuse anything else without echoing it,
// and never let a key-shaped string reach a log.

const HEX = 'ab'.repeat(32);

describe('attestorKeyFromEnv', () => {
  it.each([
    [`0x${HEX}`],
    [HEX],
    [`  0x${HEX}  `],
    [`"0x${HEX}"`],
    [`'${HEX}'\n`],
    [`0X${HEX.toUpperCase()}`],
  ])('accepts %j as the same key', (raw) => {
    expect(attestorKeyFromEnv(raw)).toBe(`0x${HEX}`);
  });

  it.each([['0x1234'], [`0x${HEX}00`], [`0x${'zz'.repeat(32)}`], ['']])('refuses %j without echoing it', (raw) => {
    let thrown: unknown;
    try {
      attestorKeyFromEnv(raw);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SettlementMisconfiguredError);
    if (raw.length > 4) expect((thrown as Error).message).not.toContain(raw.replace(/^0x/, ''));
  });
});

describe('settlementErrorResponse logging', () => {
  it('redacts key-shaped hex', () => {
    expect(redactSecrets(`bad key 0x${HEX} and ${HEX}`)).toBe('bad key [redacted] and [redacted]');
  });

  it('an unexpected error is logged with its cause (redacted) and answered generically', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = settlementErrorResponse(new Error(`composer said no for 0x${HEX}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'The sale could not be prepared. Nothing was signed.' });
    expect(spy).toHaveBeenCalledWith('[redeem-settlement] unexpected Error: composer said no for [redacted]');
    spy.mockRestore();
  });

  it('a malformed configuration is a 503 with its own code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = settlementErrorResponse(new SettlementMisconfiguredError('X is wrong'));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('SETTLEMENT_MISCONFIGURED');
    spy.mockRestore();
  });
});
