import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import {
  compileBag, DELIVERY_PROOF_SIGNATURE, parseBag, verifyPurchaseReceipt,
  type Hex, type PurchaseReceiptClient, type PurchaseReceiptLog, type PurchaseReceiptTransaction, type PurchaseTransactionReceipt,
} from '../src';
import { lifiComposer } from '../src/adapters/lifi';
import { externalBag } from './helpers';

// Delivery proof: the Composer program measures each output's delivery to the signer and logs it
// (lifiComposer `deliveryProof`), and verifyPurchaseReceipt's DELIVERY_LOG mode reads that log from the
// executor instead of historical balance state.

const hex = (digit: string, length: number) => ('0x' + digit.repeat(length)) as Hex;
const SIGNER = hex('5', 40);
const ROUTER = hex('7', 40);
const PROXY = hex('8', 40);
const OTHER = hex('9', 40);
const USDG = hex('c', 40);
const HASH = hex('1', 64);
const BLOCK = hex('2', 64);
const TRUST = { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [PROXY] } as const;
const DISCRIMINATOR = keccak256(new TextEncoder().encode(DELIVERY_PROOF_SIGNATURE));
const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');

const bag = () => {
  const r = parseBag(externalBag());
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
};
const req = { inputToken: USDG, amountRaw: BigInt(10_000_000), inputTokenDecimals: 6, signer: SIGNER };

function composeFetch(data: Record<string, unknown>) {
  const wire = JSON.stringify({ data });
  return vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => JSON.parse(wire), text: async () => wire })) as unknown as typeof fetch;
}

/** A compile response for a delivery-proof flow: swap outputs consumed by their transfers, transfers terminal. */
function proofCompileData(tokens: string[]) {
  const outputs: Record<string, unknown> = {};
  tokens.forEach((token, i) => {
    const amount = { estimate: { basis: 'simulated', value: String(4000 + i) }, minimum: { basis: 'op', value: String(3960 + i) } };
    outputs[`swap_${i}.amountOut`] = { role: 'consumed', consumedBy: `deliver_${i}`, resource: { kind: 'erc20', token, chainId: 4663 }, amount };
    outputs[`deliver_${i}.transferred`] = { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token, chainId: 4663 }, amount };
  });
  return {
    outputs,
    transactionRequest: { to: ROUTER, chainId: 4663, data: '0xdeadbeef', value: '0', gasLimit: '900000' },
    userProxy: PROXY,
    priceImpact: { inputValueUsd: 10, outputValueUsd: 9.99, impactBps: 10, unpricedInputs: [], unpricedOutputs: [] },
    approvals: [{ token: USDG, spender: PROXY, amount: '10000000', transactionRequest: { to: USDG, data: '0x', value: '0' } }],
    fees: [],
  };
}

async function compileWithProof(mutate: (data: ReturnType<typeof proofCompileData>) => void = () => {}) {
  const tokens: string[] = externalBag().definition.assets.map((a: { address: string }) => a.address.toLowerCase()).sort();
  const data = proofCompileData(tokens);
  mutate(data);
  const fetchImpl = composeFetch(data);
  const compiled = await compileBag(bag(), req, { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: fetchImpl, deliveryProof: true }), trust: TRUST });
  const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
  return { compiled, body: String(calls.find(([url]) => String(url).endsWith('/compose'))![1].body) };
}

describe('lifiComposer deliveryProof', () => {
  it('adds before/after balance reads, explicit delivery, a positive-delta invariant and the BagDelivered log, in order', async () => {
    const { compiled, body } = await compileWithProof();
    const legs = compiled.quote.plan.legs;
    expect(compiled.deliveryProof).toEqual({ signature: DELIVERY_PROOF_SIGNATURE, recipient: SIGNER, tokens: legs.map(l => l.token) });
    expect(compiled.quote.legs.map(l => l.minOutRaw)).toEqual(['3960', '3961']);
    for (const op of ['core.staticCall', 'core.transfer', 'core.subtract', 'invariant.gt', 'core.emitEvent4']) expect(body).toContain(op);
    expect(body).toContain(DELIVERY_PROOF_SIGNATURE);
    expect(body).toContain('balanceOf(address account)');
    const at = (id: string) => body.indexOf(`"${id}"`);
    for (let i = 0; i < legs.length; i++) {
      // Execution order is flow order: every "before" read precedes every swap; each "after" read follows its transfer.
      expect(at(`balance_before_${i}`)).toBeLessThan(at('swap_0'));
      expect(at(`deliver_${i}`)).toBeGreaterThan(at(`swap_${legs.length - 1}`));
      expect(at(`balance_after_${i}`)).toBeGreaterThan(at(`deliver_${legs.length - 1}`));
      expect(at(`delivery_log_${i}`)).toBeGreaterThan(at(`delivered_positive_${i}`));
      expect(body.toLowerCase()).toContain(w(legs[i].token));
    }
  });

  it('leaves the flow and compile result unchanged without the option', async () => {
    const tokens: string[] = externalBag().definition.assets.map((a: { address: string }) => a.address.toLowerCase()).sort();
    const data = proofCompileData(tokens);
    data.outputs = Object.fromEntries(tokens.map((token, i) => [`swap_${i}.amountOut`,
      { role: 'terminal', owner: SIGNER, delivery: { when: 'now' }, resource: { kind: 'erc20', token, chainId: 4663 }, amount: { minimum: { basis: 'op', value: '1' }, estimate: { basis: 'simulated', value: '2' } } }]));
    const fetchImpl = composeFetch(data);
    const compiled = await compileBag(bag(), req, { provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: fetchImpl }), trust: TRUST });
    expect(compiled.deliveryProof).toBeUndefined();
    const body = String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]).find(([u]) => String(u).endsWith('/compose'))![1].body);
    expect(body).not.toContain('core.emitEvent4');
    expect(body).not.toContain('core.transfer');
  });

  it.each(['terminal swap output', 'consumed by another node', 'delivery to another owner'] as const)('refuses %s', async (kind) => {
    await expect(compileWithProof(data => {
      const swap = data.outputs['swap_0.amountOut'] as Record<string, unknown>;
      if (kind === 'terminal swap output') Object.assign(swap, { role: 'terminal', owner: SIGNER, delivery: { when: 'now' } });
      if (kind === 'consumed by another node') swap.consumedBy = 'swap_1';
      if (kind === 'delivery to another owner') (data.outputs['deliver_0.transferred'] as Record<string, unknown>).owner = OTHER;
    })).rejects.toThrow();
  });

  it('refuses a provider-reported proof that does not match the plan or lacks an executor', async () => {
    const parsed = bag();
    const provider = (proof: unknown, executor: string | null = PROXY) => ({
      name: 'fixture',
      async compile(request: { chainId: number; legs: { token: string }[] }) {
        return {
          transaction: { to: ROUTER, data: '0x12345678', value: '0', chainId: request.chainId }, executor, approvals: [],
          priceImpactBps: 1, gasLimit: null, fees: [], deliveryProof: proof as never,
          legs: request.legs.map(leg => ({ token: leg.token, expectedOutRaw: '1000', minOutRaw: '990' })),
        };
      },
    });
    const tokens = parsed.definition.assets.map(a => a.address.toLowerCase()).sort();
    const good = { signature: DELIVERY_PROOF_SIGNATURE, recipient: SIGNER, tokens };
    await expect(compileBag(parsed, req, { provider: provider(good), trust: TRUST })).resolves.toMatchObject({ deliveryProof: good });
    for (const bad of [{ ...good, recipient: OTHER }, { ...good, tokens: [...tokens].reverse() }, { ...good, signature: 'Other(address)' }]) {
      await expect(compileBag(parsed, req, { provider: provider(bad), trust: TRUST })).rejects.toThrow(/delivery proof/);
    }
    await expect(compileBag(parsed, req, { provider: provider(good, null), trust: TRUST })).rejects.toThrow(/delivery proof/);
  });
});

describe('verifyPurchaseReceipt DELIVERY_LOG', () => {
  async function setup() {
    const { compiled } = await compileWithProof();
    const tokens = compiled.quote.plan.legs.map(l => l.token as Hex);
    const minimumReceived = tokens.map(token => ({ token, amountRaw: BigInt(80) }));
    const transaction: PurchaseReceiptTransaction = {
      hash: HASH, from: SIGNER, to: ROUTER, input: compiled.transaction.data, value: BigInt(0), chainId: 4663, blockHash: BLOCK, blockNumber: BigInt(10),
    };
    const log = (token: string, before: bigint, after: bigint, index: number, address: Hex = PROXY, layout: 'plain' | 'dynamic' = 'plain'): PurchaseReceiptLog => ({
      address, topics: [hex('e', 64)], logIndex: index, transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), removed: false,
      data: ('0x' + (layout === 'plain'
        ? [w(DISCRIMINATOR), w(token), w(SIGNER), w(before), w(after)]
        : [w(BigInt(32)), w(DISCRIMINATOR), w(BigInt(4)), w(token), w(SIGNER), w(before), w(after)]).join('')) as Hex,
    });
    const receipt: PurchaseTransactionReceipt = {
      transactionHash: HASH, from: SIGNER, to: ROUTER, blockHash: BLOCK, blockNumber: BigInt(10), status: 'success',
      logs: tokens.map((t, i) => log(t, BigInt(5), BigInt(105), i)),
    };
    const client = {
      getChainId: vi.fn(async () => 4663),
      getTransaction: vi.fn(async () => transaction),
      getTransactionReceipt: vi.fn(async () => receipt),
      getBlock: vi.fn(async () => ({ hash: BLOCK })),
      getBlockNumber: vi.fn(async () => BigInt(12)),
    } satisfies PurchaseReceiptClient;
    const run = (over: Partial<Parameters<typeof verifyPurchaseReceipt>[1]> = {}) =>
      verifyPurchaseReceipt(compiled, { client, transactionHash: HASH, minimumReceived, verification: 'DELIVERY_LOG', ...over });
    return { compiled, tokens, receipt, client, log, run };
  }

  it('verifies from the executor logs alone: no tracing and no historical state reads', async () => {
    const f = await setup();
    const result = await f.run();
    expect(result.status).toBe('VERIFIED');
    expect(result.evidence).toBe('TRANSACTION_AND_DELIVERY_LOGS');
    expect(result.transactionBinding).toBe('DIRECT');
    expect(result.outputs.map(o => [o.balanceBeforeRaw, o.balanceAfterRaw, o.balanceDeltaRaw, o.satisfied])).toEqual([
      [BigInt(5), BigInt(105), BigInt(100), true], [BigInt(5), BigInt(105), BigInt(100), true]]);
    expect(result.spentInputRaw).toBeNull();
  });

  it('accepts the payload after other words (e.g. an ABI offset and length)', async () => {
    const f = await setup();
    f.receipt.logs = f.tokens.map((t, i) => f.log(t, BigInt(0), BigInt(90), i, PROXY, 'dynamic'));
    expect((await f.run()).status).toBe('VERIFIED');
  });

  it('fails a measured delivery below the reviewed minimum', async () => {
    const f = await setup();
    f.receipt.logs = [f.log(f.tokens[0], BigInt(10), BigInt(89), 0), f.log(f.tokens[1], BigInt(0), BigInt(100), 1)];
    const result = await f.run();
    expect(result.status).toBe('FAILED');
    expect(result.issues[0].code).toBe('OUTPUT_BELOW_MINIMUM');
  });

  it.each(['missing', 'other emitter'] as const)('is indeterminate when a log is %s', async (kind) => {
    const f = await setup();
    f.receipt.logs = [kind === 'missing' ? [] : [f.log(f.tokens[0], BigInt(0), BigInt(100), 0, OTHER)], [f.log(f.tokens[1], BigInt(0), BigInt(100), 1)]].flat();
    const result = await f.run();
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('DELIVERY_PROOF_UNAVAILABLE');
  });

  it('accepts an explicitly allowed emitter (e.g. the VM, if it is the one logging)', async () => {
    const f = await setup();
    f.receipt.logs = f.tokens.map((t, i) => f.log(t, BigInt(0), BigInt(100), i, OTHER));
    expect((await f.run({ deliveryLogEmitters: [OTHER] })).status).toBe('VERIFIED');
  });

  it.each(['duplicate', 'wrong recipient'] as const)('rejects a %s log', async (kind) => {
    const f = await setup();
    if (kind === 'duplicate') f.receipt.logs = [...f.receipt.logs, f.log(f.tokens[0], BigInt(0), BigInt(100), 9)];
    else f.receipt.logs = [{ ...f.receipt.logs[0], data: f.receipt.logs[0].data.replace(w(SIGNER), w(OTHER)) as Hex }, f.receipt.logs[1]];
    const result = await f.run();
    expect(result.status).toBe('INDETERMINATE');
    // A log carrying our discriminator that names another recipient is malformed, not merely missing.
    expect(result.issues[0].code).toBe('INVALID_DELIVERY_LOG');
  });

  it('still binds the mined transaction to the compiled call', async () => {
    const f = await setup();
    f.client.getTransaction.mockResolvedValue({ ...(await f.client.getTransaction()), input: '0xabcdef12' });
    expect((await f.run()).status).toBe('FAILED');
  });

  it('is refused for a purchase compiled without delivery proof', async () => {
    const f = await setup();
    const { deliveryProof: _omit, ...plain } = f.compiled;
    await expect(verifyPurchaseReceipt(plain, { client: f.client, transactionHash: HASH, minimumReceived: f.tokens.map(token => ({ token, amountRaw: BigInt(1) })), verification: 'DELIVERY_LOG' }))
      .rejects.toThrow(/delivery proof/);
  });
});
