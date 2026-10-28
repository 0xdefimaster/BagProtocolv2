// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

afterEach(cleanup);

vi.mock('@/lib/registry-assets-client', () => ({ fetchRegistryAssetsForChain: () => Promise.resolve([]) }));
vi.mock('@/components/create/AssetSelector', () => ({ AssetSelector: () => null }));

import { CompositionEditor, type CompositionRow } from '../CompositionEditor';

const start: CompositionRow[] = [
  { address: '0x0000000000000000000000000000000000000001', symbol: 'AAPL', percent: '50' },
  { address: '0x0000000000000000000000000000000000000002', symbol: 'ASML', percent: '30' },
  { address: '0x0000000000000000000000000000000000000003', symbol: 'COIN', percent: '20' },
];

function Harness() {
  const [rows, setRows] = useState(start);
  return <CompositionEditor chain="robinhood" original={start} rows={rows} onChange={setRows} />;
}

const weight = (s: string) => (screen.getByLabelText(`${s} weight in percent`) as HTMLInputElement).value;

describe('CompositionEditor weight sliders', () => {
  it('moving one slider moves the others and keeps the total at 100%', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('AAPL weight slider'), { target: { value: '7000' } });
    expect([weight('AAPL'), weight('ASML'), weight('COIN')]).toEqual(['70', '18', '12']);
    expect(screen.getByTestId('edit-strategy-total')).toHaveTextContent('Total 100%');
  });

  it('removing an asset scales the rest back to 100%', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Remove AAPL'));
    expect([weight('ASML'), weight('COIN')]).toEqual(['60', '40']);
    expect(screen.getByTestId('edit-strategy-total')).toHaveTextContent('Total 100%');
  });

  it('typing still works and shows an incomplete total', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('COIN weight in percent'), { target: { value: '10' } });
    expect(screen.getByTestId('edit-strategy-total')).toHaveTextContent('Total 90%');
  });
});
