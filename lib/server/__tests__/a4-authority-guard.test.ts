import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// -----------------------------------------------------------------------------
// Accounting V2 / A4 — lock that the legacy share world can never become a
// position source again (docs/ACCOUNTING_V2_DESIGN.md §4.1). The columns
// still exist; this test fails the build if position value / P&L code starts
// reading them, or if NAV-per-share valuation spreads beyond the one place
// that still needs it (the performance-fee basis of a redemption).
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Every file that computes or displays a user's position value, cost basis or P&L. */
const POSITION_SOURCES = [
  'lib/domain/basket-protocol/accounting/position-value.ts',
  'lib/domain/basket-protocol/accounting/position-pnl.ts',
  'lib/server/position-valuation.ts',
  'app/api/portfolio/positions/route.ts',
  'app/api/bags/[id]/redeem-preview/route.ts',
  'app/api/users/me/positions/[strategyId]/pnl/route.ts',
  'app/dashboard/portfolio/page.tsx',
  'components/bags/MyBagPosition.tsx',
  'components/app/RedeemPreviewModal.tsx',
];

/** Anything that reads the legacy share world. */
const LEGACY_SHARE_SOURCES =
  /sharesRaw|shares_raw|shareDecimals|share_decimals|getRedeemQuote|getSharePrice|getShareSupply|getBagNav|getInvestorPosition|listInvestorPositionsForUser|cost_basis_quote|bag_share_state|bag_investor_positions|bag-share-state-repo|bag-investor-position-repo/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

describe('A4: shares are not a position source', () => {
  it.each(POSITION_SOURCES)('%s does not read shares, NAV per share or the legacy position row', (file) => {
    const hits = read(file)
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text) && LEGACY_SHARE_SOURCES.test(l.text));
    expect(hits).toEqual([]);
  });

  it('NAV-per-share valuation (getRedeemQuote / getSharePrice) is used only for the redemption fee basis', () => {
    const users = ['app', 'lib', 'components', 'hooks']
      .flatMap((d) => walk(d))
      .filter((f) => /\b(getRedeemQuote|getSharePrice)\b/.test(read(f)))
      .sort();
    expect(users).toEqual(['lib/domain/basket-protocol/shares/shares.ts', 'lib/server/redeem-execution.ts']);
  });

  it('in the sell path, getRedeemQuote is reached only on the performance-fee branch', () => {
    const src = read('lib/server/redeem-execution.ts');
    const call = src.indexOf('getRedeemQuote(');
    const feeBranch = src.lastIndexOf('if (feeBps > 0) {', call);
    const elseBranch = src.indexOf('} else {', feeBranch);
    expect(call).toBeGreaterThan(-1);
    expect(feeBranch).toBeGreaterThan(-1);
    expect(call).toBeLessThan(elseBranch);
    expect(src.indexOf('getRedeemQuote(', call + 1)).toBe(-1);
  });
});
