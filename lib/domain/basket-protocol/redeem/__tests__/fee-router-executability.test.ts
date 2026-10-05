import { describe, expect, it, vi } from 'vitest';
import { checkFeeRouterExecutability, formatExecutabilityRow, type QuoteFn } from '../fee-router-executability';

const USDG = { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const, decimals: 6 };
const NVDA = { symbol: 'NVDA', address: '0x00000000000000000000000000000000000000a1' as const, decimals: 18 };
const TIERS = [3000, 500, 10000] as const;

/** A pool per (direction, tier): `null` = that tier reverts (no pool / no liquidity for the size). */
function quoter(pools: Record<string, ((amountIn: bigint) => bigint) | null>): QuoteFn & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ tokenIn, feeTier, amountIn }) => {
    const dir = tokenIn.toLowerCase() === USDG.address.toLowerCase() ? 'buy' : 'sell';
    const pool = pools[`${dir}:${feeTier}`];
    return pool ? { amountOut: pool(amountIn) } : null;
  }) as never;
}

const input = (quote: QuoteFn, over = {}) => ({ token: NVDA, usdg: USDG, sizeUsdg: 100, slippageBps: 100, feeTiers: TIERS, quote, ...over });

describe('checkFeeRouterExecutability — mirrors signFeeAttestation', () => {
  it('PASS: sizes $100, quotes the sale back, gross minimum = 99% of the quote; round-trip loss reported', async () => {
    // $100 buys 0.5 NVDA; 0.5 NVDA sells for $99.42.
    const q = quoter({ 'buy:3000': () => BigInt(5) * BigInt(10) ** BigInt(17), 'sell:3000': () => BigInt(99_420_000) });
    const r = await checkFeeRouterExecutability(input(q));
    expect(r).toMatchObject({ executable: true, reason: 'OK', sellFeeTier: 3000, quoteRaw: '99420000', grossMinimumRaw: '98425800', roundTripLossBps: 58 });
    expect(formatExecutabilityRow(r, 6)).toMatch(/^NVDA\s+PASS\s+0\.3%\s+\$100 sell\s+\$99\.42\s+\$98\.43\s+YES\s+OK\s+round-trip loss 0\.58%$/);
  });

  it('uses the FIRST tier that quotes, in the attestation order — not the best one', async () => {
    const q = quoter({
      'buy:3000': null,
      'buy:500': () => BigInt(10) ** BigInt(18),
      'sell:3000': null,
      'sell:500': () => BigInt(90_000_000), // worse
      'sell:10000': () => BigInt(99_000_000), // better, but later in the order
    });
    const r = await checkFeeRouterExecutability(input(q));
    expect(r.sellFeeTier).toBe(500);
    expect(r.quoteRaw).toBe('90000000');
  });

  it('FAIL reasons: no pool at all, a pool that cannot take the sale size, zero output, RPC failure', async () => {
    expect((await checkFeeRouterExecutability(input(quoter({})))).reason).toBe('NO_LIQUIDITY_TO_SIZE');
    const noSell = await checkFeeRouterExecutability(input(quoter({ 'buy:3000': () => BigInt(1) })));
    expect(noSell).toMatchObject({ executable: false, reason: 'NO_SELL_LIQUIDITY', tokenAmountRaw: '1' });
    expect((await checkFeeRouterExecutability(input(quoter({ 'buy:3000': () => BigInt(1), 'sell:3000': () => BigInt(0) })))).reason).toBe('ZERO_OUTPUT');
    const broken: QuoteFn = async () => {
      throw new Error('rpc down');
    };
    expect(await checkFeeRouterExecutability(input(broken))).toMatchObject({ executable: false, reason: 'RPC_ERROR', error: 'rpc down' });
    expect(formatExecutabilityRow(noSell, 6)).toMatch(/^NVDA\s+FAIL\s+—\s+\$100 sell\s+\$—\s+\$—\s+NO\s+NO_SELL_LIQUIDITY$/);
  });

  it('USDG itself is a no-swap leg: executable without a quote', async () => {
    const q = quoter({});
    const r = await checkFeeRouterExecutability(input(q, { token: { symbol: 'USDG', ...USDG } }));
    expect(r).toMatchObject({ executable: true, reason: 'SETTLEMENT_TOKEN' });
    expect(q).not.toHaveBeenCalled();
  });

  it('only ever quotes (read-only): the injected quoter is the sole chain access', async () => {
    const q = quoter({ 'buy:3000': () => BigInt(1), 'sell:3000': () => BigInt(100_000_000) });
    await checkFeeRouterExecutability(input(q));
    expect(q).toHaveBeenCalledTimes(2);
  });
});
