/**
 * Real-browser responsive + accessibility check of the homepage.
 *
 *   npm run build && npx next start -p 3100 &
 *   NODE_PATH=<dir containing playwright-core> BASE_URL=http://localhost:3100 \
 *   CHROMIUM_PATH=/path/to/chrome node scripts/responsive-check.mjs [outDir]
 *
 * playwright-core is intentionally NOT a project dependency: this is an
 * occasional QA script, run with whatever Chromium the machine already has.
 *
 * Per viewport (1440x900, 1280x800, 1024x768, 768x1024, 390x844, 375x667) it
 * checks, on the real rendered page:
 *   - no horizontal page overflow; no element sticking out of the viewport
 *     (intentional horizontal scrollers excluded)
 *   - navbar mode (inline links vs. menu button) matches the 840px breakpoint;
 *     on mobile the menu opens, shows its links, and closes on Escape
 *   - hero heading + CTAs, featured Bag cards, section headings, code card and
 *     footer are visible and not clipped
 *   - touch targets of controls are >= 24x24 CSS px (WCAG 2.2 AA 2.5.8);
 *     inline text links are exempt, as WCAG allows
 *   - at least 48px between a section's heading and the previous section
 *   - axe-core (WCAG 2.0/2.1 A+AA incl. color-contrast) in real Chromium
 * and saves a full-page screenshot. Two data states are exercised: /api/bags
 * returning sample Bags (cards render) and 503 (no database configured).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const OUT = process.argv[2] ?? 'reports/responsive';
const require = createRequire(import.meta.url);
// CommonJS require honors NODE_PATH (ESM `import` does not), so playwright-core can live outside the project.
const { chromium } = require('playwright-core');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const VIEWPORTS = [
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [768, 1024],
  [390, 844],
  [375, 667],
];
const SAMPLE_BAGS = {
  bags: [1, 2, 3].map((i) => ({
    id: `sample-${i}`,
    name: `Sample Bag ${i} with a fairly long display name`,
    creator: { name: `creator${i}.eth` },
    composition: [
      { symbol: 'NVDA', weight: 40 },
      { symbol: 'MSFT', weight: 35 },
      { symbol: 'TSLA', weight: 25 },
    ],
  })),
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const report = [];
let failures = 0;

for (const [width, height] of VIEWPORTS) {
  for (const data of ['sample', 'unconfigured']) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route('**/api/bags*', (route) =>
      data === 'sample'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BAGS) })
        : route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Supabase is not configured on this deployment yet.' }) })
    );
    await page.emulateMedia({ reducedMotion: 'reduce' }); // reveal all sections deterministically
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const r = { viewport: `${width}x${height}`, data, problems: [] };
    const fail = (m) => {
      r.problems.push(m);
      failures++;
    };

    const layout = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const scrollers = (el) => {
        for (let n = el.parentElement; n; n = n.parentElement) {
          const o = getComputedStyle(n).overflowX;
          if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
        }
        return false;
      };
      const sticking = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.right > vw + 1 && !scrollers(el)) sticking.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
      }
      const visible = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const b = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const clipped = [];
      for (const el of document.querySelectorAll('h1, h2, h3, .btn, .lbc-name, .hpc-name')) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') clipped.push(el.textContent.trim().slice(0, 40));
      }
      const small = [];
      for (const el of document.querySelectorAll('a, button')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        const inlineText = getComputedStyle(el).display === 'inline' && el.closest('p, li, span');
        if (!inlineText && (b.width < 24 || b.height < 24)) small.push(`${el.textContent.trim().slice(0, 30) || el.getAttribute('aria-label')} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      // Section rhythm: every section heading needs clear space above it (a
      // padding shorthand once zeroed this and headings sat flush on the
      // previous section's content).
      const tight = [];
      const secs = Array.from(document.querySelectorAll('main section'));
      for (let i = 1; i < secs.length; i++) {
        const head = secs[i].querySelector('.section-head');
        if (!head) continue;
        const gap = head.getBoundingClientRect().top - secs[i - 1].getBoundingClientRect().bottom;
        if (gap < 48) tight.push(`${secs[i].id || secs[i].className} ${Math.round(gap)}px`);
      }
      return {
        tight,
        overflow: document.documentElement.scrollWidth - vw,
        sticking,
        clipped,
        small,
        navlinks: visible('.navlinks'),
        toggle: visible('.nav-toggle'),
        h1: visible('h1'),
        ctas: visible('.hero-ctas .btn-primary') && visible('.hero-ctas .btn-ghost'),
        cards: document.querySelectorAll('.landing-bag-card').length,
        cardsVisible: visible('.landing-bag-card'),
        codeCard: visible('.code-card'),
        footer: visible('footer'),
        sectionHeads: Array.from(document.querySelectorAll('.section-head h2')).every((h) => h.getBoundingClientRect().width > 0),
      };
    });

    if (layout.overflow > 0) fail(`horizontal page overflow ${layout.overflow}px`);
    if (layout.tight.length) fail(`section headings without space above: ${layout.tight.join(' | ')}`);
    if (layout.sticking.length) fail(`elements outside viewport: ${layout.sticking.slice(0, 5).join(', ')}`);
    if (layout.clipped.length) fail(`clipped text: ${layout.clipped.join(' | ')}`);
    if (layout.small.length) fail(`touch targets < 24px: ${layout.small.join(' | ')}`);
    const mobile = width <= 840;
    if (mobile && (layout.navlinks || !layout.toggle)) fail('mobile: expected menu button, not inline links');
    if (!mobile && (!layout.navlinks || layout.toggle)) fail('desktop: expected inline links, not menu button');
    for (const k of ['h1', 'ctas', 'codeCard', 'footer', 'sectionHeads']) if (!layout[k]) fail(`${k} not visible`);
    if (data === 'sample' && (layout.cards !== 3 || !layout.cardsVisible)) fail(`featured cards: ${layout.cards} rendered`);
    if (data === 'unconfigured' && !(await page.getByText(/isn.t connected to the protocol database/).isVisible())) fail('no "not connected" message');

    if (mobile) {
      await page.getByRole('button', { name: 'Navigation menu' }).click();
      const open = await page.locator('#mobile-nav').isVisible();
      const firstLink = await page.locator('#mobile-nav a').first().isVisible();
      const focused = await page.evaluate(() => document.activeElement?.closest('#mobile-nav') !== null);
      await page.keyboard.press('Escape');
      const closed = !(await page.locator('#mobile-nav').isVisible());
      const focusBack = await page.evaluate(() => document.activeElement?.classList.contains('nav-toggle'));
      if (!open || !firstLink) fail('mobile menu did not open with its links');
      if (!focused) fail('focus did not move into the mobile menu');
      if (!closed) fail('Escape did not close the mobile menu');
      if (!focusBack) fail('focus did not return to the menu button');
    }

    if (data === 'sample') {
      await page.addScriptTag({ content: AXE });
      const axe = await page.evaluate(async () => {
        const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' ; ')}`);
      });
      if (axe.length) fail(`axe: ${axe.join(' || ')}`);
    }

    await page.screenshot({ path: join(OUT, `${width}x${height}-${data}.png`), fullPage: true });
    report.push(r);
    console.log(`${r.problems.length ? 'FAIL' : 'OK  '} ${r.viewport} ${data}${r.problems.length ? '\n     - ' + r.problems.join('\n     - ') : ''}`);
    await page.close();
  }
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(failures ? `\n${failures} problem(s).` : '\nAll viewport checks passed.');
process.exit(failures ? 1 : 0);
