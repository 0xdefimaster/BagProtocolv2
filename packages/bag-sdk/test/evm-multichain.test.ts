import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import {
  ARBITRUM_PHASE1_REVIEWED_ASSETS, BASE_PHASE1_REVIEWED_ASSETS, DELIVERY_PROOF_SIGNATURE, NATIVE_TOKEN,
  compileBag, createAssetCapabilityRegistry, getChainProfile, hashBag, parseBag, screenPurchaseAssets,
  simulateBag, verifyPurchaseReceipt, type CompiledPurchase, type Hex, type PurchaseReceiptClient,
  type PurchaseReceiptLog, type SimulationClient,
} from '../src';
import { lifiComposer } from '../src/adapters/lifi';
import { ARBITRUM_PHASE1_MATRIX, simulationOutcome } from '../examples/base-phase1-check';

// Synthetic Composer/RPC fixtures. These tests are not live chain qualification.
const h = (c: string, n: number) => ('0x' + c.repeat(n)) as Hex;
const OWNER = h('1', 40), FACTORY = h('2', 40), PROXY = h('3', 40), OTHER = h('4', 40);
const TX = h('a', 64), BLOCK = h('b', 64);
const discriminator = keccak256(new TextEncoder().encode(DELIVERY_PROOF_SIGNATURE));
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');
const nativeAmount = BigInt(10) ** BigInt(15);

describe.each(['base', 'arbitrum'] as const)('%s SDK purchase pipeline', (chain) => {
  const p = getChainProfile(chain)!;
  const chainId = p.chainId;
  const usdc = p.settlementStablecoin!.address as Hex, weth = p.wrappedNative!.address as Hex;
  const assets = chain === 'base' ? BASE_PHASE1_REVIEWED_ASSETS : ARBITRUM_PHASE1_REVIEWED_ASSETS;
  const trust = { chainId, allowedTransactionTargets: [FACTORY], allowedApprovalSpenders: [PROXY] };
  function strategy(outputs: Hex[]) {
    const parsed = parseBag({ bagJson: 1, definition: {
      kind: 'STATIC_BASKET', chain, mutability: 'MUTABLE',
      assets: outputs.map(address => ({ chain, address, decimals: address === usdc ? 6 : 18, weightBps: 10000 / outputs.length })),
      rules: { weightBounds: { minBps: 100, maxBps: 10000 }, maxAssets: 10,
        minInvestment: { amount: '0', measuredAs: 'PAYMENT_TOKEN_AMOUNT' }, swapSlippageBps: 100,
        rebalance: { frequency: 'MANUAL', driftThresholdBps: 500 }, performanceFeeBps: 0, noRouteAssetPolicy: 'BLOCK' },
    } });
    if (!parsed.ok) throw new Error('Invalid fixture');
    return parsed.bag;
  }
  async function compile(input: Hex, outputs: Hex[], overrides: { target?: Hex; spender?: Hex; trustChain?: number; responseChain?: number } = {}) {
    const native = input === NATIVE_TOKEN;
    const amountRaw = native ? nativeAmount : BigInt(2_000_000);
    const responseChain = overrides.responseChain ?? chainId;
    const amount = { estimate: { basis: 'simulated', value: '1000' }, minimum: { basis: 'op', value: '990' } };
    const data = {
      outputs: Object.fromEntries(outputs.flatMap((token, i) => [
        [`swap_${i}.amountOut`, { role: 'consumed', consumedBy: `deliver_${i}`, resource: { kind: 'erc20', token, chainId: responseChain }, amount }],
        [`deliver_${i}.transferred`, { role: 'terminal', owner: OWNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token, chainId: responseChain }, amount }],
      ])),
      transactionRequest: { to: overrides.target ?? FACTORY, chainId: responseChain, data: '0xdeadbeef', value: native ? amountRaw.toString() : '0', gasLimit: '900000' },
      userProxy: PROXY,
      priceImpact: { inputValueUsd: 2, outputValueUsd: 1.998, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
      approvals: native ? [] : [{ token: input, spender: overrides.spender ?? PROXY, amount: amountRaw.toString(), transactionRequest: { to: input, data: '0x', value: '0' } }],
      fees: [],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof globalThis.fetch;
    return compileBag(strategy(outputs), { inputToken: input, amountRaw, signer: OWNER,
      inputTokenDecimals: native ? 18 : 6,
      tokens: outputs.map(address => ({ chain, address, decimals: address === usdc ? 6 : 18 })),
    }, { provider: lifiComposer({ apiKey: 'synthetic', baseUrl: 'https://composer.test', fetch, deliveryProof: true }),
      trust: { ...trust, chainId: overrides.trustChain ?? chainId } });
  }
  function receipt(c: CompiledPurchase, o: { chainId?: number; sender?: Hex; emitter?: Hex; delta?: bigint; missing?: boolean; to?: Hex } = {}): PurchaseReceiptClient {
    const logs: PurchaseReceiptLog[] = o.missing ? [] : c.quote.plan.legs.map((leg, i) => ({
      address: o.emitter ?? PROXY, topics: [h('e', 64)], logIndex: i, transactionHash: TX,
      blockHash: BLOCK, blockNumber: BigInt(100), removed: false,
      data: ('0x' + [word(discriminator), word(leg.token), word(OWNER), word(BigInt(0)), word(o.delta ?? BigInt(1000))].join('')) as Hex,
    }));
    const identity = { from: o.sender ?? OWNER, to: o.to ?? c.transaction.to, blockHash: BLOCK, blockNumber: BigInt(100) };
    return {
      getChainId: async () => o.chainId ?? chainId,
      getTransaction: async () => ({ ...identity, hash: TX, chainId, input: c.transaction.data, value: c.transaction.value }),
      getTransactionReceipt: async () => ({ ...identity, transactionHash: TX, status: 'success', logs }),
      getBlock: async () => ({ hash: BLOCK }),
      getBlockNumber: async () => BigInt(110),
    };
  }
  const verify = (c: CompiledPurchase, client: PurchaseReceiptClient) => verifyPurchaseReceipt(c, {
    client, transactionHash: TX, verification: 'DELIVERY_LOG',
    minimumReceived: c.quote.plan.legs.map(leg => ({ token: leg.token, amountRaw: BigInt(990) })),
  });

  it('keeps chain profiles immutable and does not reuse the Robinhood indexed reader', () => {
    expect(getChainProfile(chainId)).toBe(p);
    expect(Object.isFrozen(p.receipts)).toBe(true);
    expect(p.receipts).toEqual({ deliveryLog: true, singleTransactionBlock: false, indexedReader: null });
  });
  it('screens by chain AND address; native USDC is distinct from bridged USDC.e', () => {
    const registry = createAssetCapabilityRegistry(assets);
    expect(screenPurchaseAssets({ chainId, inputToken: usdc, outputTokens: [weth], registry }).ok).toBe(true);
    expect(screenPurchaseAssets({ chainId: 4663, inputToken: usdc, outputTokens: [weth], registry }).ok).toBe(false);
    expect(registry.lookup(chainId, '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8')).toBeNull();
  });
  it('binds a two-asset purchase to this chain and delivers both minima without native approval', async () => {
    const c = await compile(NATIVE_TOKEN as Hex, [weth, usdc]);
    expect(c.transaction.chainId).toBe(chainId);
    expect(c.transaction.value).toBe(nativeAmount);
    expect(c.approvals).toEqual([]);
    expect(c.quote.plan.legs.map(l => l.targetInputRaw)).toEqual([nativeAmount / BigInt(2), nativeAmount / BigInt(2)]);
    const r = await verify(c, receipt(c));
    expect(r).toMatchObject({ status: 'VERIFIED', chainId, transactionBinding: 'DIRECT', accounting: 'NOT_BAG_ACCOUNTED' });
    expect(r.outputs).toHaveLength(2);
    expect(r.outputs.every(output => output.satisfied)).toBe(true);
  });
  it('uses an exact USDC approval and simulates on the same chain', async () => {
    const c = await compile(usdc, [weth]);
    expect(c.approvals).toEqual([{ token: usdc, spender: PROXY, amountRaw: BigInt(2_000_000) }]);
    const call = vi.fn(async () => ({ data: '0x' as Hex }));
    const client: SimulationClient = { getChainId: async () => chainId, getCode: async () => '0x60',
      getBalance: async () => BigInt(10) ** BigInt(18), readContract: async () => BigInt(2_000_000), call };
    expect(await simulateBag(c, { client })).toEqual({ status: 'OK' });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER, to: FACTORY, value: BigInt(0) }));
    expect((await verify(c, receipt(c))).status).toBe('VERIFIED');
    await expect(simulateBag(c, { client: { ...client, getChainId: async () => 4663 } })).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  });
  it('rejects another chain policy, an untrusted target, and an untrusted spender', async () => {
    await expect(compile(usdc, [weth], { trustChain: chain === 'base' ? 42161 : 8453 })).rejects.toMatchObject({ code: 'TRUST_POLICY_INVALID' });
    await expect(compile(usdc, [weth], { target: OTHER })).rejects.toMatchObject({ code: 'UNTRUSTED_TARGET' });
    await expect(compile(usdc, [weth], { spender: OTHER })).rejects.toMatchObject({ code: 'UNTRUSTED_SPENDER' });
    await expect(compile(usdc, [weth], { responseChain: 4663 })).rejects.toBeDefined();
  });
  it('does not verify a changed sender, missing logs, low delivery or another chain', async () => {
    const c = await compile(NATIVE_TOKEN as Hex, [weth, usdc]);
    expect((await verify(c, receipt(c, { sender: OTHER }))).status).toBe('FAILED');
    expect((await verify(c, receipt(c, { missing: true }))).status).toBe('INDETERMINATE');
    expect((await verify(c, receipt(c, { delta: BigInt(989) }))).status).toBe('FAILED');
    expect((await verify(c, receipt(c, { chainId: 4663 }))).issues[0].code).toBe('RPC_CHAIN_MISMATCH');
    expect((await verify(c, receipt(c, { emitter: OTHER }))).status).not.toBe('VERIFIED');
  });
  it('does not claim a delegated call is bound without its trace', async () => {
    const c = await compile(usdc, [weth]);
    expect((await verify(c, receipt(c, { to: OWNER }))).issues[0].code).toBe('UNSUPPORTED_TRANSACTION_ENVELOPE');
  });
  it('includes chain identity in the strategy hash', () => {
    const bag = strategy([weth]);
    const otherChain: 'base' | 'arbitrum' = chain === 'base' ? 'arbitrum' : 'base';
    const other = { ...bag, definition: { ...bag.definition, chain: otherChain, assets: bag.definition.assets.map(a => ({ ...a, chain: otherChain })) } };
    expect(hashBag(bag)).not.toBe(hashBag(other));
  });
});

describe('read-only matrix evidence', () => {
  it('never calls an unexecuted swap a successful simulation', () => {
    for (const status of ['INSUFFICIENT_BALANCE', 'NEEDS_APPROVAL', 'APPROVAL_OVERRIDE_UNAVAILABLE']) expect(simulationOutcome(status)).toBe('INCOMPLETE');
    for (const status of ['REVERTED', 'INVALID_TARGET', 'QUOTE_EXPIRED', 'unknown']) expect(simulationOutcome(status)).toBe('FAIL');
    expect(simulationOutcome('OK_WITH_ASSUMED_APPROVALS')).toBe('PASS');
    expect(simulationOutcome('OK')).toBe('PASS');
  });
  it('uses only Arbitrum token addresses in the Arbitrum matrix', () => {
    const p = getChainProfile('arbitrum')!;
    const allowed = [NATIVE_TOKEN, p.wrappedNative!.address, p.settlementStablecoin!.address];
    for (const scenario of ARBITRUM_PHASE1_MATRIX) {
      expect(allowed).toContain(scenario.input);
      expect(allowed).toContain(scenario.output);
    }
  });
});
