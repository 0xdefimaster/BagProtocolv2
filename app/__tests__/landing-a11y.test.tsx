// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { FOOTER_SECTION_LINKS } from '@/components/layout/Footer';
import { NAV_LINKS } from '@/lib/constants';

// -----------------------------------------------------------------------------
// Landing page (Header + all sections + Footer) — automated accessibility and
// copy-accuracy assertions on the REAL page component.
//
// axe-core runs every rule jsdom can evaluate. `color-contrast` needs real
// layout/rendering, so it is checked in a real browser instead
// (scripts/responsive-check.mjs runs axe in Chromium at six viewports).
// -----------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const { default: LandingPage } = await import('../page');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { error: 'Supabase is not configured on this deployment yet.' })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderLanding() {
  const utils = render(<LandingPage />);
  await waitFor(() => expect(document.body.textContent).toMatch(/isn.t connected to the protocol database/));
  return utils;
}

describe('landing page — automated accessibility (axe-core)', () => {
  it('has no axe violations (all jsdom-evaluable rules)', async () => {
    const { container } = await renderLanding();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    const summary = results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`);
    expect(summary).toEqual([]);
  });
});

describe('landing page — structure', () => {
  it('exactly one h1, and headings never skip a level', async () => {
    await renderLanding();
    const levels = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => Number(h.tagName[1]));
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  });

  it('every link and button has an accessible name', async () => {
    await renderLanding();
    for (const el of Array.from(document.querySelectorAll('a, button'))) {
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      expect(name, el.outerHTML.slice(0, 120)).not.toBe('');
    }
  });

  it('no clickable non-interactive elements (click handlers only on links/buttons)', async () => {
    await renderLanding();
    // React attaches listeners at the root, so check for the inline anti-pattern and role misuse instead.
    expect(document.querySelectorAll('div[onclick], span[onclick], div[role="button"], span[role="button"]')).toHaveLength(0);
  });

  it('has a skip link to the main landmark, and exactly one main', async () => {
    await renderLanding();
    const skip = document.querySelector('a.skip-link');
    expect(skip).toHaveAttribute('href', '#main');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.getElementById('main')?.tagName).toBe('MAIN');
  });

  it('every in-page footer and header link targets a section that exists', async () => {
    await renderLanding();
    const inPage = [...FOOTER_SECTION_LINKS.map((l) => l.href), ...NAV_LINKS.map((l) => l.href)].filter((h) => h.startsWith('#'));
    for (const href of inPage) expect(document.getElementById(href.slice(1)), href).not.toBeNull();
  });
});

describe('landing page — copy says only what the code does', () => {
  it('no claims the implementation does not back', async () => {
    await renderLanding();
    const text = document.body.textContent ?? '';
    for (const forbidden of [
      /IPFS/i,
      /parse it natively/i,
      /Phantom|Backpack/,
      /SHIPPED/,
      /on-chain-settled/i,
      /pinned/i,
      /RFC/,
      /lineage is recorded on-chain/i,
      /multi-chain vaults/i,
      /computed live from composition/i,
    ]) {
      expect(text, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('status tags are the literal AVAILABLE NOW / IN PROGRESS / COMING NEXT set', async () => {
    await renderLanding();
    const tags = Array.from(document.querySelectorAll('#roadmap .tag')).map((t) => t.textContent);
    expect(new Set(tags)).toEqual(new Set(['AVAILABLE NOW', 'IN PROGRESS', 'COMING NEXT']));
    // Contract deployment is never presented as available.
    const now = Array.from(document.querySelectorAll('#roadmap .tag-now')).map((t) => t.parentElement?.textContent ?? '');
    for (const item of now) expect(item).not.toMatch(/BagFactory on mainnet|BAG Router on Robinhood Chain|price pools/i);
  });

  it('positions Bag as multi-chain (four EVM chains, no Solana) and non-custodial', async () => {
    await renderLanding();
    const text = document.body.textContent ?? '';
    for (const chain of ['Ethereum', 'Arbitrum', 'Base', 'Robinhood Chain']) expect(text).toContain(chain);
    expect(text).not.toMatch(/Solana/i);
    expect(text).not.toMatch(/pools? (your |user )?deposits into a vault/i);
    expect(text).toMatch(/never pools deposits/i);
  });

  it('story order: hero → problem → primitive → CreatorFi → … → status → final CTA', async () => {
    await renderLanding();
    const ids = ['why', 'primitive', 'creatorfi', 'forks', 'audiences', 'featured-bags', 'how-it-works', 'networks', 'different', 'spec', 'architecture', 'roadmap', 'start'];
    const positions = ids.map((id) => {
      const el = document.getElementById(id);
      expect(el, id).not.toBeNull();
      return Array.from(document.querySelectorAll('[id]')).indexOf(el!);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('no fabricated creator metrics on the homepage', async () => {
    await renderLanding();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/TVL|Creator Score|Top 1%|12,400/);
  });

  it('with no database configured, Featured Bags says so instead of a misleading "try again"', async () => {
    await renderLanding();
    const featured = document.getElementById('featured-bags')!;
    expect(featured.textContent).toMatch(/isn.t connected to the protocol database/);
    expect(featured.textContent).not.toMatch(/try again/i);
  });
});
