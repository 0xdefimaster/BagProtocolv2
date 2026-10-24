import { describe, expect, it, vi } from 'vitest';
import {
  compileBag, parseBag, verifyPurchaseReceipt,
  type Hex, type PurchaseReceiptClient, type PurchaseReceiptTransaction, type PurchaseTransactionReceipt,
  type PurchaseBalanceEvidence, type DeliveryAuthorizationEvidence,
} from '../src';
import { withReceiptEvidence } from '../src/adapters/evm';
import { externalBag } from './helpers';

// A plan contract (PLAN) is the compiled signer. In one keeper transaction it pulls the swap share
// from SOURCE, calls the compiled target and forwards every output to RECIPIENT.
const hex = (digit: string, length: number) => ('0x' + digit.repeat(length)) as Hex;
const PLAN = hex('5', 40);
const SOURCE = hex('a', 40);
const RECIPIENT = hex('b', 40);
const KEEPER = hex('d', 40);
const ROUTER = hex('7', 40);
const INPUT = hex('c', 40);
const HASH = hex('1', 64);
const BLOCK = hex('2', 64);
const RUN = '0xabcdef01' as Hex;

type Balances = Record<string, Record<string, [bigint, bigint]>>;

async function setup(kept = false) {
  const raw = externalBag();
  if (kept) { raw.definition.assets[0].address = INPUT; delete raw.metadata; }
  const parsed = parseBag(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const compiled = await compileBag(parsed.bag, {
    inputToken: INPUT, amountRaw: BigInt(10_000_000), inputTokenDecimals: 6, signer: PLAN,
  }, {
    provider: {
      name: 'fixture',
      async compile(request) {
        return {
          transaction: { to: ROUTER, data: '0x12345678', value: '0', chainId: request.chainId },
          executor: null, approvals: [], priceImpactBps: 1, gasLimit: null, fees: [],
          legs: request.legs.map(leg => ({ token: leg.token, expectedOutRaw: '1000', minOutRaw: '990' })),
        };
      },
    },
    trust: { chainId: 4663, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] },
  });
  const plan = compiled.quote.plan;
  const outputs = plan.legs.map(leg => leg.token.toLowerCase());
  const minimumReceived = outputs.map(token => ({ token, amountRaw: BigInt(80) }));
  const swap = plan.swapAmountRaw, gross = plan.amountRaw, keptRaw = plan.kept?.amountRaw ?? BigInt(0);
  // Forwarded purchase: SOURCE pays the swap share only; PLAN ends where it started; RECIPIENT receives 100 of each output.
  const balances: Balances = {
    [PLAN]: Object.fromEntries([...outputs, INPUT].map(t => [t, [BigInt(0), BigInt(0)]])),
    [SOURCE]: { ...Object.fromEntries(outputs.map(t => [t, [BigInt(0), BigInt(0)]])), [INPUT]: [gross, gross - swap] },
    [RECIPIENT]: { ...Object.fromEntries(outputs.map(t => [t, [BigInt(0), BigInt(100)]])), [INPUT]: [BigInt(0), BigInt(0)] },
  };
  const transaction: PurchaseReceiptTransaction = {
    hash: HASH, from: KEEPER, to: PLAN, input: RUN, value: BigInt(0), chainId: 4663, blockHash: BLOCK, blockNumber: BigInt(10),
  };
  const receipt: PurchaseTransactionReceipt = {
    transactionHash: HASH, from: KEEPER, to: PLAN, blockHash: BLOCK, blockNumber: BigInt(10), status: 'success', logs: [],
  };
  let innerCall: Record<string, unknown> | null = { type: 'CALL', from: PLAN, to: ROUTER, input: compiled.transaction.data, value: '0x0' };
  let authorization: Partial<DeliveryAuthorizationEvidence> = {};
  const client: PurchaseReceiptClient = {
    getChainId: vi.fn(async () => 4663),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: BLOCK, transactions: [HASH] })),
    getBlockNumber: vi.fn(async () => BigInt(12)),
    tracePurchaseCall: vi.fn(async () => ({ transactionHash: HASH, blockHash: BLOCK,
      call: { type: 'CALL', from: KEEPER, to: PLAN, input: RUN, value: '0x0', calls: innerCall ? [innerCall] : [] } })),
    getPurchaseBalanceChanges: vi.fn(async (ctx): Promise<PurchaseBalanceEvidence> => ({
      ...ctx, scope: 'SINGLE_TRANSACTION_BLOCK',
      balances: ctx.tokens.map((token: string) => { const [beforeRaw, afterRaw] = balances[ctx.owner][token]; return { token, beforeRaw, afterRaw }; }),
    })),
    readDeliveryAuthorization: vi.fn(async (ctx) => ({ ...ctx, fundingSource: SOURCE, recipient: RECIPIENT, ...authorization })),
  };
  const delivery = { caller: PLAN, fundingSource: SOURCE, recipient: RECIPIENT };
  const run = (overrides: Partial<Parameters<typeof verifyPurchaseReceipt>[1]> = {}) =>
    verifyPurchaseReceipt(compiled, { client, transactionHash: HASH, minimumReceived, delivery, ...overrides });
  return { compiled, plan, outputs, swap, gross, keptRaw, balances, client, minimumReceived, run,
    dropInnerCall: () => { innerCall = null; }, setAuthorization: (a: Partial<DeliveryAuthorizationEvidence>) => { authorization = a; } };
}

describe('verifyPurchaseReceipt forwarded delivery', () => {
  it('leaves the default mode unchanged: a forwarding caller is still refused with INPUT_BALANCE_BELOW_PLAN', async () => {
    const f = await setup();
    const result = await f.run({ delivery: undefined });
    expect(result.status).toBe('FAILED');
    expect(result.issues.map(i => i.code)).toEqual(['INPUT_BALANCE_BELOW_PLAN']);
    expect(result.transactionBinding).toBe('CALL_TRACE');
    expect(result.delivery).toBeNull();
    expect(f.client.readDeliveryAuthorization).not.toHaveBeenCalled();
  });

  it('verifies the inner call, the funding-source debit, recipient minimums and a net-zero caller together', async () => {
    const f = await setup();
    const result = await f.run();
    expect(result.status).toBe('VERIFIED');
    expect(result.transactionBinding).toBe('CALL_TRACE');
    expect(result.spentInputRaw).toBe(f.swap);
    expect(result.outputs.every(o => o.balanceDeltaRaw === BigInt(100) && o.satisfied)).toBe(true);
    expect(result.delivery).toEqual({ caller: PLAN, fundingSource: SOURCE, recipient: RECIPIENT, authorization: 'ON_CHAIN_PLAN_READ', callerNetZero: true });
    expect(f.client.readDeliveryAuthorization).toHaveBeenCalledWith({ caller: PLAN, blockHash: BLOCK, blockNumber: BigInt(10) });
    const owners = vi.mocked(f.client.getPurchaseBalanceChanges!).mock.calls.map(([ctx]) => ctx.owner);
    expect(owners).toEqual([PLAN, SOURCE, RECIPIENT]);
  });

  it('measures the same account once when the funding source is also the recipient', async () => {
    const f = await setup();
    for (const t of f.outputs) f.balances[SOURCE][t] = [BigInt(0), BigInt(100)];
    f.setAuthorization({ recipient: SOURCE });
    const result = await f.run({ delivery: { caller: PLAN, fundingSource: SOURCE, recipient: SOURCE } });
    expect(result.status).toBe('VERIFIED');
    expect(vi.mocked(f.client.getPurchaseBalanceChanges!).mock.calls.map(([ctx]) => ctx.owner)).toEqual([PLAN, SOURCE]);
  });

  it('is indeterminate without an authorization reader, never verified', async () => {
    const f = await setup();
    delete f.client.readDeliveryAuthorization;
    const result = await f.run();
    expect(result.status).toBe('INDETERMINATE');
    expect(result.issues[0].code).toBe('DELIVERY_AUTHORIZATION_UNAVAILABLE');
  });

  it('fails when the expected recipient or funding source differs from the plan authorization', async () => {
    for (const changed of [{ recipient: hex('e', 40) }, { fundingSource: hex('e', 40) }]) {
      const f = await setup();
      f.setAuthorization(changed);
      const result = await f.run();
      expect(result.status).toBe('FAILED');
      expect(result.issues[0].code).toBe('DELIVERY_AUTHORIZATION_MISMATCH');
    }
  });

  it('rejects authorization evidence for another caller or block', async () => {
    const f = await setup();
    f.setAuthorization({ caller: hex('e', 40) });
    expect((await f.run()).issues[0].code).toBe('DELIVERY_AUTHORIZATION_UNAVAILABLE');
    const g = await setup();
    g.setAuthorization({ blockNumber: BigInt(11) });
    expect((await g.run()).issues[0].code).toBe('DELIVERY_AUTHORIZATION_UNAVAILABLE');
  });

  it('still requires the exact compiled call from the caller in the trace', async () => {
    const f = await setup();
    f.dropInnerCall();
    const result = await f.run();
    expect(result.status).toBe('FAILED');
    expect(result.issues[0].code).toBe('COMPILED_CALL_NOT_EXECUTED');
  });

  it('fails when the caller keeps part of an output or of the input', async () => {
    const f = await setup();
    f.balances[PLAN][f.outputs[0]] = [BigInt(0), BigInt(1)];
    expect((await f.run()).issues[0].code).toBe('CALLER_RETAINED_BALANCE');
    const g = await setup();
    g.balances[PLAN][INPUT] = [BigInt(0), BigInt(1)];
    expect((await g.run()).issues[0].code).toBe('CALLER_RETAINED_BALANCE');
  });

  it('applies the recipient minimums', async () => {
    const f = await setup();
    f.balances[RECIPIENT][f.outputs[1]] = [BigInt(0), BigInt(79)];
    const result = await f.run();
    expect(result.status).toBe('FAILED');
    expect(result.issues[0].code).toBe('OUTPUT_BELOW_MINIMUM');
  });

  it('applies the input rules to the funding source: pre-balance and maximum debit', async () => {
    const f = await setup();
    f.balances[SOURCE][INPUT] = [f.gross - BigInt(1), BigInt(0)];
    expect((await f.run()).issues[0].code).toBe('INPUT_BALANCE_BELOW_PLAN');
    const g = await setup();
    g.balances[SOURCE][INPUT] = [g.gross + BigInt(5), g.gross + BigInt(5) - g.swap - BigInt(1)];
    expect((await g.run()).issues[0].code).toBe('INPUT_SPEND_EXCEEDS_PLAN');
  });

  it('requires the funding source to pay the whole swapped share, unlike the default mode', async () => {
    // Zero or partial debit with a net-zero caller: the swap input came from somewhere else in the transaction.
    for (const after of ['zero', 'partial'] as const) {
      const f = await setup();
      f.balances[SOURCE][INPUT] = [f.gross, after === 'zero' ? f.gross : f.gross - f.swap + BigInt(1)];
      const result = await f.run();
      expect(result.status).toBe('FAILED');
      expect(result.issues[0].code).toBe('INPUT_SPEND_BELOW_PLAN');
      expect(result.spentInputRaw).toBe(after === 'zero' ? BigInt(0) : f.swap - BigInt(1));
    }
  });

  it('checks a retained input share against the funding source, debiting only the swapped share', async () => {
    const f = await setup(true);
    expect(f.keptRaw > BigInt(0)).toBe(true);
    const ok = await f.run();
    expect(ok.status).toBe('VERIFIED');
    expect(ok.spentInputRaw).toBe(f.swap);
    expect(ok.keptBalanceVerified).toBe(true);
    const g = await setup(true);
    g.balances[SOURCE][INPUT] = [g.gross, g.keptRaw - BigInt(1)];
    g.balances[RECIPIENT][INPUT] = [BigInt(0), g.gross - g.keptRaw + BigInt(1)];
    // Losing any of the retained share means the source paid more than the swapped share.
    const missing = await g.run();
    expect(missing.status).toBe('FAILED');
    expect(missing.issues[0].code).toBe('INPUT_SPEND_EXCEEDS_PLAN');
    expect(missing.keptBalanceVerified).toBe(false);
  });

  it('refuses ambiguous or weaker forwarded-delivery requests before reading anything', async () => {
    const f = await setup();
    await expect(f.run({ delivery: { caller: SOURCE, fundingSource: SOURCE, recipient: RECIPIENT } })).rejects.toThrow('compiled signer');
    await expect(f.run({ delivery: { caller: PLAN, fundingSource: PLAN, recipient: RECIPIENT } })).rejects.toThrow('other than the caller');
    await expect(f.run({ delivery: { caller: PLAN, fundingSource: SOURCE, recipient: PLAN } })).rejects.toThrow('other than the caller');
    await expect(f.run({ verification: 'TRANSFER_LOGS' })).rejects.toThrow('balance evidence');
    await expect(f.run({ delivery: { caller: PLAN, fundingSource: SOURCE } as never })).rejects.toThrow('addresses');
    expect(f.client.getTransaction).not.toHaveBeenCalled();
  });
});

describe('withReceiptEvidence delivery authorization reader', () => {
  const word = (a: Hex) => '0x' + a.slice(2).padStart(64, '0');
  const base = (code: string, outputs: Record<string, string>) => {
    const request = vi.fn(async ({ method, params }: { method: string; params: readonly unknown[] }) => {
      if (method === 'eth_getCode') return code;
      if (method === 'eth_call') return outputs[(params[0] as { data: string }).data];
      throw new Error('unexpected ' + method);
    });
    return { request, getChainId: async () => 4663, getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn() } as never;
  };
  const ctx = { caller: PLAN, blockHash: BLOCK, blockNumber: BigInt(10) };

  it('is absent unless explicitly enabled', () => {
    expect(withReceiptEvidence(base('0x60', {})).readDeliveryAuthorization).toBeUndefined();
    expect(() => withReceiptEvidence(base('0x60', {}), { deliveryAuthorization: 'OTHER' as never })).toThrow('Unknown delivery-authorization');
  });

  it('reads source() and recipient() from the caller at the canonical purchase block', async () => {
    const client = base('0x6080', { '0x67e828bf': word(SOURCE), '0x66d003ac': word(RECIPIENT) });
    const evidence = await withReceiptEvidence(client, { deliveryAuthorization: 'BAG_DCA_PLAN_V1' }).readDeliveryAuthorization!(ctx);
    expect(evidence).toEqual({ ...ctx, fundingSource: SOURCE, recipient: RECIPIENT });
    for (const [{ params }] of (client as unknown as { request: ReturnType<typeof vi.fn> }).request.mock.calls) {
      expect(params[1]).toEqual({ blockHash: BLOCK, requireCanonical: true });
    }
  });

  it('refuses a caller without code or a getter that does not return an address', async () => {
    const reader = (code: string, out: Record<string, string>) => withReceiptEvidence(base(code, out), { deliveryAuthorization: 'BAG_DCA_PLAN_V1' }).readDeliveryAuthorization!(ctx);
    await expect(reader('0x', {})).rejects.toThrow('no contract code');
    await expect(reader('0x6080', { '0x67e828bf': '0x', '0x66d003ac': word(RECIPIENT) })).rejects.toThrow('did not return an address');
  });
});
