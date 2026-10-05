import { describe, expect, it, vi } from 'vitest';
import { checkFeeRouterExecutability, formatExecutabilityRow, redactRpcUrl, type QuoteFn } from '../fee-router-executability';

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
    expect(r).toMatchObject({ status: 'PASS', executable: true, reason: 'OK', sellFeeTier: 3000, quoteRaw: '99420000', grossMinimumRaw: '98425800', roundTripLossBps: 58, bestFeeTier: 3000 });
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
    // The better tier is reported next to it.
    expect(r).toMatchObject({ bestFeeTier: 10000, bestQuoteRaw: '99000000' });
    expect(formatExecutabilityRow(r, 6)).toContain('best 1% $99.00');
  });

  it('UNSAFE: the live finding — the only quoting tier is a near-empty 1% pool; it executes, but the seller gets cents on the dollar', async () => {
    // $25 → (dust 1% pool) → sells back for $0.18, like AAOI on 2026-10-05.
    const q = quoter({ 'buy:10000': () => BigInt(10) ** BigInt(15), 'sell:10000': () => BigInt(180_000) });
    const r = await checkFeeRouterExecutability(input(q, { sizeUsdg: 25 }));
    expect(r).toMatchObject({ status: 'UNSAFE', executable: true, reason: 'EXCESSIVE_LOSS', sellFeeTier: 10000, quoteRaw: '180000', roundTripLossBps: 9928 });
    expect(formatExecutabilityRow(r, 6)).toMatch(/^NVDA\s+UNSAFE\s+1%\s+\$25 sell\s+\$0\.18\s+\$0\.18\s+YES\s+EXCESSIVE_LOSS\s+round-trip loss 99\.28%$/);
    // The threshold is configurable.
    expect((await checkFeeRouterExecutability(input(q, { sizeUsdg: 25, maxLossBps: 10000 }))).status).toBe('PASS');
  });

  it('never prints an RPC credential: only scheme and host survive', () => {
    expect(redactRpcUrl('https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY')).toBe('https://robinhood-mainnet.g.alchemy.com/…');
    expect(redactRpcUrl('https://rpc.example.com/?apikey=SECRET')).toBe('https://rpc.example.com/…');
    expect(redactRpcUrl('https://rpc.mainnet.chain.robinhood.com')).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(redactRpcUrl('not a url')).toBe('<rpc url>');
  });

  it('FAIL reasons: no pool at all, a pool that cannot take the sale size, zero output, RPC failure', async () => {
    expect((await checkFeeRouterExecutability(input(quoter({})))).reason).toBe('NO_LIQUIDITY_TO_SIZE');
    const noSell = await checkFeeRouterExecutability(input(quoter({ 'buy:3000': () => BigInt(1) })));
    expect(noSell).toMatchObject({ status: 'FAIL', executable: false, reason: 'NO_SELL_LIQUIDITY', tokenAmountRaw: '1' });
    expect((await checkFeeRouterExecutability(input(quoter({ 'buy:3000': () => BigInt(1), 'sell:3000': () => BigInt(0) })))).reason).toBe('ZERO_OUTPUT');
    const broken: QuoteFn = async () => {
      throw new Error('rpc down');
    };
    expect(await checkFeeRouterExecutability(input(broken))).toMatchObject({ executable: false, reason: 'RPC_ERROR', error: 'rpc down' });
    const noisy: QuoteFn = async () => {
      throw new Error(`Address "0x33E885Ed0Ec9Bf04ecfB19341582AadCb4c8a9e7" is invalid.\n\n- Address must match its checksum counterpart.\n${'x'.repeat(500)}`);
    };
    const row = formatExecutabilityRow(await checkFeeRouterExecutability(input(noisy)), 6);
    expect(row).toContain('RPC_ERROR  (Address "0x33E885Ed0Ec9Bf04ecfB19341582AadCb4c8a9e7" is invalid.)');
    expect(row.split('\n')).toHaveLength(1);
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
    // One sizing quote, then the sale quoted on every tier (to find the attestation's and the best).
    expect(q).toHaveBeenCalledTimes(4);
  });
});
