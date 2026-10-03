import { describe, expect, it, vi } from 'vitest';
import {
  assertRouterFactoryMatches,
  readRouterBagFactory,
  verifyRouterFactoryMatchesConfig,
  RouterFactoryMismatchError,
} from '../verify-router-factory';

// -----------------------------------------------------------------------------
// Item 8 — BagExecutionRouter.bagFactory is immutable; these prove the
// preflight check (scripts/verify-bag-router-factory.ts) actually catches a
// drifted config rather than silently agreeing with it.
// -----------------------------------------------------------------------------

const ROUTER = '0xAAAA000000000000000000000000000000AAAA';
const FACTORY = '0xBBBB000000000000000000000000000000BBBB';

describe('assertRouterFactoryMatches', () => {
  it('passes silently when the router\'s on-chain factory matches the configured one', () => {
    expect(() => assertRouterFactoryMatches(ROUTER, FACTORY, FACTORY)).not.toThrow();
  });

  it('is case-insensitive (checksummed vs lowercase addresses are the same address)', () => {
    expect(() => assertRouterFactoryMatches(ROUTER, FACTORY.toLowerCase(), FACTORY.toUpperCase().replace('0X', '0x'))).not.toThrow();
  });

  it('throws RouterFactoryMismatchError — the exact production-blocker scenario item 8 describes — when they differ', () => {
    const staleFactory = '0xCCCC000000000000000000000000000000CCCC';
    try {
      assertRouterFactoryMatches(ROUTER, FACTORY, staleFactory);
      throw new Error('expected assertRouterFactoryMatches to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RouterFactoryMismatchError);
      const e = err as RouterFactoryMismatchError;
      expect(e.routerAddress).toBe(ROUTER);
      expect(e.routerBagFactory).toBe(FACTORY);
      expect(e.configuredFactoryAddress).toBe(staleFactory);
      expect(e.message).toMatch(/UnknownBag/);
    }
  });
});

describe('verifyRouterFactoryMatchesConfig', () => {
  it('reads the router\'s bagFactory() and delegates to the pure check', async () => {
    const readContract = vi.fn().mockResolvedValue(FACTORY);
    const client = { readContract } as never;

    await expect(verifyRouterFactoryMatchesConfig(client, ROUTER, FACTORY)).resolves.toBeUndefined();
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ROUTER, functionName: 'bagFactory' }));
  });

  it('propagates a mismatch as RouterFactoryMismatchError, not a generic error', async () => {
    const client = { readContract: vi.fn().mockResolvedValue('0xCCCC000000000000000000000000000000CCCC') } as never;
    await expect(verifyRouterFactoryMatchesConfig(client, ROUTER, FACTORY)).rejects.toBeInstanceOf(RouterFactoryMismatchError);
  });
});

describe('readRouterBagFactory', () => {
  it('calls readContract with the minimal getter ABI, on the given router address', async () => {
    const readContract = vi.fn().mockResolvedValue(FACTORY);
    const client = { readContract } as never;
    expect(await readRouterBagFactory(client, ROUTER)).toBe(FACTORY);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: ROUTER, functionName: 'bagFactory', abi: expect.any(Array) })
    );
  });
});
