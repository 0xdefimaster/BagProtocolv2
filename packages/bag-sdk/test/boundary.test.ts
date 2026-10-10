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
const sources = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f.replace(/\\/g, '/'), text: readFileSync(join(SRC, f), 'utf8') }));
const core = sources.filter((s) => !s.file.startsWith('adapters/'));

describe('SDK dependency boundary', () => {
  it('imports only viem and its own modules', () => {
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const s of specifiers) {
        // The LI.FI adapter alone may import its optional peer, @lifi/composer-sdk.
        const lifi = file === 'adapters/lifi.ts' && s === '@lifi/composer-sdk';
        expect(s.startsWith('./') || (s.startsWith('../') && !s.startsWith('../../')) || s === 'viem' || lifi, `${file} imports ${s}`).toBe(true);
      }
    }
  });

  it('the strategy core has no transport: no fetch, and it never imports an adapter', () => {
    expect(core.length).toBeGreaterThan(5);
    for (const { file, text } of core) {
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      expect(text, file).not.toMatch(/from\s+['"]\.\/adapters/);
    }
  });

  it('no environment, Node-only API, endpoint or embedded key', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/process\.env|require\(|node:/);
      expect(text, file).not.toMatch(/https?:\/\//);
      expect(text, file).not.toMatch(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/); // no 32-byte literal (key or hash) in source
      expect(text, file).not.toMatch(/supabase|next\/|react|netlify/i);
      if (file !== 'adapters/lifi.ts') expect(text, file).not.toMatch(/@lifi/i);
    }
  });

  it('the v1 chain table is defined exactly once', () => {
    expect(BAG_V1_CHAINS).toEqual({ ethereum: 1, base: 8453, arbitrum: 42161, robinhood: 4663 });
    const definers = sources.filter(({ text }) => /\b(4663|42161|8453)\b/.test(text)).map((s) => s.file);
    expect(definers).toEqual(['chains.ts']);
  });

  it('the package declares viem as its only required dependency (@lifi/composer-sdk is an optional peer of the LI.FI adapter)', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(['@lifi/composer-sdk', 'viem']);
    expect(pkg.peerDependenciesMeta).toEqual({ '@lifi/composer-sdk': { optional: true } });
  });

  it('the SDK never signs or sends: no key handling, no signing or sending call', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/privateKey|privateKeyToAccount|signTransaction|signMessage|signTypedData|sendTransaction|sendRawTransaction|eth_send/);
    }
  });
});
