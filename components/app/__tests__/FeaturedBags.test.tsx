// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// -----------------------------------------------------------------------------
// Production-hardening P0-5 — regression test 18: "Explore production does
// not use mock bags." A real, just-published Bag must actually show up in
// Explore, and — outside demo mode — a fixture bag like "AI Leaders" (from
// lib/mock-data.ts's `mockBags`) must never appear.
// -----------------------------------------------------------------------------

vi.mock('@/components/bags/BagCard', () => ({
  BagCard: ({ bag }: { bag: { id: string; name: string } }) => <div data-testid={`bag-${bag.id}`}>{bag.name}</div>,
}));

const { FeaturedBags } = await import('../FeaturedBags');

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('FeaturedBags (Explore) — real data only (P0-5, regression test 18)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
  });

  it('renders a real, just-published bag from GET /api/bags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { bags: [{ id: 'real-bag-9', name: 'Real Published Bag', category: undefined }] }))
    );

    render(<FeaturedBags />);

    await waitFor(() => expect(screen.getByText('Real Published Bag')).toBeInTheDocument());
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument(); // mockBags fixture name
  });

  it('an empty real result shows an honest empty state, never the mock catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));

    render(<FeaturedBags />);

    await waitFor(() =>
      expect(screen.getByText(/no bags have been published yet/i)).toBeInTheDocument()
    );
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument();
    expect(screen.queryByText('L2 Ecosystem')).not.toBeInTheDocument();
  });

  it('an API failure shows an error + retry, never a silent fallback to mock bags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    render(<FeaturedBags />);

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('AI Leaders')).not.toBeInTheDocument();
  });

  it('demo mode explicitly enabled: mock bags ARE shown, alongside any real ones', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { bags: [] })));

    render(<FeaturedBags />);

    await waitFor(() => expect(screen.getByText('AI Leaders')).toBeInTheDocument());
  });
});
