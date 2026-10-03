import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { getSqrtRatioAtTick, meanTickFromCumulatives, MAX_TICK, MIN_TICK, priceFromSqrtRatio } from '../uniswap-v3-twap';
import { parseRobinhoodPricePools, RobinhoodTwapPriceProvider, TwapReadClient } from '../robinhood-twap-provider';
import { PriceUnavailableError } from '../provider';

// Unit tests with a SCRIPTED chain client — these prove the math, the
// validation and every fail-closed branch. They are NOT a live price: no test
// in this repository has read a real Robinhood Chain pool (see
// docs/ROBINHOOD_PRICE_AUTHORITY.md, "Live verification").

describe('Uniswap v3 oracle math (exact TickMath port)', () => {
  it('matches TickMath.sol at tick 0, MIN_TICK and MAX_TICK', () => {
    expect(getSqrtRatioAtTick(0)).toBe(BigInt(2) ** BigInt(96));
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(BigInt('4295128739'));
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(BigInt('1461446703485210103287273052203988822378723970342'));
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow();
  });

  it('price(tick) ≈ 1.0001^tick across the range (relative error < 1e-9)', () => {
    for (const tick of [-200000, -50000, -1, 1, 777, 50000, 200000]) {
      const p = priceFromSqrtRatio(getSqrtRatioAtTick(tick), true, 0, 0, 18);
      const expected = Math.pow(1.0001, tick);
      expect(Math.abs(Number(p) / 1e18 - expected) / expected).toBeLessThan(1e-9);
    }
  });

  it('mean tick rounds toward NEGATIVE infinity (OracleLibrary semantics)', () => {
    expect(meanTickFromCumulatives(BigInt(0), BigInt(3601), 1800)).toBe(2);
    expect(meanTickFromCumulatives(BigInt(0), BigInt(-3601), 1800)).toBe(-3);
    expect(meanTickFromCumulatives(BigInt(0), BigInt(-3600), 1800)).toBe(-2);
  });
});

const ASSET: Hex = '0x1111111111111111111111111111111111111111';
const USDG: Hex = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const POOL: Hex = '0x2222222222222222222222222222222222222222';
const FACTORY: Hex = '0x1F7d7550b1B028F7571E69A784071F0205fD2eFa';
const NOW = new Date('2026-09-28T12:00:00Z');
const WINDOW = 1800;

/** A tick such that one whole ASSET (assetDecimals) = `usd` whole USDG (6 decimals). */
function tickFor(usd: number, assetIsToken0: boolean, assetDecimals: number) {
  const rawRatio = assetIsToken0 ? (usd * 1e6) / 10 ** assetDecimals : 10 ** assetDecimals / (usd * 1e6);
  return Math.round(Math.log(rawRatio) / Math.log(1.0001));
}

function client(o: {
  assetIsToken0?: boolean;
  assetDecimals?: number;
  usd?: number;
  factory?: Hex;
  canonical?: Hex;
  tokens?: [Hex, Hex];
  liquidity?: bigint;
  observeThrows?: boolean;
  blockTime?: Date;
} = {}): TwapReadClient {
  const assetIsToken0 = o.assetIsToken0 ?? true;
  const tick = tickFor(o.usd ?? 2000, assetIsToken0, o.assetDecimals ?? 18);
  const [t0, t1] = o.tokens ?? (assetIsToken0 ? [ASSET, USDG] : [USDG, ASSET]);
  return {
    getBlock: async () => ({ timestamp: BigInt(Math.floor((o.blockTime ?? NOW).getTime() / 1000)) }),
    readContract: async ({ address, functionName }: { address: Hex; functionName: string }) => {
      if (address.toLowerCase() === POOL.toLowerCase()) {
        switch (functionName) {
          case 'factory':
            return o.factory ?? FACTORY;
          case 'token0':
            return t0;
          case 'token1':
            return t1;
          case 'fee':
            return 3000;
          case 'liquidity':
            return o.liquidity ?? BigInt(10) ** BigInt(20);
          case 'observe':
            if (o.observeThrows) throw new Error('OLD');
            return [[BigInt(0), BigInt(tick) * BigInt(WINDOW)], [BigInt(0), BigInt(0)]];
        }
      }
      if (address.toLowerCase() === FACTORY.toLowerCase() && functionName === 'getPool') return o.canonical ?? POOL;
      if (address.toLowerCase() === ASSET.toLowerCase() && functionName === 'decimals') return o.assetDecimals ?? 18;
      throw new Error(`unexpected read ${address} ${functionName}`);
    },
  } as unknown as TwapReadClient;
}

const provider = (c: TwapReadClient, pools: Record<string, Hex> = { [ASSET]: POOL }) =>
  new RobinhoodTwapPriceProvider({ client: c, factoryAddress: FACTORY, usdg: { address: USDG, decimals: 6 }, pools, windowSeconds: WINDOW, now: () => NOW });
const asset = { chain: 'robinhood' as const, address: ASSET };

describe('RobinhoodTwapPriceProvider — real-source shape', () => {
  it.each([
    [true, 18],
    [false, 18],
    [true, 8],
    [false, 6],
  ])('assetIsToken0=%s decimals=%s: decimals-normalized USD price within one tick (0.01%%), with source, timestamp and quote currency', async (isT0, dec) => {
    const p = await provider(client({ assetIsToken0: isT0, assetDecimals: dec, usd: 2000 })).getPrice(asset);
    expect(Math.abs(Number(p.price) - 2000) / 2000).toBeLessThan(0.0001);
    expect(p.quoteCurrency).toBe('USD');
    expect(p.timestamp).toBe(NOW.toISOString());
    expect(p.source).toBe(`uniswap-v3-twap:${POOL.toLowerCase()}:${WINDOW}s:USDG`);
  });

  it('USDG itself is priced at its peg (explicitly labelled, not a market price)', async () => {
    const p = await provider(client()).getPrice({ chain: 'robinhood', address: USDG });
    expect(p).toMatchObject({ price: '1', source: 'peg:USDG' });
  });
});

describe('RobinhoodTwapPriceProvider — fails closed, never guesses', () => {
  const unavailable = async (c: TwapReadClient, pools?: Record<string, Hex>, a = asset) => {
    await expect(provider(c, pools).getPrice(a)).rejects.toBeInstanceOf(PriceUnavailableError);
  };
  it('unconfigured asset (no pool mapping)', () => unavailable(client(), {}));
  it('pool not created by the verified factory', () => unavailable(client({ factory: '0x9999999999999999999999999999999999999999' })));
  it('pool is not {asset, USDG}', () => unavailable(client({ tokens: [ASSET, '0x3333333333333333333333333333333333333333'] })));
  it('look-alike pool: factory.getPool does not return it', () => unavailable(client({ canonical: '0x4444444444444444444444444444444444444444' })));
  it('zero in-range liquidity', () => unavailable(client({ liquidity: BigInt(0) })));
  it('not enough observation history for the TWAP window (observe reverts)', () => unavailable(client({ observeThrows: true })));
  it('stale chain: latest block older than maxAge', () => unavailable(client({ blockTime: new Date(NOW.getTime() - 60 * 60 * 1000) })));
  it('non-Robinhood asset', () => unavailable(client(), undefined, { chain: 'base', address: ASSET } as never));
});

describe('configuration', () => {
  it('parses ROBINHOOD_PRICE_POOLS deterministically (lower-cased keys) and rejects malformed input', () => {
    expect(parseRobinhoodPricePools(undefined)).toEqual({});
    expect(parseRobinhoodPricePools(JSON.stringify({ [ASSET.toUpperCase().replace('0X', '0x')]: POOL }))).toEqual({ [ASSET.toLowerCase()]: POOL });
    expect(() => parseRobinhoodPricePools('not json')).toThrow();
    expect(() => parseRobinhoodPricePools(JSON.stringify({ '0x12': POOL }))).toThrow();
  });

});
