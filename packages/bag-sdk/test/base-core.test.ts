import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters as enc, encodeFunctionResult, keccak256, keccak256 as k256 } from 'viem';
import {
  BASE_PHASE1_REVIEWED_ASSETS,
  CHAIN_PROFILES,
  DELIVERY_PROOF_SIGNATURE,
  NATIVE_TOKEN,
  compileBag,
  createAssetCapabilityRegistry,
  getChainProfile,
  getSdkErrorInfo,
  parseBag,
  screenPurchaseAssets,
  simulateBag,
  verifyPurchaseReceipt,
  type BagDocument,
  type CompiledPurchase,
  type Hex,
  type PurchaseReceiptClient,
  type PurchaseReceiptLog,
  type PurchaseReceiptTransaction,
  type PurchaseTransactionReceipt,
  type SimulationClient,
} from '../src';
import { inspectToken, type TokenInspectionClient } from '../src/adapters/evm';
import { lifiComposer } from '../src/adapters/lifi';

// -----------------------------------------------------------------------------
// Base (8453) Phase 1: standard EVM assets. Offline: every RPC and the LI.FI
// Composer API are scripted. The four Base Phase 1 assets are the starting
// TEST MATRIX, not the set of tokens the SDK supports. The live, read-only
// counterpart is examples/base-phase1-check.ts.
// -----------------------------------------------------------------------------

const BASE = 8453;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Hex;
const WETH = '0x4200000000000000000000000000000000000006' as Hex;
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' as Hex;
const hex = (digit: string, length: number) => ('0x' + digit.repeat(length)) as Hex;
const SIGNER = hex('5', 40);
const FACTORY = hex('7', 40); // stands for the pinned Composer factory (first-use target)
const PROXY = hex('8', 40);
const OTHER = hex('9', 40);
const HASH = hex('1', 64);
const BLOCK = hex('2', 64);
const TRUST = { chainId: BASE, allowedTransactionTargets: [FACTORY], allowedApprovalSpenders: [PROXY] } as const;
const DISCRIMINATOR = keccak256(new TextEncoder().encode(DELIVERY_PROOF_SIGNATURE));
const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
const DECIMALS: Record<string, number> = { [USDC]: 6, [WETH]: 18, [CBBTC]: 8 };

/** A single-asset Base strategy: buying it from `input` is the swap input → asset. */
function swapBag(asset: Hex): BagDocument {
  const r = parseBag({
    bagJson: 1,
    definition: {
      kind: 'STATIC_BASKET',
      chain: 'base',
      mutability: 'MUTABLE',
      assets: [{ chain: 'base', address: asset, decimals: DECIMALS[asset], weightBps: 10000 }],
      rules: {
        weightBounds: { minBps: 100, maxBps: 10000 },
        maxAssets: 10,
        minInvestment: { amount: '0', measuredAs: 'PAYMENT_TOKEN_AMOUNT' },
        swapSlippageBps: 100,
        rebalance: { frequency: 'MANUAL', driftThresholdBps: 500 },
        performanceFeeBps: 0,
        noRouteAssetPolicy: 'BLOCK',
      },
    },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
}

function composeFetch(data: Record<string, unknown>) {
  const wire = JSON.stringify({ data });
  return vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(wire), text: async () => wire })) as unknown as typeof fetch;
}

/** LI.FI Composer's compile answer for a one-leg delivery-proof purchase on Base. */
function composeData(input: Hex, output: Hex, amountRaw: bigint, o: { target?: Hex; spender?: Hex; chainId?: number } = {}) {
  const chainId = o.chainId ?? BASE;
  const amount = { estimate: { basis: 'simulated', value: '1000' }, minimum: { basis: 'op', value: '990' } };
  const native = input === NATIVE_TOKEN;
  return {
    outputs: {
      'swap_0.amountOut': { role: 'consumed', consumedBy: 'deliver_0', resource: { kind: 'erc20', token: output, chainId }, amount },
      'deliver_0.transferred': { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token: output, chainId }, amount },
    },
    transactionRequest: { to: o.target ?? FACTORY, chainId, data: '0xdeadbeef', value: native ? amountRaw.toString() : '0', gasLimit: '900000' },
    userProxy: PROXY,
    priceImpact: { inputValueUsd: 2, outputValueUsd: 1.998, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
    approvals: native ? [] : [{ token: input, spender: o.spender ?? PROXY, amount: amountRaw.toString(), transactionRequest: { to: input, data: '0x', value: '0' } }],
    fees: [],
  };
}

async function compile(input: Hex, output: Hex, amountRaw: bigint, o: Parameters<typeof composeData>[3] & { trust?: typeof TRUST | { chainId: number; allowedTransactionTargets: readonly string[]; allowedApprovalSpenders: readonly string[] } } = {}) {
  const provider = lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: composeFetch(composeData(input, output, amountRaw, o)), deliveryProof: true });
  return compileBag(
    swapBag(output),
    { inputToken: input, amountRaw, signer: SIGNER, inputTokenDecimals: input === NATIVE_TOKEN ? 18 : DECIMALS[input], tokens: [{ chain: 'base', address: output, decimals: DECIMALS[output] }] },
    { provider, trust: o.trust ?? TRUST }
  );
}

const SCENARIOS = [
  { name: 'ETH → USDC', input: NATIVE_TOKEN as Hex, output: USDC, amountRaw: BigInt(10) ** BigInt(15) },
  { name: 'USDC → WETH', input: USDC, output: WETH, amountRaw: BigInt(2_000_000) },
  { name: 'USDC → cbBTC', input: USDC, output: CBBTC, amountRaw: BigInt(2_000_000) },
  { name: 'WETH → USDC', input: WETH, output: USDC, amountRaw: BigInt(10) ** BigInt(14) },
] as const;

// ----------------------------- 1. chain profile ------------------------------

describe('Base chain profile', () => {
  it('records Base facts; receipts there need DELIVERY_LOG', () => {
    const p = getChainProfile('base')!;
    expect(p).toMatchObject({ chain: 'base', chainId: BASE, nativeCurrency: { symbol: 'ETH', decimals: 18 } });
    expect(p.wrappedNative).toEqual({ address: WETH, symbol: 'WETH', decimals: 18 });
    expect(p.settlementStablecoin).toEqual({ address: USDC, symbol: 'USDC', decimals: 6 });
    expect(p.receipts).toEqual({ deliveryLog: true, singleTransactionBlock: false, indexedReader: null });
    expect(getChainProfile(BASE)).toBe(p);
    expect(Object.isFrozen(p) && Object.isFrozen(p.receipts)).toBe(true);
  });

  it('leaves Robinhood as it was (its Nitro reader) and has no profile for unreviewed chains', () => {
    expect(getChainProfile('robinhood')?.receipts.indexedReader).toBe('ROBINHOOD_NITRO_TRANSACTION_INDEX');
    expect(getChainProfile('arbitrum')).toBeNull();
    expect(getChainProfile(1)).toBeNull();
    expect(Object.keys(CHAIN_PROFILES).sort()).toEqual(['base', 'robinhood']);
  });
});

// --------------------------- 2–3. token recognition -------------------------

type FakeToken = { code?: Hex; decimals?: number | Error; totalSupply?: bigint | Error; balanceOf?: bigint | Error; symbol?: unknown; name?: unknown };
function tokenChain(tokens: Record<string, FakeToken>, chainId = BASE): TokenInspectionClient {
  return {
    getChainId: async () => chainId,
    getCode: async ({ address }) => tokens[address.toLowerCase()]?.code,
    readContract: async ({ address, functionName }) => {
      const t = tokens[address.toLowerCase()] ?? {};
      const v = (t as Record<string, unknown>)[functionName];
      if (v === undefined || v instanceof Error) throw v ?? new Error('execution reverted');
      return v;
    },
  };
}
const erc20 = (decimals: number, symbol: string): FakeToken => ({ code: '0x6080' as Hex, decimals, totalSupply: BigInt(10) ** BigInt(24), balanceOf: BigInt(0), symbol, name: symbol });
const BASE_TOKENS = { [USDC]: erc20(6, 'USDC'), [WETH]: erc20(18, 'WETH'), [CBBTC]: erc20(8, 'cbBTC') };

describe('inspectToken: dynamic recognition by chain id + address', () => {
  it('recognises the Phase 1 matrix (and any other well-formed ERC-20) with metadata from the chain', async () => {
    const client = tokenChain({ ...BASE_TOKENS, [OTHER]: erc20(12, 'NEW') });
    expect(await inspectToken({ chainId: BASE, address: USDC, client })).toMatchObject({ kind: 'ERC20', decimals: 6, symbol: 'USDC' });
    expect(await inspectToken({ chainId: BASE, address: CBBTC.toUpperCase().replace('0X', '0x'), client })).toMatchObject({ kind: 'ERC20', address: CBBTC, decimals: 8, symbol: 'cbBTC' });
    // Not in any list: recognised all the same. Recognition is not permission (see screenPurchaseAssets).
    expect(await inspectToken({ chainId: BASE, address: OTHER, client })).toMatchObject({ kind: 'ERC20', decimals: 12, symbol: 'NEW' });
  });

  it('native ETH without any call; an EOA is NOT_A_CONTRACT; a contract without ERC-20 answers is NOT_ERC20', async () => {
    const client = tokenChain({ [OTHER]: { code: '0x60' as Hex, decimals: new Error('revert') } });
    expect(await inspectToken({ chainId: BASE, address: NATIVE_TOKEN, client })).toEqual({ kind: 'NATIVE', chainId: BASE, address: NATIVE_TOKEN, decimals: 18 });
    expect(await inspectToken({ chainId: BASE, address: SIGNER, client })).toMatchObject({ kind: 'NOT_A_CONTRACT' });
    expect(await inspectToken({ chainId: BASE, address: OTHER, client })).toMatchObject({ kind: 'NOT_ERC20', failed: ['decimals', 'totalSupply', 'balanceOf'] });
  });

  it('missing or bytes32 symbol is tolerated (null); absurd decimals are not', async () => {
    const client = tokenChain({ [OTHER]: { ...erc20(18, 'X'), symbol: new Error('bytes32'), name: undefined }, [PROXY]: { ...erc20(18, 'Y'), decimals: 77 } });
    expect(await inspectToken({ chainId: BASE, address: OTHER, client })).toMatchObject({ kind: 'ERC20', symbol: null, name: null });
    expect(await inspectToken({ chainId: BASE, address: PROXY, client })).toMatchObject({ kind: 'NOT_ERC20', failed: ['decimals'] });
  });

  it('refuses a client on another chain (chain detection) and a malformed address', async () => {
    await expect(inspectToken({ chainId: BASE, address: USDC, client: tokenChain(BASE_TOKENS, 4663) })).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    await expect(inspectToken({ chainId: BASE, address: '0x1234', client: tokenChain(BASE_TOKENS) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

// ------------------- asset capability: recognition ≠ permission --------------

describe('screenPurchaseAssets: reviewed classes, not hardcoded tokens', () => {
  const B20 = '0x000000000000000000000000000000000000b020' as Hex; // synthetic stand-ins, not real tokens
  const DSHARE = '0x000000000000000000000000000000000000d5a1' as Hex;
  const registry = createAssetCapabilityRegistry([
    ...BASE_PHASE1_REVIEWED_ASSETS,
    { chainId: BASE, address: B20, assetClass: 'RESTRICTED_TRANSFER', issuer: 'example issuer' },
    { chainId: BASE, address: DSHARE, assetClass: 'PERMISSIONED', issuer: 'example issuer' },
  ]);

  it.each(SCENARIOS)('$name passes with the reviewed Phase 1 set', ({ input, output }) => {
    expect(screenPurchaseAssets({ chainId: BASE, inputToken: input, outputTokens: [output], registry }).ok).toBe(true);
  });

  it('cbETH and wstETH (reviewed 2026-11-04) pass without opting in to unreviewed tokens', () => {
    const CBETH = '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22';
    const WSTETH = '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452';
    const r = screenPurchaseAssets({ chainId: BASE, inputToken: USDC, outputTokens: [CBETH.toUpperCase().replace('0X', '0x'), WSTETH], registry });
    expect(r).toMatchObject({ ok: true, decisions: [{}, { decision: 'ALLOW', assetClass: 'STANDARD_ERC20' }, { decision: 'ALLOW', assetClass: 'STANDARD_ERC20' }] });
    expect(registry.lookup(BASE, CBETH)?.issuer).toBe('Coinbase');
    expect(registry.lookup(BASE, WSTETH)?.issuer).toBe('Lido');
    // Same addresses on another chain are not reviewed there.
    expect(screenPurchaseAssets({ chainId: 4663, inputToken: USDC, outputTokens: [CBETH], registry }).ok).toBe(false);
  });

  it('the Base reviewed set is five distinct Base tokens, all STANDARD_ERC20', () => {
    expect(BASE_PHASE1_REVIEWED_ASSETS).toHaveLength(5);
    expect(new Set(BASE_PHASE1_REVIEWED_ASSETS.map((e) => e.address)).size).toBe(5);
    expect(BASE_PHASE1_REVIEWED_ASSETS.every((e) => e.chainId === BASE && e.assetClass === 'STANDARD_ERC20' && e.address === e.address.toLowerCase())).toBe(true);
  });

  it('an unreviewed ERC-20 is refused unless the caller opts in, and is still labelled UNREVIEWED', () => {
    expect(screenPurchaseAssets({ chainId: BASE, inputToken: USDC, outputTokens: [OTHER], registry })).toMatchObject({ ok: false, decisions: [{ decision: 'ALLOW' }, { decision: 'REFUSE', assetClass: 'UNREVIEWED' }] });
    expect(screenPurchaseAssets({ chainId: BASE, inputToken: USDC, outputTokens: [OTHER], registry, allowUnreviewed: true })).toMatchObject({ ok: true, decisions: [{}, { decision: 'ALLOW', assetClass: 'UNREVIEWED' }] });
  });

  it('restricted-transfer (B20-style) and permissioned (dShares-style) assets are refused even with opt-in', () => {
    for (const t of [B20, DSHARE]) {
      const s = screenPurchaseAssets({ chainId: BASE, inputToken: USDC, outputTokens: [t], registry, allowUnreviewed: true });
      expect(s.ok).toBe(false);
      expect(s.decisions[1].decision).toBe('REFUSE');
    }
  });

  it('entries are per chain: a Base review does not cover the same address on another chain', () => {
    expect(screenPurchaseAssets({ chainId: 4663, inputToken: USDC, outputTokens: [WETH], registry }).ok).toBe(false);
  });

  it('the registry rejects conflicting or malformed entries, and native ETH as an output', () => {
    expect(() => createAssetCapabilityRegistry([{ chainId: BASE, address: USDC, assetClass: 'STANDARD_ERC20' }, { chainId: BASE, address: USDC, assetClass: 'PERMISSIONED' }])).toThrow(/conflicting/);
    expect(() => createAssetCapabilityRegistry([{ chainId: BASE, address: '0x12', assetClass: 'STANDARD_ERC20' }])).toThrow(/invalid address/);
    expect(screenPurchaseAssets({ chainId: BASE, inputToken: USDC, outputTokens: [NATIVE_TOKEN], registry }).ok).toBe(false);
  });
});

// ------------------- 4–6. compile, balances/allowances, simulation -----------

function simChain(o: { chainId?: number; balance?: bigint; nativeBalance?: bigint; allowance?: bigint; targetCode?: Hex | undefined; revert?: string } = {}): SimulationClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getChainId: async () => o.chainId ?? BASE,
    getCode: async () => ('targetCode' in o ? o.targetCode : ('0x60' as Hex)),
    getBalance: async () => o.nativeBalance ?? BigInt(10) ** BigInt(18),
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? (o.balance ?? BigInt(10) ** BigInt(20)) : (o.allowance ?? BigInt(0))),
    call: async (args) => {
      calls.push(args);
      if (o.revert) throw new Error(o.revert);
      return { data: '0x' };
    },
  };
}

describe.each(SCENARIOS)('$name on Base', ({ input, output, amountRaw }) => {
  const native = input === NATIVE_TOKEN;

  it('compiles: one leg to the output, native as value / ERC-20 via an exact approval to the proxy, delivery proof on', async () => {
    const c = await compile(input, output, amountRaw);
    expect(c.quote.plan).toMatchObject({ chainId: BASE, inputKind: native ? 'native' : 'erc20', swapAmountRaw: amountRaw, kept: null });
    expect(c.quote.plan.legs).toEqual([{ token: output, targetInputRaw: amountRaw, legBps: 10000 }]);
    expect(c.transaction).toMatchObject({ to: FACTORY, chainId: BASE, value: native ? amountRaw : BigInt(0) });
    expect(c.approvals).toEqual(native ? [] : [{ token: input, spender: PROXY, amountRaw }]);
    expect(c.deliveryProof).toEqual({ signature: DELIVERY_PROOF_SIGNATURE, recipient: SIGNER, tokens: [output] });
  });

  it('simulates: balance, then allowance, then eth_call — each failure is reported, not guessed', async () => {
    const c = await compile(input, output, amountRaw);
    if (native) {
      expect(await simulateBag(c, { client: simChain({ nativeBalance: amountRaw - BigInt(1) }) })).toMatchObject({ status: 'INSUFFICIENT_BALANCE', requiredRaw: amountRaw });
    } else {
      expect(await simulateBag(c, { client: simChain({ balance: amountRaw - BigInt(1) }) })).toMatchObject({ status: 'INSUFFICIENT_BALANCE' });
      expect(await simulateBag(c, { client: simChain({ allowance: amountRaw - BigInt(1) }) })).toMatchObject({ status: 'NEEDS_APPROVAL', missing: [{ token: input, spender: PROXY }] });
    }
    const ok = simChain({ allowance: amountRaw });
    expect(await simulateBag(c, { client: ok })).toEqual({ status: 'OK' });
    expect(ok.calls[0]).toMatchObject({ account: SIGNER, to: FACTORY, value: native ? amountRaw : BigInt(0) });
    expect((await simulateBag(c, { client: simChain({ allowance: amountRaw, revert: 'execution reverted: minimum not met' }) })).status).toBe('REVERTED');
  });
});

describe('compile and simulation failures on Base', () => {
  it('a transaction target or approval spender outside the Base trust policy is refused', async () => {
    await expect(compile(USDC, WETH, BigInt(2_000_000), { target: OTHER })).rejects.toMatchObject({ code: 'UNTRUSTED_TARGET' });
    await expect(compile(USDC, WETH, BigInt(2_000_000), { spender: OTHER })).rejects.toMatchObject({ code: 'UNTRUSTED_SPENDER' });
  });

  it('a trust policy of another chain (e.g. the Robinhood pin) never applies on Base', async () => {
    const err = await compile(USDC, WETH, BigInt(2_000_000), { trust: { ...TRUST, chainId: 4663 } }).catch((e) => e);
    expect(getSdkErrorInfo(err).code).toBe('TRUST_POLICY_INVALID');
  });

  it('simulation refuses a client on another chain, and a target without code', async () => {
    const c = await compile(USDC, WETH, BigInt(2_000_000));
    await expect(simulateBag(c, { client: simChain({ chainId: 4663 }) })).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    expect(await simulateBag(c, { client: simChain({ targetCode: undefined }) })).toMatchObject({ status: 'INVALID_TARGET' });
  });
});

// ------------------------- 7. receipts on Base ------------------------------

function receiptChain(compiled: CompiledPurchase, o: { to?: Hex; logs?: (output: Hex) => PurchaseReceiptLog[]; status?: 'success' | 'reverted'; chainId?: number } = {}) {
  const output = compiled.quote.plan.legs[0].token as Hex;
  const to = o.to ?? compiled.transaction.to;
  const transaction: PurchaseReceiptTransaction = {
    hash: HASH, from: SIGNER, to, input: compiled.transaction.data, value: compiled.transaction.value, chainId: o.chainId ?? BASE, blockHash: BLOCK, blockNumber: BigInt(53500571),
  };
  const log = (token: Hex, before: bigint, after: bigint): PurchaseReceiptLog => ({
    address: PROXY, topics: [hex('e', 64)], logIndex: 0, transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(53500571), removed: false,
    data: ('0x' + [w(DISCRIMINATOR), w(token), w(SIGNER), w(before), w(after)].join('')) as Hex,
  });
  const receipt: PurchaseTransactionReceipt = {
    transactionHash: HASH, from: SIGNER, to, blockHash: BLOCK, blockNumber: BigInt(53500571), status: o.status ?? 'success',
    logs: o.logs ? o.logs(output) : [log(output, BigInt(0), BigInt(1000))],
  };
  const client = {
    getChainId: vi.fn(async () => o.chainId ?? BASE),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: BLOCK })),
    getBlockNumber: vi.fn(async () => BigInt(53500580)),
  } satisfies PurchaseReceiptClient;
  return { client, log, output };
}

describe('receipt verification on Base (DELIVERY_LOG, no tracing RPC)', () => {
  it.each(SCENARIOS)('$name: VERIFIED from the executor log, bound DIRECT', async ({ input, output, amountRaw }) => {
    const c = await compile(input, output, amountRaw);
    const { client } = receiptChain(c);
    const r = await verifyPurchaseReceipt(c, { client, transactionHash: HASH, minimumReceived: [{ token: output, amountRaw: BigInt(990) }], verification: 'DELIVERY_LOG' });
    expect(r).toMatchObject({ status: 'VERIFIED', evidence: 'TRANSACTION_AND_DELIVERY_LOGS', transactionBinding: 'DIRECT', chainId: BASE, accounting: 'NOT_BAG_ACCOUNTED' });
    expect(r.outputs[0]).toMatchObject({ token: output, balanceDeltaRaw: BigInt(1000), satisfied: true });
  });

  it('FAILED below the reviewed minimum; FAILED when the purchase reverted', async () => {
    const c = await compile(USDC, CBBTC, BigInt(2_000_000));
    const low = receiptChain(c, { logs: (out) => [receiptChain(c).log(out, BigInt(0), BigInt(989))] });
    expect(await verifyPurchaseReceipt(c, { client: low.client, transactionHash: HASH, minimumReceived: [{ token: CBBTC, amountRaw: BigInt(990) }], verification: 'DELIVERY_LOG' })).toMatchObject({ status: 'FAILED', issues: [{ code: 'OUTPUT_BELOW_MINIMUM' }] });
    const reverted = receiptChain(c, { status: 'reverted' });
    expect(await verifyPurchaseReceipt(c, { client: reverted.client, transactionHash: HASH, minimumReceived: [{ token: CBBTC, amountRaw: BigInt(1) }], verification: 'DELIVERY_LOG' })).toMatchObject({ status: 'FAILED', issues: [{ code: 'TRANSACTION_REVERTED' }] });
  });

  it('INDETERMINATE (never VERIFIED) when the delivery log is missing', async () => {
    const c = await compile(USDC, WETH, BigInt(2_000_000));
    const { client } = receiptChain(c, { logs: () => [] });
    expect(await verifyPurchaseReceipt(c, { client, transactionHash: HASH, minimumReceived: [{ token: WETH, amountRaw: BigInt(1) }], verification: 'DELIVERY_LOG' })).toMatchObject({ status: 'INDETERMINATE', issues: [{ code: 'DELIVERY_PROOF_UNAVAILABLE' }] });
  });

  it('a delegated (EIP-7702 smart account) send is INDETERMINATE on Base: binding it needs a call trace the RPC does not serve', async () => {
    const c = await compile(USDC, WETH, BigInt(2_000_000));
    const { client } = receiptChain(c, { to: SIGNER });
    expect(await verifyPurchaseReceipt(c, { client, transactionHash: HASH, minimumReceived: [{ token: WETH, amountRaw: BigInt(1) }], verification: 'DELIVERY_LOG' })).toMatchObject({ status: 'INDETERMINATE', issues: [{ code: 'UNSUPPORTED_TRANSACTION_ENVELOPE' }] });
  });

  it('a receipt from another chain is refused', async () => {
    const c = await compile(USDC, WETH, BigInt(2_000_000));
    const { client } = receiptChain(c, { chainId: 4663 });
    expect(await verifyPurchaseReceipt(c, { client, transactionHash: HASH, minimumReceived: [{ token: WETH, amountRaw: BigInt(1) }], verification: 'DELIVERY_LOG' })).toMatchObject({ status: 'FAILED', issues: [{ code: 'RPC_CHAIN_MISMATCH' }] });
  });
});

// ------------- simulation without a sent approval (assumeApprovals) ----------


const ALLOWANCE = [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
type Override = { address: Hex; stateDiff: { slot: Hex; value: Hex }[] }[] | undefined;

/** A token whose allowance mapping sits at `base` with the given layout; the purchase needs that allowance. */
function overrideChain(o: { layout: 'solidity' | 'vyper' | 'none'; base: number; token: Hex; owner: Hex; spender: Hex; need: bigint; revertWith?: string }): SimulationClient & { calls: number } {
  const slot = (): Hex | null => {
    if (o.layout === 'none') return null;
    if (o.layout === 'solidity') {
      const inner = k256(enc([{ type: 'address' }, { type: 'uint256' }], [o.owner, BigInt(o.base)]));
      return k256(enc([{ type: 'address' }, { type: 'bytes32' }], [o.spender, inner]));
    }
    const inner = k256(enc([{ type: 'uint256' }, { type: 'address' }], [BigInt(o.base), o.owner]));
    return k256(enc([{ type: 'bytes32' }, { type: 'address' }], [inner, o.spender]));
  };
  const allowanceUnder = (ov: Override) => {
    const s = slot();
    const hit = ov?.find((x) => x.address.toLowerCase() === o.token.toLowerCase())?.stateDiff.find((d) => d.slot === s);
    return hit ? BigInt(hit.value) : BigInt(0);
  };
  const client = {
    calls: 0,
    getChainId: async () => BASE,
    getCode: async () => '0x60' as Hex,
    getBalance: async () => BigInt(10) ** BigInt(18),
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'balanceOf' ? BigInt(10) ** BigInt(20) : BigInt(0)),
    call: async (args: { to: Hex; data: Hex; stateOverride?: Override }) => {
      client.calls++;
      if (args.to.toLowerCase() === o.token.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: ALLOWANCE, data: args.data });
        if (functionName !== 'allowance') throw new Error('unexpected');
        return { data: encodeFunctionResult({ abi: ALLOWANCE, functionName: 'allowance', result: allowanceUnder(args.stateOverride) }) };
      }
      if (allowanceUnder(args.stateOverride) < o.need) throw new Error('execution reverted: ERC20: transfer amount exceeds allowance');
      if (o.revertWith) throw new Error(o.revertWith);
      return { data: '0x' };
    },
  };
  return client as unknown as SimulationClient & { calls: number };
}

describe('simulateBag assumeApprovals: the swap itself, without sending an approval', () => {
  const amount = BigInt(2_000_000);

  it('unchanged without the option: NEEDS_APPROVAL', async () => {
    const c = await compile(USDC, WETH, amount);
    expect((await simulateBag(c, { client: overrideChain({ layout: 'solidity', base: 10, token: USDC, owner: SIGNER, spender: PROXY, need: amount }) })).status).toBe('NEEDS_APPROVAL');
  });

  it.each([['solidity', 10], ['solidity', 3], ['vyper', 4]] as const)('finds and verifies a %s allowance mapping at slot %i, then simulates the purchase', async (layout, base) => {
    const c = await compile(USDC, WETH, amount);
    const r = await simulateBag(c, { client: overrideChain({ layout, base, token: USDC, owner: SIGNER, spender: PROXY, need: amount }), assumeApprovals: true });
    expect(r).toMatchObject({ status: 'OK_WITH_ASSUMED_APPROVALS', assumed: [{ token: USDC, spender: PROXY, amountRaw: amount }], overrides: [{ token: USDC, layout }] });
  });

  it('a token whose allowance storage cannot be verified is APPROVAL_OVERRIDE_UNAVAILABLE — never a guessed OK', async () => {
    const c = await compile(USDC, WETH, amount);
    const client = overrideChain({ layout: 'none', base: 0, token: USDC, owner: SIGNER, spender: PROXY, need: amount });
    expect(await simulateBag(c, { client, assumeApprovals: true })).toMatchObject({ status: 'APPROVAL_OVERRIDE_UNAVAILABLE' });
    expect(client.calls).toBe(42); // bounded search: 21 slots × 2 layouts, no purchase call
  });

  it('a purchase that reverts even with the allowance in place is REVERTED', async () => {
    const c = await compile(USDC, CBBTC, amount);
    const r = await simulateBag(c, { client: overrideChain({ layout: 'solidity', base: 9, token: USDC, owner: SIGNER, spender: PROXY, need: amount, revertWith: 'execution reverted: min out' }), assumeApprovals: true });
    expect(r).toMatchObject({ status: 'REVERTED', reason: expect.stringContaining('min out') });
  });

  it('native ETH needs no approval: plain OK', async () => {
    const c = await compile(NATIVE_TOKEN as Hex, USDC, BigInt(10) ** BigInt(15));
    expect(await simulateBag(c, { client: simChain(), assumeApprovals: true })).toEqual({ status: 'OK' });
  });
});
