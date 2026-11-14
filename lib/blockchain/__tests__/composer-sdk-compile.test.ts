import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { buildComposerPurchase } from '../lifi-composer-adapter';
import {
  crossCheckComposerPurchase,
  recordingFetch,
  replayFetch,
  reviewedComposerDeployment,
  sdkComposerCompileMode,
  type SdkCompileCheckInput,
} from '../composer-sdk-compile';
import { composeResponse } from './composer-fixtures';

// -----------------------------------------------------------------------------
// M3a: the app's Composer compile cross-checked by the BAG SDK against the REVIEWED deployment pin. The Composer
// API is faked at the HTTP boundary; the real legacy adapter and the real SDK adapter build and parse the requests.
// Adversarial cases: an API response naming a target or approval spender outside the wallet's independently
// resolved Composer account, a response the legacy adapter accepts but the SDK's checks refuse, and a request the
// SDK would build differently from the legacy one.
// -----------------------------------------------------------------------------

const CHAIN_ID = 8453;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SIGNER = '0x5555555555555555555555555555555555555555';
const FACTORY = '0xf0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';
const PROXY = '0x9999999999999999999999999999999999999999';
const EVIL = '0xe0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0';
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FACTORY_CODE = '0x6080604052';
const ENV = { COMPOSER_FACTORY_BASE: FACTORY, COMPOSER_FACTORY_CODE_HASH_BASE: keccak256(FACTORY_CODE) };

/** A chain where FACTORY has the pinned runtime and predicts PROXY for SIGNER; `proxyDeployed` picks first use or not. */
function chainClient(opts: { proxyDeployed?: boolean; factoryCode?: string } = {}) {
  return {
    getChainId: async () => CHAIN_ID,
    getBlockNumber: async () => BigInt(100),
    getBlock: async () => ({ hash: `0x${'12'.repeat(32)}` as `0x${string}` }),
    getCode: async ({ address }: { address: string }) =>
      (address.toLowerCase() === FACTORY ? opts.factoryCode ?? FACTORY_CODE : opts.proxyDeployed ? '0x6001' : '0x') as `0x${string}`,
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'predictProxyAddress' ? PROXY : functionName === 'owner' ? SIGNER : FACTORY),
  };
}

const wireOut = (token: string, expected: string, min: string | null) => ({
  role: 'terminal',
  owner: SIGNER,
  delivery: { when: 'now' },
  resource: { kind: 'erc20', token, chainId: CHAIN_ID },
  amount: { estimate: { basis: 'simulated', value: expected }, ...(min !== null ? { minimum: { basis: 'op', value: min } } : {}) },
});

interface Wire {
  to?: string;
  spender?: string;
  userProxy?: string;
  value?: string;
  minA?: string | null;
}
/** The Composer API's compile answer for the two-leg purchase below (first use: the target is the factory). */
function composeBody(w: Wire = {}) {
  return {
    data: {
      outputs: { 'swap_0.amountOut': wireOut(A, '4000', w.minA === undefined ? '3960' : w.minA), 'swap_1.amountOut': wireOut(B, '6000', '5940') },
      transactionRequest: { to: w.to ?? FACTORY, chainId: CHAIN_ID, data: '0xdeadbeefcafe', value: w.value ?? '0', gasLimit: '500000' },
      userProxy: w.userProxy ?? PROXY,
      approvals: [{ token: USDC, spender: w.spender ?? PROXY, amount: '10000000' }],
      priceImpact: { inputValueUsd: 10, outputValueUsd: 9.99, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
      fees: [],
    },
  };
}

const LEGS = [
  { token: A, legBps: 4000, targetInputRaw: BigInt(4_000_000) },
  { token: B, legBps: 6000, targetInputRaw: BigInt(6_000_000) },
];

/** Runs the REAL legacy compile through a recording fetch over a fake API, then returns the cross-check input. */
async function legacyCompile(w: Wire = {}, over: Partial<SdkCompileCheckInput> = {}): Promise<SdkCompileCheckInput> {
  const api = vi.fn(async () => composeResponse(composeBody(w))) as unknown as typeof fetch;
  const rec = recordingFetch(api);
  const legacy = await buildComposerPurchase({
    chain: 'base',
    inputTokenAddress: USDC,
    inputAmountRaw: '10000000',
    legs: LEGS.map((l, i) => ({ address: l.token, weightBps: l.legBps, symbol: `T${i}` })),
    signerAddress: SIGNER,
    slippageBps: 100,
    apiKey: 'test-key',
    fetchImpl: rec.fetch,
  });
  return {
    chain: 'base',
    chainId: CHAIN_ID,
    inputKind: 'erc20',
    inputToken: USDC,
    signer: SIGNER,
    swapAmountRaw: BigInt(10_000_000),
    legs: LEGS,
    slippageBps: 100,
    apiKey: 'test-key',
    legacy,
    exchanges: rec.exchanges,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('mode and reviewed deployment', () => {
  it('BAG_SDK_COMPOSER_COMPILE defaults to off; only shadow and on switch it', () => {
    expect(sdkComposerCompileMode({})).toBe('off');
    expect(sdkComposerCompileMode({ BAG_SDK_COMPOSER_COMPILE: 'shadow' })).toBe('shadow');
    expect(sdkComposerCompileMode({ BAG_SDK_COMPOSER_COMPILE: ' ON ' })).toBe('on');
    expect(sdkComposerCompileMode({ BAG_SDK_COMPOSER_COMPILE: 'enforce' })).toBe('off');
  });

  it('the deployment comes only from the chain\'s own reviewed pin', () => {
    expect(reviewedComposerDeployment('base', CHAIN_ID, ENV)).toEqual({ chainId: CHAIN_ID, factory: FACTORY, factoryCodeHash: keccak256(FACTORY_CODE) });
    expect(reviewedComposerDeployment('arbitrum', 42161, ENV)).toBeNull();
    expect(reviewedComposerDeployment('base', CHAIN_ID, { ...ENV, COMPOSER_FACTORY_CODE_HASH_BASE: '0x12' })).toBeNull();
    expect(reviewedComposerDeployment('base', CHAIN_ID, { COMPOSER_FACTORY_BASE: FACTORY })).toBeNull();
  });
});

describe('record / replay', () => {
  it('the recording fetch hands the legacy caller an intact response', async () => {
    const rec = recordingFetch((async () => new Response('{"a":1}', { status: 200, headers: { 'x-v': '1' } })) as typeof fetch);
    const res = await rec.fetch('https://x.test/compose', { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ a: 1 });
    expect(res.headers.get('x-v')).toBe('1');
    expect(rec.exchanges).toEqual([expect.objectContaining({ url: 'https://x.test/compose', method: 'POST', body: '{}', status: 200, responseText: '{"a":1}' })]);
  });

  it('the replay refuses a different URL, an extra request, or a different program', async () => {
    const x = [{ url: 'https://x.test/compose', method: 'POST', body: '{"flow":{"id":"a","n":[1]},"run":{"s":1}}', status: 200, statusText: '', headers: [] as [string, string][], responseText: '{}' }];
    await expect(replayFetch(x)('https://y.test/compose', { method: 'POST', body: x[0].body })).rejects.toThrow(/URL/);
    const once = replayFetch(x);
    await once('https://x.test/compose', { method: 'POST', body: '{"flow":{"id":"b","n":[1]},"run":{"s":1}}' }); // only the flow id differs
    await expect(once('https://x.test/compose', { method: 'POST', body: x[0].body })).rejects.toThrow(/EXTRA_REQUEST/);
    await expect(replayFetch(x)('https://x.test/compose', { method: 'POST', body: '{"flow":{"id":"a","n":[2]},"run":{"s":1}}' })).rejects.toThrow(/PROGRAM/);
  });
});

describe('crossCheckComposerPurchase', () => {
  it('MATCH: the SDK compiles the same request and the same transaction, approvals and per-leg minimums (first use)', async () => {
    expect(await crossCheckComposerPurchase(await legacyCompile(), { env: ENV, client: chainClient() })).toEqual({ verdict: 'MATCH' });
  });

  it('MATCH with a deployed proxy: the target is the proxy', async () => {
    expect(await crossCheckComposerPurchase(await legacyCompile({ to: PROXY }), { env: ENV, client: chainClient({ proxyDeployed: true }) })).toEqual({ verdict: 'MATCH' });
  });

  it('MATCH when the buyer accepted a price-impact limit (both sides send it)', async () => {
    // Re-record with the limit on the legacy side too.
    const api = vi.fn(async () => composeResponse(composeBody())) as unknown as typeof fetch;
    const rec = recordingFetch(api);
    const legacy = await buildComposerPurchase({
      chain: 'base', inputTokenAddress: USDC, inputAmountRaw: '10000000', legs: LEGS.map((l, i) => ({ address: l.token, weightBps: l.legBps, symbol: `T${i}` })),
      signerAddress: SIGNER, slippageBps: 100, apiKey: 'test-key', maxPriceImpactBps: 250, fetchImpl: rec.fetch,
    });
    const input = { ...(await legacyCompile()), legacy, exchanges: rec.exchanges, maxPriceImpactBps: 250 };
    expect(await crossCheckComposerPurchase(input, { env: ENV, client: chainClient() })).toEqual({ verdict: 'MATCH' });
    // The SDK stating a different limit than the one sent is a different program.
    expect(await crossCheckComposerPurchase({ ...input, maxPriceImpactBps: 300 }, { env: ENV, client: chainClient() })).toEqual({ verdict: 'MISMATCH', reasons: ['REQUEST_PROGRAM'] });
  });

  describe('adversarial Composer responses the legacy adapter accepts', () => {
    it('a transaction target that is not the wallet\'s resolved account', async () => {
      const input = await legacyCompile({ to: EVIL });
      expect(input.legacy.transactionRequest.to).toBe(EVIL); // what the app would have handed to the wallet
      expect(await crossCheckComposerPurchase(input, { env: ENV, client: chainClient() })).toEqual({ verdict: 'REFUSED', code: 'ACCOUNT_PROXY_MISMATCH' });
    });

    it('the deployed proxy\'s address as target before it exists (first use must go through the factory)', async () => {
      expect(await crossCheckComposerPurchase(await legacyCompile({ to: PROXY }), { env: ENV, client: chainClient() })).toEqual({ verdict: 'REFUSED', code: 'ACCOUNT_PROXY_MISMATCH' });
    });

    it('an approval spender that is not the resolved proxy', async () => {
      const input = await legacyCompile({ spender: EVIL });
      expect(input.legacy.approvals[0].spender).toBe(EVIL);
      expect(await crossCheckComposerPurchase(input, { env: ENV, client: chainClient() })).toEqual({ verdict: 'REFUSED', code: 'ACCOUNT_PROXY_MISMATCH' });
    });

    it('a user proxy that is not the one the pinned factory predicts', async () => {
      expect(await crossCheckComposerPurchase(await legacyCompile({ userProxy: EVIL }), { env: ENV, client: chainClient() })).toEqual({ verdict: 'REFUSED', code: 'ACCOUNT_PROXY_MISMATCH' });
    });

    it('a leg with no enforced minimum (unbounded swap)', async () => {
      const input = await legacyCompile({ minA: null });
      expect(await crossCheckComposerPurchase(input, { env: ENV, client: chainClient() })).toEqual({ verdict: 'REFUSED', code: 'OUTPUT_INVALID' });
    });

    it('a leg minimum below the configured slippage', async () => {
      expect(await crossCheckComposerPurchase(await legacyCompile({ minA: '1' }), { env: ENV, client: chainClient() })).toMatchObject({ verdict: 'REFUSED' });
    });
  });

  it('a factory whose live runtime is not the pinned one refuses before trusting anything', async () => {
    expect(await crossCheckComposerPurchase(await legacyCompile(), { env: ENV, client: chainClient({ factoryCode: '0x60016002' }) })).toEqual({ verdict: 'REFUSED', code: 'ACCOUNT_DEPLOYMENT_MISMATCH' });
  });

  it('a plan the SDK would send differently from the legacy request (other legs) is a MISMATCH, never a second call', async () => {
    const input = await legacyCompile({}, { legs: [{ ...LEGS[0], legBps: 4100 }, { ...LEGS[1], legBps: 5900 }] });
    expect(await crossCheckComposerPurchase(input, { env: ENV, client: chainClient() })).toEqual({ verdict: 'MISMATCH', reasons: ['REQUEST_PROGRAM'] });
  });

  it('a legacy result that differs from the response it came from is a MISMATCH (byte comparison)', async () => {
    const input = await legacyCompile();
    const tampered = { ...input, legacy: { ...input.legacy, transactionRequest: { ...input.legacy.transactionRequest, data: '0xdeadbeefcaff' } } };
    expect(await crossCheckComposerPurchase(tampered, { env: ENV, client: chainClient() })).toEqual({ verdict: 'MISMATCH', reasons: ['TX_DATA'] });
  });

  it('no reviewed deployment for the chain: UNAVAILABLE (never a trust policy derived from the response)', async () => {
    expect(await crossCheckComposerPurchase(await legacyCompile(), { env: {}, client: chainClient() })).toEqual({ verdict: 'UNAVAILABLE', reason: 'NO_REVIEWED_DEPLOYMENT' });
  });

  it('an RPC failure while resolving the account is a refusal with a credential-safe code', async () => {
    const client = { ...chainClient(), getBlockNumber: async () => { throw new Error('https://rpc.example/secret-key timed out'); } };
    expect(await crossCheckComposerPurchase(await legacyCompile(), { env: ENV, client })).toEqual({ verdict: 'REFUSED', code: 'RPC_READ_FAILED' });
  });
});
