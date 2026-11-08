import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/wallet-holdings', () => ({ MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11' }));

const { observeUserHoldings, sellableHoldingsForBag, valueUserPositions } = await import('../position-valuation');

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const WALLET = '0x1111111111111111111111111111111111111111';
const user = { userId: 'u1', walletAddress: WALLET };

function admin(rows: { bag_id: string; chain?: string; address: string; decimals?: number; quantity_raw: string }[]) {
  const data = rows.map((r) => ({ chain: 'robinhood', decimals: 18, ...r }));
  return { from: () => ({ select: () => ({ eq: async () => ({ data, error: null }) }) }) } as never;
}
function client(balances: Record<string, bigint | 'fail'>, chainId = 4663, block = 77) {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => BigInt(block),
    multicall: async ({ contracts }: { contracts: { address: string }[] }) =>
      contracts.map((c) => (balances[c.address] === 'fail' ? { status: 'failure' } : { status: 'success', result: balances[c.address] })),
  } as never;
}

describe('observeUserHoldings / sellableHoldingsForBag', () => {
  it('keeps identical token addresses and block heights isolated across all three networks', async () => {
    const rows = ['robinhood', 'base', 'arbitrum'].map(chain => ({ bag_id: chain, chain, address: A, quantity_raw: '100' }));
    const clients = { robinhood: client({ [A]: BigInt(10) }, 4663, 77), base: client({ [A]: BigInt(20) }, 8453, 88), arbitrum: client({ [A]: BigInt(30) }, 42161, 99) };
    const o = await observeUserHoldings(admin(rows), (chain) => clients[chain as keyof typeof clients], user);
    expect(o.blockNumber).toBeNull();
    expect(o.blockNumbers).toEqual({ robinhood: '77', base: '88', arbitrum: '99' });
    for (const [chain, amount] of [['robinhood', '10'], ['base', '20'], ['arbitrum', '30']]) {
      expect(sellableHoldingsForBag(o, chain)).toEqual([expect.objectContaining({ chain, sellableRaw: amount })]);
      expect(o.trackedAll.get(`${chain}:${A}`)).toBe(BigInt(100));
    }
    const prices = { getPrice: async () => ({ price: '1' }) } as never;
    const values = await valueUserPositions(admin(rows), chain => clients[chain as keyof typeof clients], prices, user);
    expect(values.get('base')?.blockNumber).toBe('88');
    expect(values.get('arbitrum')?.blockNumber).toBe('99');
  });

  it('an unavailable or incorrectly configured RPC cannot produce a zero balance or block other chains', async () => {
    const rows = ['robinhood', 'base', 'arbitrum'].map(chain => ({ bag_id: chain, chain, address: A, quantity_raw: '100' }));
    const o = await observeUserHoldings(admin(rows), chain => {
      if (chain === 'robinhood') throw new Error('offline');
      // An Arbitrum URL accidentally serving Base must not be trusted.
      return client({ [A]: BigInt(20) }, 8453, 88);
    }, user);
    expect(sellableHoldingsForBag(o, 'robinhood')).toBeNull();
    expect(sellableHoldingsForBag(o, 'arbitrum')).toBeNull();
    expect(sellableHoldingsForBag(o, 'base')?.[0].sellableRaw).toBe('20');
    expect(o.blockNumbers).toEqual({ base: '88' });
  });

  it('a short wallet: each strategy may sell all it tracks that the wallet holds (D3.1), at one block', async () => {
    // 80 held, 60 + 40 tracked: either strategy can sell its own tracked amount in full (the tokens are
    // fungible); whatever then remains short stays with the other strategy for the reconciliation to book.
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '60' }, { bag_id: 'y', address: A, quantity_raw: '40' }]), client({ [A]: BigInt(80) }), user);
    expect(o.blockNumber).toBe('77');
    expect(sellableHoldingsForBag(o, 'x')).toEqual([expect.objectContaining({ quantityRaw: '60', sellableRaw: '60' })]);
    expect(sellableHoldingsForBag(o, 'y')).toEqual([expect.objectContaining({ quantityRaw: '40', sellableRaw: '40' })]);
  });

  it('the reported case: another strategy\'s holding left the wallet; this one still sells all of its own', async () => {
    // Bag x tracks 12846 and the wallet holds exactly that; bag y's 3700 left earlier. Pro rata used to let x sell
    // only 12846 × 12846 / 16546 and leave the rest in the wallet after "sell all".
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '12846' }, { bag_id: 'y', address: A, quantity_raw: '3700' }]), client({ [A]: BigInt(12846) }), user);
    expect(sellableHoldingsForBag(o, 'x')).toEqual([expect.objectContaining({ sellableRaw: '12846' })]);
  });

  it('never more than the wallet holds', async () => {
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '60' }, { bag_id: 'y', address: A, quantity_raw: '40' }]), client({ [A]: BigInt(30) }), user);
    expect(sellableHoldingsForBag(o, 'x')).toEqual([expect.objectContaining({ sellableRaw: '30' })]);
    expect(sellableHoldingsForBag(o, 'y')).toEqual([expect.objectContaining({ sellableRaw: '30' })]);
  });

  it('one unreadable balance makes the whole strategy unsellable (fail-closed)', async () => {
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '10' }, { bag_id: 'x', address: B, quantity_raw: '10' }]), client({ [A]: BigInt(10), [B]: 'fail' }), user);
    expect(sellableHoldingsForBag(o, 'x')).toBeNull();
  });

  it('an RPC outage leaves every balance unknown', async () => {
    const broken = { getBlockNumber: async () => { throw new Error('down'); } } as never;
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '10' }]), broken, user);
    expect(o.blockNumber).toBeNull();
    expect(sellableHoldingsForBag(o, 'x')).toBeNull();
  });

  it('zero-quantity rows are ignored', async () => {
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '0' }]), client({}), user);
    expect(o.rows).toEqual([]);
  });
});

describe('valueUserPositions', () => {
  it('values each strategy from holdings; a refused price is null, not a fallback', async () => {
    const prices = { getPrice: async (a: { address: string }) => (a.address === A ? { price: '100' } : Promise.reject(new Error('closed'))) } as never;
    const values = await valueUserPositions(
      admin([{ bag_id: 'x', address: A, quantity_raw: '1000000000000000000' }, { bag_id: 'y', address: B, quantity_raw: '5' }]),
      client({ [A]: BigInt('870000000000000000'), [B]: BigInt(5) }),
      prices,
      user
    );
    expect(values.get('x')).toMatchObject({ strategyExposureQuote: '100', effectivePositionQuote: '87', hasDrift: true });
    expect(values.get('y')).toMatchObject({ strategyExposureQuote: null, effectivePositionQuote: null, hasDrift: false });
  });
});
