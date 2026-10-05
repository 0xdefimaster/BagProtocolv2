import { describe, expect, it, vi } from 'vitest';
import { checkFeeRouterExecutability, formatExecutabilityRow, redactRpcUrl, type QuoteFn } from '../fee-router-executability';

const USDG = { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const, decimals: 6 };
const NVDA = { symbol: 'NVDA', address: '0x00000000000000000000000000000000000000a1' as const, decimals: 18 };
const TIERS = [3000, 500, 10000] as const;

/** Sale quotes per fee tier, in USDG raw; a missing tier reverts (no pool / no liquidity for the size). */
function quoter(perTier: Partial<Record<number, bigint>>): QuoteFn & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ feeTier }) => (perTier[feeTier] === undefined ? null : { amountOut: perTier[feeTier]! })) as never;
}
const input = (quote: QuoteFn, over = {}) => ({ token: NVDA, usdg: USDG, sizeUsd: 100, priceUsd: '200', slippageBps: 100, feeTiers: TIERS, maxDeviationBps: 500, quote, ...over });

describe('checkFeeRouterExecutability — the attestation rule: best tier, verified price, 5%', () => {
  it('PASS: sizes $100 at the verified price (0.5 NVDA), takes the best tier, reports deviation and the 99% minimum', async () => {
    const q = quoter({ 3000: BigInt(99_000_000), 500: BigInt(99_420_000) });
    const r = await checkFeeRouterExecutability(input(q));
    expect(r).toMatchObject({ status: 'PASS', executable: true, reason: 'OK', feeTier: 500, tokenAmountRaw: (BigInt(5) * BigInt(10) ** BigInt(17)).toString(), quoteRaw: '99420000', referenceRaw: '100000000', deviationBps: 58, grossMinimumRaw: '98425800' });
    expect(formatExecutabilityRow(r, 6)).toMatch(/^NVDA\s+PASS\s+0\.05%\s+\$100 sell\s+\$99\.42\s+\$100\.00\s+\$98\.43\s+YES\s+OK\s+0\.58% below verified$/);
    expect(q).toHaveBeenCalledWith(expect.objectContaining({ amountIn: BigInt(5) * BigInt(10) ** BigInt(17) }));
  });

  it('UNSAFE: the live AAOI pattern — only a near-empty 1% pool quotes; refused, not signed', async () => {
    const r = await checkFeeRouterExecutability(input(quoter({ 10000: BigInt(180_000) }), { sizeUsd: 25 }));
    expect(r).toMatchObject({ status: 'UNSAFE', executable: false, reason: 'PRICE_DEVIATION', feeTier: 10000, deviationBps: 9928 });
    expect(formatExecutabilityRow(r, 6)).toMatch(/UNSAFE\s+1%\s+\$25 sell\s+\$0\.18\s+\$25\.00\s+\$—\s+NO\s+PRICE_DEVIATION\s+99\.28% below verified$/);
  });

  it('FAIL: no quote on any tier; no verified price (nothing is quoted then); RPC error', async () => {
    expect(await checkFeeRouterExecutability(input(quoter({})))).toMatchObject({ status: 'FAIL', reason: 'NO_QUOTE' });
    const q = quoter({ 3000: BigInt(1) });
    expect(await checkFeeRouterExecutability(input(q, { priceUsd: null, priceError: 'MARKET_CLOSED_OR_HALTED' }))).toMatchObject({ status: 'FAIL', reason: 'PRICE_UNAVAILABLE', error: 'MARKET_CLOSED_OR_HALTED' });
    expect(q).not.toHaveBeenCalled();
    const broken: QuoteFn = async () => {
      throw new Error(`HTTP request failed.\n\nURL: https://rpc.example/v2/KEY\n${'x'.repeat(300)}`);
    };
    const r = await checkFeeRouterExecutability(input(broken));
    expect(r).toMatchObject({ status: 'FAIL', reason: 'RPC_ERROR' });
    const row = formatExecutabilityRow(r, 6);
    expect(row).toContain('RPC_ERROR  (HTTP request failed.)');
    expect(row).not.toContain('KEY');
  });

  it('USDG itself is a no-swap leg', async () => {
    const q = quoter({});
    expect(await checkFeeRouterExecutability(input(q, { token: { symbol: 'USDG', ...USDG } }))).toMatchObject({ status: 'PASS', reason: 'SETTLEMENT_TOKEN' });
    expect(q).not.toHaveBeenCalled();
  });

  it('never prints an RPC credential: only scheme and host survive', () => {
    expect(redactRpcUrl('https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY')).toBe('https://robinhood-mainnet.g.alchemy.com/…');
    expect(redactRpcUrl('https://rpc.example.com/?apikey=SECRET')).toBe('https://rpc.example.com/…');
    expect(redactRpcUrl('https://rpc.mainnet.chain.robinhood.com')).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(redactRpcUrl('not a url')).toBe('<rpc url>');
  });
});
