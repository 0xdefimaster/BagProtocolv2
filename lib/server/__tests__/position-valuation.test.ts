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
function client(balances: Record<string, bigint | 'fail'>) {
  return {
    getBlockNumber: async () => BigInt(77),
    multicall: async ({ contracts }: { contracts: { address: string }[] }) =>
      contracts.map((c) => (balances[c.address] === 'fail' ? { status: 'failure' } : { status: 'success', result: balances[c.address] })),
  } as never;
}

describe('observeUserHoldings / sellableHoldingsForBag', () => {
  it('attributes a short wallet pro rata across strategies, at one block', async () => {
    const o = await observeUserHoldings(admin([{ bag_id: 'x', address: A, quantity_raw: '60' }, { bag_id: 'y', address: A, quantity_raw: '40' }]), client({ [A]: BigInt(80) }), user);
    expect(o.blockNumber).toBe('77');
    expect(sellableHoldingsForBag(o, 'x')).toEqual([expect.objectContaining({ quantityRaw: '60', sellableRaw: '48' })]);
    expect(sellableHoldingsForBag(o, 'y')).toEqual([expect.objectContaining({ quantityRaw: '40', sellableRaw: '32' })]);
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
