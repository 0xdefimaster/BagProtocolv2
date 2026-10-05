import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress } from 'viem';

// Every mixed-case address in lib/config must be a valid EIP-55 checksum. viem rejects a wrong checksum outright
// ("Address must match its checksum counterpart"): four hand-typed Uniswap addresses on Robinhood Chain did, which
// made every QuoterV2 call — and so every fee attestation — fail. All-lowercase addresses are accepted unchanged.

const dir = join(process.cwd(), 'lib/config');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

describe('lib/config addresses', () => {
  it.each(files)('%s: every mixed-case address has a valid checksum', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    const bad = [...src.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)]
      .map((m) => m[0])
      .filter((a) => a !== a.toLowerCase() && !isAddress(a, { strict: true }))
      .map((a) => `${a} → ${getAddress(a.toLowerCase())}`);
    expect(bad).toEqual([]);
  });

  it('the Robinhood Chain Uniswap v3 addresses are accepted by viem', async () => {
    const c = await import('@/lib/config/robinhood-chain');
    for (const a of [c.UNISWAP_ROUTER_ADDRESS!, c.UNISWAP_UNIVERSAL_ROUTER_ADDRESS, c.UNISWAP_V3_FACTORY_ADDRESS, c.UNISWAP_QUOTER_V2_ADDRESS]) {
      expect(isAddress(a, { strict: true })).toBe(true);
    }
  });
});
