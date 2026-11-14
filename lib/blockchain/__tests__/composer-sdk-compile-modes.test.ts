import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import type { ExecutionStep } from '@/types/basket-protocol';
import { composeResponse } from './composer-fixtures';

// -----------------------------------------------------------------------------
// BAG_SDK_COMPOSER_COMPILE through the purchase entry point (buildPurchaseIntentSteps → tryBuildComposerSteps), with
// the Composer API faked at the HTTP boundary (global fetch) and the chain faked for the account resolution.
//   off    — unchanged: one Composer call, no chain reads, the legacy result.
//   shadow — one Composer call (recorded, replayed to the SDK), a log line, the legacy result either way.
//   on     — the legacy result only on MATCH, identical bytes; any other verdict fails closed.
// -----------------------------------------------------------------------------

vi.mock('@lifi/sdk', () => ({ getQuote: vi.fn(async () => { throw new Error('no per-asset quotes in this test'); }), HTTPError: class extends Error {} }));

const { buildPurchaseIntentSteps } = await import('../lifi-purchase-quote');

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

const client = {
  getChainId: vi.fn(async () => CHAIN_ID),
  getBlockNumber: vi.fn(async () => BigInt(100)),
  getBlock: vi.fn(async () => ({ hash: `0x${'12'.repeat(32)}` as `0x${string}` })),
  getCode: vi.fn(async ({ address }: { address: string }) => (address.toLowerCase() === FACTORY ? FACTORY_CODE : '0x') as `0x${string}`),
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === 'predictProxyAddress' ? PROXY : SIGNER)),
};

const wireOut = (token: string, expected: string, min: string) => ({
  role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token, chainId: CHAIN_ID },
  amount: { estimate: { basis: 'simulated', value: expected }, minimum: { basis: 'op', value: min } },
});
const body = (to = FACTORY, spender = PROXY) => ({
  data: {
    outputs: { 'swap_0.amountOut': wireOut(A, '4000', '3960'), 'swap_1.amountOut': wireOut(B, '6000', '5940') },
    transactionRequest: { to, chainId: CHAIN_ID, data: '0xdeadbeefcafe', value: '0', gasLimit: '500000' },
    userProxy: PROXY,
    approvals: [{ token: USDC, spender, amount: '10000000' }],
    priceImpact: { inputValueUsd: 10, outputValueUsd: 9.99, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
    fees: [],
  },
});

const api = vi.fn();
function step(token: string, amount: string, symbol: string): ExecutionStep {
  return {
    action: 'SWAP',
    targetSymbol: symbol,
    route: {
      inputAsset: { chain: 'base', address: USDC },
      inputAmountRaw: amount,
      outputAsset: { chain: 'base', address: token },
      targetValueRaw: amount,
      sourceChain: 'base',
      destinationChain: 'base',
    },
  } as ExecutionStep;
}
// Recipe order B, A: the Composer order (address-ascending) is A, B.
const STEPS = [step(B, '6000000', 'B'), step(A, '4000000', 'A')];
const run = (mode: 'off' | 'shadow' | 'on' | undefined, env: Record<string, string | undefined> = ENV) =>
  buildPurchaseIntentSteps(STEPS, SIGNER, 6, {
    apiKey: 'test-key',
    slippageBps: 100,
    resolveOutputDecimals: () => 18,
    sdkCompile: { ...(mode ? { mode } : {}), client, env },
  });

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async () => composeResponse(body()));
  vi.stubGlobal('fetch', api);
  for (const f of Object.values(client)) f.mockClear();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BAG_SDK_COMPOSER_COMPILE', () => {
  it('defaults to off: the legacy result, one Composer call, no chain reads, no log', async () => {
    const r = await run(undefined, {});
    expect(r.composerTransaction).toMatchObject({ to: FACTORY, data: '0xdeadbeefcafe', value: '0' });
    expect(api).toHaveBeenCalledTimes(1);
    expect(client.getChainId).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('on with MATCH: byte-identical to off (transaction, approvals, step records), still one Composer call', async () => {
    const off = await run('off');
    api.mockClear();
    const on = await run('on');
    expect(api).toHaveBeenCalledTimes(1);
    expect(on).toEqual(off);
    expect(info).toHaveBeenCalledWith('[sdk-compile-on] chain=base legs=2 verdict=MATCH');
  });

  it('shadow with MATCH: the legacy result and a privacy-safe log line (no wallet, amounts or calldata)', async () => {
    const r = await run('shadow');
    expect(r.composerTransaction?.to).toBe(FACTORY);
    expect(api).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toBe('[sdk-compile-shadow] chain=base legs=2 verdict=MATCH');
    expect(line).not.toContain(SIGNER.slice(2));
  });

  it('on refuses a Composer target outside the reviewed account: the purchase fails closed, nothing to sign', async () => {
    api.mockImplementation(async () => composeResponse(body(EVIL)));
    const r = await run('on');
    expect(r.composerTransaction ?? null).toBeNull();
    expect(r.allSwapsQuoted).toBe(false);
    expect(r.composerFallback).toMatchObject({ reason: 'UNAVAILABLE', kind: 'sdk_compile_check' });
    expect(r.steps.every((s) => s.status !== 'PENDING' || s.lifiStep === null)).toBe(true);
    expect(warn).toHaveBeenCalledWith('[sdk-compile-on] chain=base legs=2 verdict=REFUSED detail=ACCOUNT_PROXY_MISMATCH');
  });

  it('on refuses an approval spender outside the reviewed account', async () => {
    api.mockImplementation(async () => composeResponse(body(FACTORY, EVIL)));
    const r = await run('on');
    expect(r.composerTransaction ?? null).toBeNull();
    expect(r.composerFallback).toMatchObject({ kind: 'sdk_compile_check' });
  });

  it('on without a reviewed deployment for the chain fails closed (no trust derived from the response)', async () => {
    const r = await run('on', {});
    expect(r.composerTransaction ?? null).toBeNull();
    expect(r.composerFallback?.message).toMatch(/UNAVAILABLE: NO_REVIEWED_DEPLOYMENT/);
  });

  it('shadow keeps the legacy result on a refusal and only reports it', async () => {
    api.mockImplementation(async () => composeResponse(body(EVIL)));
    const r = await run('shadow');
    expect(r.composerTransaction?.to).toBe(EVIL);
    expect(warn).toHaveBeenCalledWith('[sdk-compile-shadow] chain=base legs=2 verdict=REFUSED detail=ACCOUNT_PROXY_MISMATCH');
  });

  it('a malformed Composer response is refused by the legacy path in every mode, before any cross-check', async () => {
    api.mockImplementation(async () => composeResponse({ data: { outputs: {}, userProxy: PROXY } }));
    for (const mode of ['off', 'shadow', 'on'] as const) {
      const r = await run(mode);
      expect(r.composerTransaction ?? null).toBeNull();
      expect(r.composerFallback?.reason).toBe('UNAVAILABLE');
    }
    expect(client.getChainId).not.toHaveBeenCalled();
  });
});
