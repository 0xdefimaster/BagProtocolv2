// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TokenizedStockNotice, coinbaseStockSymbolsIn } from '../TokenizedStockNotice';
import { coinbaseStockFailureHint } from '@/lib/blockchain/lifi-wallet-client';

afterEach(cleanup);

const THURSDAY_OPEN = new Date('2026-11-19T15:00:00Z'); // 10:00 New York
const THURSDAY_NIGHT = new Date('2026-11-19T01:30:00Z'); // 20:30 New York
const SATURDAY = new Date('2026-11-21T15:00:00Z');

describe('TokenizedStockNotice', () => {
  it('only for pinned Coinbase stocks on Base', () => {
    expect(coinbaseStockSymbolsIn('base', ['NVDAc', 'USDC', 'aapLC', null])).toEqual(['NVDAc', 'aapLC']);
    expect(coinbaseStockSymbolsIn('robinhood', ['NVDAc'])).toEqual([]);
    expect(coinbaseStockSymbolsIn('base', ['WETH', 'PT-NVDAc'])).toEqual([]);
    const { container } = render(<TokenizedStockNotice chain="base" symbols={['WETH']} now={THURSDAY_NIGHT} />);
    expect(container.textContent).toBe('');
  });

  it('warns about wider spreads when the US market is closed', () => {
    render(<TokenizedStockNotice chain="base" symbols={['NVDAc', 'AAPLc']} now={THURSDAY_NIGHT} />);
    expect(screen.getByTestId('tokenized-stock-notice').textContent).toMatch(/market is closed\. NVDAc, AAPLc still trade onchain/);
  });

  it('says weekend on a weekend, and drops the closed-market warning during the session', () => {
    render(<TokenizedStockNotice chain="base" symbols={['METAc']} now={SATURDAY} />);
    expect(screen.getByTestId('tokenized-stock-notice').textContent).toMatch(/closed for the weekend/);
    cleanup();
    render(<TokenizedStockNotice chain="base" symbols={['METAc']} now={THURSDAY_OPEN} />);
    const text = screen.getByTestId('tokenized-stock-notice').textContent ?? '';
    expect(text).not.toMatch(/closed/);
    expect(text).toMatch(/can briefly pause/);
  });
});

describe('coinbaseStockFailureHint', () => {
  it('names the Coinbase stocks a failed transaction moves, and says nothing otherwise', () => {
    const data = `0xabcdef${'b20000000000000000000078ee7ce2fe4908108c'}00${'B2000000000000000000008bC8786B856E61707C'}`;
    expect(coinbaseStockFailureHint(data)).toMatch(/moves NVDAc, METAc \(Coinbase tokenized stocks\)/);
    expect(coinbaseStockFailureHint('0xdeadbeef')).toBe('');
  });
});
