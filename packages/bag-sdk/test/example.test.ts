import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { run } from '../examples/compile-purchase';
import { lifiComposer } from '../src/adapters/lifi';
import { registryStrategyId } from '../src';
import { EXTERNAL_BAG_PATH, EXTERNAL_DEFINITION_HASH, externalBagText } from './helpers';

// -----------------------------------------------------------------------------
// PR #2 acceptance: the external script (examples/compile-purchase.ts), with no
// BAG app code, takes a bag.json from a file or a URL and goes
// parse → validate → normalize → hash → verify → quote → simulate → compile,
// ending in an UNSIGNED Composer transaction. The real @lifi/composer-sdk
// builds the request; only the network is mocked (LI.FI's API and an RPC are
// not reachable from CI). A live run is the script's CLI, with your own key.
// -----------------------------------------------------------------------------

const A = '0xa0000000000000000000000000000000000000aa';
const B = '0xb0000000000000000000000000000000000000bb';
const USDG = '0x' + 'c'.repeat(40);
const SIGNER = '0x' + '5'.repeat(40);
const CREATOR = '0x' + '1'.repeat(40);
const REGISTRY = '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8' as Hex;
const STRATEGY = '33333333-3333-4333-8333-333333333333';
const ZERO32 = `0x${'0'.repeat(64)}`;

function composerFetch() {
  const wire = JSON.stringify({
    data: {
      outputs: {
        'swap_0.amountOut': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: A, chainId: 4663 }, amount: { estimate: { basis: 'simulated', value: '400' }, minimum: { basis: 'op', value: '396' } } },
        'swap_1.amountOut': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: B, chainId: 4663 }, amount: { estimate: { basis: 'simulated', value: '600' }, minimum: { basis: 'op', value: '594' } } },
      },
      transactionRequest: { to: '0x' + '7'.repeat(40), chainId: 4663, data: '0xdeadbeef', value: '0' },
      userProxy: '0x' + '8'.repeat(40),
      priceImpact: { inputValueUsd: 10, outputValueUsd: 9.99, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
      approvals: [],
      fees: [],
    },
  });
  return vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(wire), text: async () => wire })) as unknown as typeof fetch;
}

/** The caller's RPC: token decimals, balance, allowance, the registry, and eth_call. */
function rpc(hash: string) {
  return {
    getChainId: async () => 4663,
    getCode: async () => '0x6000',
    readContract: async ({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address?: string }) => {
      if (functionName === 'decimals') return address?.toLowerCase() === USDG ? 6 : 18;
      if (functionName === 'balanceOf') return BigInt(10_000_000);
      if (functionName === 'allowance') return BigInt(10_000_000);
      if (functionName === 'strategyOf') {
        const ours = String(args![0]).toLowerCase() === registryStrategyId(CREATOR, STRATEGY).toLowerCase();
        return { creator: ours ? CREATOR : '0x' + '0'.repeat(40), latestVersion: ours ? 1 : 0, forkOfStrategyId: ZERO32, forkOfVersion: 0 };
      }
      if (functionName === 'definitionHashOf') return hash;
      throw new Error(functionName);
    },
    call: async () => ({ data: '0x' }),
  };
}

describe('external script: bag.json → unsigned Composer transaction', () => {
  it('from a file that BAG has never stored', async () => {
    const report = await run({ source: EXTERNAL_BAG_PATH, inputToken: USDG, amountRaw: BigInt(10_000_000), signer: SIGNER, provider: lifiComposer({ apiKey: 'own-key', baseUrl: 'https://composer.test', fetch: composerFetch() }), allowedTransactionTargets: ['0x' + '7'.repeat(40)], allowedApprovalSpenders: [], client: rpc(EXTERNAL_DEFINITION_HASH) });
    expect(report.parse).toBe('ok');
    expect(report.validate).toBe('ok');
    expect(report.definitionHash).toBe(EXTERNAL_DEFINITION_HASH);
    expect(report.quote).toMatchObject({ provider: 'lifi-composer', accounting: 'NOT_BAG_ACCOUNTED', slippageBps: 100, maxPriceImpactBps: 500, priceImpactBps: 10 });
    expect(report.simulate).toEqual({ status: 'OK' });
    expect(report.unsignedTransaction).toEqual({ to: '0x' + '7'.repeat(40), data: '0xdeadbeef', value: '0', chainId: 4663 });
  });

  it('from a URL, with registry verification against the expected creator', async () => {
    const withRef = JSON.stringify({ ...JSON.parse(externalBagText()), ref: { strategyId: STRATEGY, version: 1, parentVersion: null, createdAt: '2026-10-06T00:00:00Z' } });
    const fetchBagJson = (async () => new Response(withRef, { status: 200 })) as unknown as typeof fetch;
    const report = await run({
      source: 'https://example.org/hand.bag.json', fetch: fetchBagJson,
      inputToken: USDG, amountRaw: BigInt(10_000_000), signer: SIGNER,
      provider: lifiComposer({ apiKey: 'own-key', baseUrl: 'https://composer.test', fetch: composerFetch() }), client: rpc(EXTERNAL_DEFINITION_HASH),
      allowedTransactionTargets: ['0x' + '7'.repeat(40)], allowedApprovalSpenders: [],
      registry: { address: REGISTRY, expectedCreator: CREATOR },
    });
    expect(report.verify).toBe('verified');
    expect(report.unsignedTransaction).toBeDefined();
  });

  it('stops at the first failing step and never reaches the provider', async () => {
    const fetchImpl = composerFetch();
    const broken = externalBagText().replace('"weightBps": 6000', '"weightBps": 5000');
    const report = await run({ source: 'mem', readText: async () => broken, inputToken: USDG, amountRaw: BigInt(10_000_000), signer: SIGNER, provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: fetchImpl }), allowedTransactionTargets: ['0x' + '7'.repeat(40)], allowedApprovalSpenders: [], client: rpc(EXTERNAL_DEFINITION_HASH) });
    expect(report.validate).toEqual([expect.objectContaining({ code: 'WEIGHTS_NOT_100' })]);
    expect(report.unsignedTransaction).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the script imports only the SDK, viem and Node built-ins (no BAG app code)', () => {
    const text = readFileSync(fileURLToPath(new URL('../examples/compile-purchase.ts', import.meta.url)), 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specifiers) expect(s === 'viem' || s.startsWith('node:') || s.startsWith('../src/'), s).toBe(true);
    expect(text).not.toMatch(/@\/|signTransaction|sendTransaction|privateKey/);
  });
});
