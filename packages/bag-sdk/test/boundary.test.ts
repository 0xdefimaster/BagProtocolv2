import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BAG_V1_CHAINS } from '../src';

// -----------------------------------------------------------------------------
// The SDK is a third-party package: viem and standard Web APIs only. No BAG
// app alias, framework, database, environment variable, endpoint or secret.
// -----------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

describe('SDK dependency boundary', () => {
  it('imports only viem and its own modules', () => {
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const s of specifiers) expect(s.startsWith('./') || s === 'viem', `${file} imports ${s}`).toBe(true);
    }
  });

  it('no environment, Node-only API, endpoint or embedded key', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/process\.env|require\(|node:/);
      expect(text, file).not.toMatch(/https?:\/\//);
      expect(text, file).not.toMatch(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/); // no 32-byte literal (key or hash) in source
      expect(text, file).not.toMatch(/supabase|next\/|react|netlify|@lifi/i);
    }
  });

  it('the v1 chain table is defined exactly once', () => {
    expect(BAG_V1_CHAINS).toEqual({ ethereum: 1, base: 8453, arbitrum: 42161, robinhood: 4663 });
    const definers = sources.filter(({ text }) => /\b(4663|42161|8453)\b/.test(text)).map((s) => s.file);
    expect(definers).toEqual(['chains.ts']);
  });

  it('the package declares viem as its only dependency', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies)).toEqual(['viem']);
  });
});
