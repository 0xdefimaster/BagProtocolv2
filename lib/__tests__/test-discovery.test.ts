import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { TEST_ROOTS } from '../../vitest.config';

// Guards the unit-test globs: a test file that `npm test` would never pick up fails here instead of passing silently.

const REPO = path.resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.netlify', 'artifacts', 'cache', 'typechain-types', 'coverage', 'dist']);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) testFiles(path.join(dir, entry.name), out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(path.relative(REPO, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

describe('unit-test discovery', () => {
  it('include covers .ts and .tsx tests under every test root', () => {
    const include = (config as { test: { include: string[] } }).test.include;
    for (const root of TEST_ROOTS) {
      expect(include).toContain(`${root}/**/*.test.ts`);
      expect(include).toContain(`${root}/**/*.test.tsx`);
    }
  });

  it('every test file lives under a test root (or is a Hardhat contract test)', () => {
    const stray = testFiles(REPO).filter(
      (f) => !f.startsWith('contracts/test/') && !TEST_ROOTS.some((root) => f.startsWith(`${root}/`))
    );
    expect(stray).toEqual([]);
  });
});
