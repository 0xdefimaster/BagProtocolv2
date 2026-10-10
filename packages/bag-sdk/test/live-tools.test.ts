import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { BAG_V1_CHAINS, hashBag, normalizeBag, parseBag, registryStrategyId, STRATEGY_REGISTRY_DEPLOYMENTS } from '../src';
import { verifyRegistry, safeError, type RegistryReadClient } from '../examples/verify-registry';
import { checkLiveReport, isNetworkBlock } from '../examples/live-compile';

// -----------------------------------------------------------------------------
// The live commands' LOGIC, on a mocked network. These tests are NOT live
// verification: they prove how the commands judge an answer, not that the
// chain or LI.FI answered. Live runs are the commands themselves (README).
// -----------------------------------------------------------------------------

const FEETEST_PATH = fileURLToPath(new URL('./fixtures/feetest.v1.bag.json', import.meta.url));
const feetestText = () => readFileSync(FEETEST_PATH, 'utf8');
/** feetest v1 as BAG serves it; registered on Robinhood Chain (tx 0xe5c105c3…80c7). */
const FEETEST_HASH = '0x089fc9ba2754f4180658c5f809986e606f8ec63d55430e3ab33da2046210a4fa';
const FEETEST_UUID = '170e5e72-d5d5-4f16-b180-24b3dc525b37';
const FEETEST_CREATOR = '0x49Dadd8212128bDf6752351bf70f6A5D8b73FE46';
const FEETEST_REGISTRY_ID = '0x2518fc2191cd250b9dea7fec6c4e8a6c31e897881255cd5ef0af4dbe085f0326';
const REGISTRY = '0x907cc27d644c8ea1c24b8320ad09ecf2819209a8';
const ZERO = '0x' + '0'.repeat(40);
const ZERO32 = '0x' + '0'.repeat(64);

describe('StrategyRegistry deployment', () => {
  it('Robinhood Chain: full address, chain id from the chain table, deployment block', () => {
    expect(STRATEGY_REGISTRY_DEPLOYMENTS.robinhood).toEqual({ chainId: BAG_V1_CHAINS.robinhood, address: REGISTRY, deployedAtBlock: 85332074 });
    expect(STRATEGY_REGISTRY_DEPLOYMENTS.robinhood!.chainId).toBe(4663);
    expect(STRATEGY_REGISTRY_DEPLOYMENTS.robinhood!.address).toMatch(/^0x[0-9a-f]{40}$/);
    // No registry is claimed where none was deployed.
    expect(Object.keys(STRATEGY_REGISTRY_DEPLOYMENTS)).toEqual(['robinhood']);
    expect(Object.isFrozen(STRATEGY_REGISTRY_DEPLOYMENTS)).toBe(true);
  });

  it('feetest v1 (as served) hashes to the committed definitionHash; its registry id is creator-bound', () => {
    const parsed = parseBag(feetestText());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.bag.ref).toMatchObject({ strategyId: FEETEST_UUID, version: 1 });
    expect(hashBag(normalizeBag(parsed.bag))).toBe(FEETEST_HASH);
    expect(registryStrategyId(FEETEST_CREATOR, FEETEST_UUID)).toBe(FEETEST_REGISTRY_ID);
  });
});

/** A mocked RPC holding feetest v1 under FEETEST_CREATOR. */
function chain(overrides: Partial<{ chainId: number; code: Hex | undefined; hash: string; fail: unknown }> = {}): RegistryReadClient {
  const o = { chainId: 4663, code: '0x6080604052' as Hex | undefined, hash: FEETEST_HASH, ...overrides };
  return {
    getChainId: async () => {
      if (o.fail) throw o.fail;
      return o.chainId;
    },
    getCode: async () => o.code,
    readContract: async ({ functionName, args }) => {
      if (functionName === 'strategyOf') {
        const ours = String(args![0]).toLowerCase() === FEETEST_REGISTRY_ID;
        return { creator: ours ? FEETEST_CREATOR : ZERO, latestVersion: ours ? 1 : 0, forkOfStrategyId: ZERO32, forkOfVersion: 0 };
      }
      if (functionName === 'definitionHashOf') return o.hash;
      throw new Error(functionName);
    },
  };
}

const readText = async () => feetestText();

describe('verify-registry (mocked network: logic only, not live)', () => {
  it('PASS: right chain, contract code, feetest v1 committed by the expected creator', async () => {
    const r = await verifyRegistry({ source: 'feetest.bag.json', expectedCreator: FEETEST_CREATOR, client: chain(), readText });
    expect(r.verdict).toBe('PASS');
    expect(r.registry).toEqual({ chainId: 4663, address: REGISTRY });
    expect(r.checks.map((c) => c.name)).toEqual([
      'BAG_JSON_PARSES',
      'RPC_CHAIN_ID',
      'REGISTRY_HAS_CODE',
      'STATED_HASH_MATCHES',
      'REF_PRESENT',
      'STRATEGY_REGISTERED_BY_EXPECTED_CREATOR',
      'VERSION_REGISTERED',
      'DEFINITION_MATCHES_REGISTRY',
    ]);
  });

  it('FAIL: RPC on another chain, no contract code, another creator, or a different committed hash', async () => {
    expect((await verifyRegistry({ source: 'f', expectedCreator: FEETEST_CREATOR, client: chain({ chainId: 1 }), readText })).verdict).toBe('FAIL');
    expect((await verifyRegistry({ source: 'f', expectedCreator: FEETEST_CREATOR, client: chain({ code: '0x' }), readText })).verdict).toBe('FAIL');
    expect((await verifyRegistry({ source: 'f', expectedCreator: FEETEST_CREATOR, client: chain({ code: undefined }), readText })).verdict).toBe('FAIL');
    expect((await verifyRegistry({ source: 'f', expectedCreator: '0x' + '1'.repeat(40), client: chain(), readText })).verdict).toBe('FAIL');
    const tampered = await verifyRegistry({ source: 'f', expectedCreator: FEETEST_CREATOR, client: chain({ hash: '0x' + 'ab'.repeat(32) }), readText });
    expect(tampered.verdict).toBe('FAIL');
    expect(tampered.checks.find((c) => c.name === 'DEFINITION_MATCHES_REGISTRY')!.ok).toBe(false);
  });

  it('BLOCKED, not FAIL, when the RPC or the bag.json URL is unreachable; the URL is never echoed', async () => {
    const httpError = Object.assign(new Error('HTTP request failed.\n\nStatus: 403\nURL: https://rpc.example/secret-key'), { name: 'HttpRequestError' });
    const r = await verifyRegistry({ source: 'f', expectedCreator: FEETEST_CREATOR, client: chain({ fail: httpError }), readText });
    expect(r.verdict).toBe('BLOCKED');
    expect(r.blockedReason).toBe('RPC unreachable: HTTP request failed.');
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const u = await verifyRegistry({ source: 'https://bag.example/v/1', expectedCreator: FEETEST_CREATOR, client: chain(), fetch: refused });
    expect(u.verdict).toBe('BLOCKED');
    const notFound = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const n = await verifyRegistry({ source: 'https://bag.example/v/9', expectedCreator: FEETEST_CREATOR, client: chain(), fetch: notFound });
    expect(n.verdict).toBe('FAIL');
    expect(JSON.stringify(n)).not.toContain('bag.example');
  });

  it('safeError keeps the first line and strips URLs', () => {
    expect(safeError(new Error('fetchBag: https://x.example/k?key=1 answered 403.'))).toBe('fetchBag: <url> answered 403.');
    expect(safeError({ shortMessage: 'Request to wss://node/abc failed\nmore' })).toBe('Request to <url> failed');
  });
});

describe('live-compile judgement (mocked network: logic only, not live)', () => {
  const T = '0x' + '7'.repeat(40);
  const native = '0x' + '0'.repeat(40);
  const good = () => ({
    parse: 'ok',
    validate: 'ok',
    quote: { slippageBps: 100, legs: [{ token: '0xa', expectedOutRaw: '400', minOutRaw: '396' }] },
    approvals: [] as { token: string; spender: string; amountRaw: string }[],
    unsignedTransaction: { to: T, data: '0xdeadbeef00', value: '1000000000000000', chainId: 4663 },
  });
  const opts = { chainId: 4663, inputToken: native, amountRaw: BigInt('1000000000000000'), trustedTargets: [T], trustedSpenders: [] };

  it('a correct native purchase passes every check', () => {
    const checks = checkLiveReport(good(), opts);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toContain('NO_APPROVAL_FOR_NATIVE');
  });

  it('wrong value, untrusted target, wrong chain, an approval on native, or minOut above expected fail', () => {
    const failed = (r: ReturnType<typeof good>, o = opts) => checkLiveReport(r, o).filter((c) => !c.ok).map((c) => c.name);
    expect(failed({ ...good(), unsignedTransaction: { ...good().unsignedTransaction, value: '0' } })).toEqual(['TX_VALUE']);
    expect(failed({ ...good(), unsignedTransaction: { ...good().unsignedTransaction, to: '0x' + '9'.repeat(40) } })).toEqual(['TX_TARGET_TRUSTED']);
    expect(failed({ ...good(), unsignedTransaction: { ...good().unsignedTransaction, chainId: 1 } })).toEqual(['TX_CHAIN_ID']);
    expect(failed({ ...good(), approvals: [{ token: '0xa', spender: T, amountRaw: '1' }] })).toEqual(['NO_APPROVAL_FOR_NATIVE']);
    expect(failed({ ...good(), quote: { slippageBps: 100, legs: [{ token: '0xa', expectedOutRaw: '400', minOutRaw: '401' }] } })).toEqual(['LEGS_MIN_OUTPUT']);
    // ERC-20 input: value must be 0.
    expect(failed(good(), { ...opts, inputToken: '0x' + 'c'.repeat(40) })).toEqual(['TX_VALUE']);
  });

  it('network refusals are BLOCKED; API answers and policy refusals are not', () => {
    expect(isNetworkBlock({ code: 'NETWORK_ERROR', message: 'fetch failed' })).toBe(true);
    expect(isNetworkBlock({ name: 'ContractFunctionExecutionError', message: 'x', cause: { name: 'HttpRequestError', message: 'HTTP request failed.' } })).toBe(true);
    expect(isNetworkBlock({ name: 'ComposeError', status: 403, message: 'Forbidden' })).toBe(true);
    expect(isNetworkBlock({ name: 'ComposeError', status: 400, kind: 'no_route_error', message: 'no route' })).toBe(false);
    expect(isNetworkBlock(new Error('Composer transaction targets 0x9999 which is not in allowedTransactionTargets.'))).toBe(false);
  });
});

describe('the live commands are read-only and never print a secret', () => {
  for (const name of ['verify-registry.ts', 'live-compile.ts']) {
    const text = readFileSync(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), 'utf8');
    it(name, () => {
      expect(text).not.toMatch(/privateKey|privateKeyToAccount|createWalletClient|signTransaction|signMessage|sendTransaction|sendRawTransaction|eth_send/);
      for (const line of text.split('\n').filter((l) => /console\.(log|error)/.test(l))) expect(line).not.toMatch(/\bapiKey\b|\brpcUrl\b|process\.env/);
    });
  }
});
