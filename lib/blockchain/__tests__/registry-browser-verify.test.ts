import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registryStrategyId, STRATEGY_REGISTRY_DEPLOYMENTS } from '@/packages/bag-sdk/src';
import { verifyRegistrationsInBrowser } from '../registry-browser-verify';

// The in-browser registry re-check (StrategyRegistryPanel), on the real feetest v1 document as BAG serves it.
// The RPC and the bag.json fetch are mocked: this checks the judgement, not the chain.

const FEETEST = readFileSync(fileURLToPath(new URL('../../../packages/bag-sdk/test/fixtures/feetest.v1.bag.json', import.meta.url)), 'utf8');
const BAG_ID = '170e5e72-d5d5-4f16-b180-24b3dc525b37';
const CREATOR = '0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46';
const HASH = '0x089fc9ba2754f4180658c5f809986e606f8ec63d55430e3ab33da2046210a4fa';
const ZERO = '0x' + '0'.repeat(40);
const ZERO32 = '0x' + '0'.repeat(64);
const REGISTRY = STRATEGY_REGISTRY_DEPLOYMENTS.robinhood!.address;

function chain(o: { chainId?: number; hash?: string; down?: boolean } = {}) {
  const reads: string[] = [];
  return {
    reads,
    getChainId: async () => {
      if (o.down) throw new Error('HTTP request failed.');
      return o.chainId ?? 4663;
    },
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
      reads.push(address.toLowerCase());
      if (functionName === 'strategyOf') {
        const ours = String(args![0]).toLowerCase() === registryStrategyId(CREATOR, BAG_ID).toLowerCase();
        return { creator: ours ? CREATOR : ZERO, latestVersion: ours ? 1 : 0, forkOfStrategyId: ZERO32, forkOfVersion: 0 };
      }
      if (functionName === 'definitionHashOf') return o.hash ?? HASH;
      throw new Error(functionName);
    },
  };
}
const served = (status = 200, body = FEETEST) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
const base = { bagId: BAG_ID, chain: 'robinhood', creatorWallet: CREATOR, serverRegistryAddress: REGISTRY, versions: [1] };

describe('verifyRegistrationsInBrowser', () => {
  it('VERIFIED: the served document hashes to what the SDK-known registry holds for the creator', async () => {
    const client = chain();
    const fetchFn = served();
    const r = await verifyRegistrationsInBrowser({ ...base, client, fetchFn });
    expect(r).toEqual({ registry: REGISTRY, registryMismatch: false, checks: [{ version: 1, state: 'VERIFIED' }] });
    expect(fetchFn).toHaveBeenCalledWith(`/api/strategies/${BAG_ID}/versions/1`, expect.anything());
    // The read goes to the SDK's registry, never to an address BAG configured.
    expect(new Set(client.reads)).toEqual(new Set([REGISTRY.toLowerCase()]));
  });

  it('reads the SDK registry even when BAG is configured with another one, and flags the difference', async () => {
    const client = chain();
    const r = await verifyRegistrationsInBrowser({ ...base, serverRegistryAddress: '0x' + '9'.repeat(40), client, fetchFn: served() });
    expect(r.registryMismatch).toBe(true);
    expect(r.checks[0].state).toBe('VERIFIED');
    expect(new Set(client.reads)).toEqual(new Set([REGISTRY.toLowerCase()]));
  });

  it('MISMATCH: a different committed hash, another creator, or a tampered document', async () => {
    expect((await verifyRegistrationsInBrowser({ ...base, client: chain({ hash: '0x' + 'ab'.repeat(32) }), fetchFn: served() })).checks[0].state).toBe('MISMATCH');
    expect((await verifyRegistrationsInBrowser({ ...base, creatorWallet: '0x' + '1'.repeat(40), client: chain(), fetchFn: served() })).checks[0].state).toBe('MISMATCH');
    const tampered = FEETEST.replace('"weightBps":5000', '"weightBps":4000').replace('"weightBps":5000', '"weightBps":6000');
    expect((await verifyRegistrationsInBrowser({ ...base, client: chain(), fetchFn: served(200, tampered) })).checks[0].state).toBe('MISMATCH');
  });

  it('UNAVAILABLE, never VERIFIED, when the chain or the document cannot be read', async () => {
    expect((await verifyRegistrationsInBrowser({ ...base, client: chain({ down: true }), fetchFn: served() })).checks[0].state).toBe('UNAVAILABLE');
    expect((await verifyRegistrationsInBrowser({ ...base, client: chain({ chainId: 1 }), fetchFn: served() })).checks[0].state).toBe('UNAVAILABLE');
    expect((await verifyRegistrationsInBrowser({ ...base, client: chain(), fetchFn: served(404, '{}') })).checks[0].state).toBe('UNAVAILABLE');
    const none = await verifyRegistrationsInBrowser({ ...base, chain: 'base', client: chain(), fetchFn: served() });
    expect(none).toMatchObject({ registry: null, checks: [{ version: 1, state: 'UNAVAILABLE' }] });
  });
});
