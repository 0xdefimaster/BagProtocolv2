// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { AssetIcon } from '../AssetIcon';

describe('AssetIcon', () => {
  afterEach(cleanup);

  it('shows the token logo when the registry has one', () => {
    const { container } = render(<AssetIcon asset={{ symbol: 'AAPL', logoUrl: 'https://cdn.example/aapl.png' }} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/aapl.png');
  });

  it('falls back to the symbol when there is no logo', () => {
    const { container } = render(<AssetIcon asset={{ symbol: 'wstETH' }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('WST');
  });

  it('falls back to the symbol when the logo fails to load', () => {
    const { container } = render(<AssetIcon asset={{ symbol: 'NVDA', logoUrl: 'https://cdn.example/broken.png' }} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('NVD');
  });
});
