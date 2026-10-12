import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/wallet-context', () => ({ useWallet: () => ({}) }));

const { composerSaleLabel } = await import('../RedeemPreviewModal');

const steps = [
  { targetSymbol: 'AAPL', inputAsset: { address: '0x00000000000000000000000000000000000000A1' } },
  { targetSymbol: 'MSFT', inputAsset: { address: '0x00000000000000000000000000000000000000b2' } },
];

describe('composerSaleLabel', () => {
  it('a wallet that cannot batch (Rabby): each approval, then the sale, with the step count', () => {
    expect(composerSaleLabel({ kind: 'approval', index: 1, total: 2, token: '0x00000000000000000000000000000000000000a1' }, steps)).toBe(
      'Step 1 of 3: approve AAPL for this sale (exact amount) in your wallet. Your wallet cannot combine the steps, so it asks one by one.'
    );
    expect(composerSaleLabel({ kind: 'sale', afterApprovals: 2 }, steps)).toBe('Step 3 of 3: confirm the sale of AAPL, MSFT in your wallet');
  });

  it('a batching wallet: one confirmation; before the wallet answers, no promise either way', () => {
    expect(composerSaleLabel({ kind: 'batch' }, steps)).toBe('Confirm the sale of AAPL, MSFT in your wallet (one confirmation)');
    expect(composerSaleLabel(null, steps)).toBe('Confirm the sale of AAPL, MSFT in your wallet');
    expect(composerSaleLabel({ kind: 'sale', afterApprovals: 0 }, steps)).toBe('Confirm the sale of AAPL, MSFT in your wallet');
  });

  it('an approval for a token not among the steps still reads sensibly', () => {
    expect(composerSaleLabel({ kind: 'approval', index: 2, total: 2, token: '0x' + 'c'.repeat(40) }, steps)).toContain('approve a token');
  });
});
