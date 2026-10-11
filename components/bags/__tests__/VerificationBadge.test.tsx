// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VerificationBadge } from '../VerificationBadge';

const NOW = Date.parse('2026-10-11T12:00:00Z');
afterEach(cleanup);

describe('VerificationBadge', () => {
  it('fresh, stale, pending outflow, unverified, and nothing for Bags without the information', () => {
    render(<VerificationBadge verification={{ checkedAt: '2026-10-11T11:57:00Z', pendingOutflows: 0 }} now={NOW} />);
    expect(screen.getByText(/Verified on-chain 3 min ago/)).toBeInTheDocument();
    cleanup();
    render(<VerificationBadge verification={{ checkedAt: '2026-10-11T10:00:00Z', pendingOutflows: 0 }} now={NOW} />);
    expect(screen.getByText(/Last verified 2 h ago/)).toBeInTheDocument();
    cleanup();
    render(<VerificationBadge verification={{ checkedAt: '2026-10-11T11:59:00Z', pendingOutflows: 2 }} now={NOW} />);
    expect(screen.getByText(/Outflow being confirmed/)).toBeInTheDocument();
    cleanup();
    render(<VerificationBadge verification={{ checkedAt: null, pendingOutflows: 0 }} now={NOW} />);
    expect(screen.getByText(/Not yet verified on-chain/)).toBeInTheDocument();
    cleanup();
    const { container } = render(<VerificationBadge verification={undefined} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});
