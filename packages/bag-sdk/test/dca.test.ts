import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from 'viem';
import { BagSdkError } from '../src/errors';
import {
  buildDcaAuthorization,
  checkDcaTerms,
  dcaAuthorizationId,
  dcaCeilingMinimums,
  dcaCompositionHash,
  dcaLegAmounts,
  dcaMissedWindows,
  dcaRunDue,
  DCA_EXECUTOR_ABI,
  summarizeDcaAuthorization,
  verifyDcaReceipt,
  type DcaAuthorization,
  type DcaReceiptClient,
  type DcaReceiptLog,
} from '../src/dca';
import feetest from './fixtures/feetest.v1.bag.json';

const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d' as Hex;
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' as Hex;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Hex;
const OWNER = '0x1111111111111111111111111111111111111111' as Hex;
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Hex;
const EXECUTOR = '0x3333333333333333333333333333333333333333' as Hex;
const ADAPTER = '0x4444444444444444444444444444444444444444' as Hex;
const ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2' as Hex;
const KEEPER = '0x5555555555555555555555555555555555555555' as Hex;
const DEP = { chainId: 4663, executor: EXECUTOR };
const DAY = BigInt(86_400);
const START = BigInt(1_800_000_000);
const B = (x: number | string) => BigInt(x);

const bagDoc = () => {
  const d = JSON.parse(JSON.stringify(feetest));
  d.definition.rules.performanceFeeBps = 0;
  delete d.definitionHash;
  return d;
};
const registeredRows = [
  { asset: NVDA, symbol: 'NVDA', decimals: 18, weightBps: 5000 },
  { asset: TSLA, symbol: 'TSLA', decimals: 18, weightBps: 5000 },
];
const COMPOSITION = dcaCompositionHash('robinhood', registeredRows);

const build = (over: Partial<Parameters<typeof buildDcaAuthorization>[0]> = {}) =>
  buildDcaAuthorization({
    bag: bagDoc(),
    owner: OWNER,
    recipient: RECIPIENT,
    inputToken: USDG,
    allowedCaller: KEEPER,
    registry: { bagId: `0x${'ab'.repeat(32)}`, bagVersion: 1, compositionHash: COMPOSITION },
    amountPerRunRaw: B(10_000_000),
    runs: 5,
    totalBudgetRaw: B(50_000_000),
    startsAt: START,
    periodSeconds: DAY,
    maxPriceRaw: { [TSLA]: B(420_000_000), [NVDA]: B(210_000_000) },
    route: { adapter: ADAPTER, swapRouter: ROUTER, allowedFees: [500, 3000] },
    nonce: B(1),
    ...over,
  });

describe('buildDcaAuthorization', () => {
  it('builds the registered composition (sorted by symbol) and reproduces the registered hash', () => {
    const a = build();
    expect(a.assets.map((x) => x.symbol)).toEqual(['NVDA', 'TSLA']);
    expect(a.schedule.expiresAt).toBe(START + B(5) * DAY);
    expect(checkDcaTerms(a, { adapter: ADAPTER, swapRouter: ROUTER, executor: EXECUTOR })).toEqual([]);
    const s = summarizeDcaAuthorization(a);
    expect(s.approval.amountRaw).toBe(B(50_000_000));
    expect(s.priceLimit.isFairPrice).toBe(false);
    expect(s.assets[0].minimumOutRaw).toBe(dcaCeilingMinimums(a)[0]);
  });

  it('refuses: performance-fee strategies, a different registered hash, budget ≠ per-run × runs, missing ceilings, bad fee tiers', () => {
    const expectRefusal = (fn: () => unknown, re: RegExp) => {
      try {
        fn();
        throw new Error('expected a refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(BagSdkError);
        expect((e as BagSdkError).code).toBe('DCA_TERMS_INVALID');
        expect((e as Error).message).toMatch(re);
      }
    };
    expectRefusal(() => build({ bag: feetest as never }), /performance fee/);
    expectRefusal(() => build({ registry: { bagId: `0x${'ab'.repeat(32)}`, bagVersion: 1, compositionHash: `0x${'cd'.repeat(32)}` } }), /registered content/);
    expectRefusal(() => build({ totalBudgetRaw: B(49_999_999) }), /totalBudgetRaw/);
    expectRefusal(() => build({ maxPriceRaw: { [TSLA]: B(1) } }), /maxPriceRaw/);
    expectRefusal(() => build({ route: { adapter: ADAPTER, swapRouter: ROUTER, allowedFees: [2500] } }), /allowedFees/);
    expectRefusal(() => build({ amountPerRunRaw: B(1), totalBudgetRaw: B(5) }), /nothing to buy/);
    expectRefusal(() => build({ allowedCaller: undefined as never }), /allowedCaller is required/);
    expectRefusal(() => build({ allowedCaller: `0x${'0'.repeat(40)}` }), /zero address/);
    expectRefusal(() => build({ allowedCaller: 'ANY' }), /not an address/);
  });

  it('allowedCaller: the keeper address is signed; the summary states the keeper is trusted within the ceilings', () => {
    expect(build().allowedCaller).toBe(KEEPER);
    expect(summarizeDcaAuthorization(build()).caller).toEqual({ kind: 'ONLY', address: KEEPER, trust: 'KEEPER_CAN_EXECUTE_UP_TO_CEILING' });
    expect(checkDcaTerms({ ...build(), allowedCaller: `0x${'0'.repeat(40)}` })).toContain('allowedCaller is required (the keeper address)');
  });
});

describe('arithmetic shared with the executor', () => {
  it('split and ceiling minimums (5 USDG legs at 210 / 420)', () => {
    const a = build();
    expect(dcaLegAmounts(a)).toEqual([B(5_000_000), B(5_000_000)]);
    // ceil(5e6 × 1e18 / 210e6), ceil(5e6 × 1e18 / 420e6)
    expect(dcaCeilingMinimums(a)).toEqual([B('23809523809523810'), B('11904761904761905')]);
  });

  it('calendar: one run per window, ≥ one period apart, no catch-up, nothing after expiry or revocation', () => {
    const a = build();
    const st = { runs: 0, spent: B(0), lastWindow: B(0), lastRunAt: B(0), revoked: false };
    expect(dcaRunDue(a, st, START - B(1)).state).toBe('SCHEDULED');
    expect(dcaRunDue(a, st, START + B(3) * DAY).state).toBe('DUE');
    const after = { runs: 1, spent: B(10_000_000), lastWindow: B(0), lastRunAt: START + DAY - B(10), revoked: false };
    expect(dcaRunDue(a, after, START + DAY - B(5)).state).toBe('DONE_THIS_WINDOW');
    const early = dcaRunDue(a, after, START + DAY + B(5)); // window 1, but < 1 period after the run
    expect(early.state).toBe('DONE_THIS_WINDOW');
    expect(early.nextDueAt).toBe(START + B(2) * DAY - B(10));
    expect(dcaRunDue(a, { ...after, revoked: true }, START + B(2) * DAY).state).toBe('REVOKED');
    expect(dcaRunDue(a, { ...after, runs: 5, spent: B(50_000_000) }, START + B(2) * DAY).state).toBe('COMPLETED');
    expect(dcaRunDue(a, after, a.schedule.expiresAt).state).toBe('EXPIRED');
    expect(dcaMissedWindows(a, [B(0), B(3)], START + B(4) * DAY + B(1))).toEqual([B(1), B(2)]);
  });
});

// ----------------------------------------------------------------- receipt verifier

const AUTH = build();
const ID = dcaAuthorizationId(AUTH, DEP);
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex;
const TX = `0x${'cc'.repeat(32)}` as Hex;
const MINS = dcaCeilingMinimums(AUTH);

function deliveredLog(i: number, o: Partial<{ token: Hex; recipient: Hex; before: bigint; after: bigint; min: bigint; index: bigint; id: Hex; owner: Hex; address: Hex }> = {}): DcaReceiptLog {
  const token = o.token ?? AUTH.assets[i].asset;
  const before = o.before ?? B(100);
  const min = o.min ?? MINS[i];
  return {
    address: o.address ?? EXECUTOR,
    topics: encodeEventTopics({ abi: DCA_EXECUTOR_ABI, eventName: 'AssetDelivered', args: { owner: o.owner ?? OWNER, authorizationId: o.id ?? ID, executionIndex: o.index ?? B(0) } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [o.recipient ?? RECIPIENT, token, before, o.after ?? before + min + B(7), min],
    ),
    logIndex: i, transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: B(1000),
  };
}
function purchaseLog(o: Partial<{ window: bigint; amountIn: bigint; count: bigint; index: bigint; recipient: Hex; logIndex: number }> = {}): DcaReceiptLog {
  return {
    address: EXECUTOR,
    topics: encodeEventTopics({ abi: DCA_EXECUTOR_ABI, eventName: 'PurchaseExecuted', args: { owner: OWNER, authorizationId: ID, executionIndex: o.index ?? B(0) } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [o.window ?? B(2), o.recipient ?? RECIPIENT, o.amountIn ?? B(10_000_000), o.count ?? B(2)],
    ),
    logIndex: o.logIndex ?? 10, transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: B(1000),
  };
}
const goodLogs = () => [deliveredLog(0), deliveredLog(1), purchaseLog()];

function client(o: Partial<{ logs: DcaReceiptLog[]; chainId: number; status: 'success' | 'reverted'; blockHash: Hex | null; time: bigint; head: bigint; missing: boolean; code: Hex }> = {}): DcaReceiptClient {
  return {
    getChainId: async () => o.chainId ?? 4663,
    getTransactionReceipt: async () => {
      if (o.missing) throw Object.assign(new Error('nope'), { name: 'TransactionReceiptNotFoundError' });
      return { transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: B(1000), status: o.status ?? 'success', logs: o.logs ?? goodLogs() };
    },
    getBlock: async () => ({ hash: o.blockHash === undefined ? BLOCK_HASH : o.blockHash, timestamp: o.time ?? START + B(2) * DAY + B(30) }),
    getBlockNumber: async () => o.head ?? B(1005),
    getCode: async () => o.code ?? '0x6001',
  };
}
// Logic tests below skip the code check explicitly; the code check itself is tested on its own.
const verify = (c: DcaReceiptClient, extra: Partial<Parameters<typeof verifyDcaReceipt>[0]> = {}) => verifyDcaReceipt({ client: c, transactionHash: TX, auth: AUTH, deployment: DEP, allowUncheckedExecutorCode: true, ...extra });
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe('verifyDcaReceipt', () => {
  it('VERIFIED: one PurchaseExecuted and one AssetDelivered per asset, in order, deltas ≥ minimums ≥ ceiling minimums', async () => {
    const r = await verify(client(), { executionIndex: B(0), expectedExecutorCodeHash: keccak256('0x6001') });
    expect(codes(r)).toEqual([]);
    expect(r.status).toBe('VERIFIED');
    expect(r.executorCodeChecked).toBe(true);
    expect(r.window).toBe(B(2));
    expect(r.deliveries.map((d) => d.satisfied)).toEqual([true, true]);
  });

  it('ignores events of another authorization in the same transaction (batched keeper)', async () => {
    const other = deliveredLog(0, { id: `0x${'99'.repeat(32)}` as Hex });
    expect((await verify(client({ logs: [other, ...goodLogs()] }))).status).toBe('VERIFIED');
  });

  const failing: [string, () => DcaReceiptLog[], string][] = [
    ['missing delivery', () => [deliveredLog(0), purchaseLog()], 'MISSING_DELIVERY'],
    ['duplicate delivery', () => [deliveredLog(0), deliveredLog(1), deliveredLog(1), purchaseLog()], 'DUPLICATE_DELIVERY'],
    ['unexpected token', () => [deliveredLog(0), deliveredLog(1), deliveredLog(1, { token: USDG }), purchaseLog()], 'UNEXPECTED_DELIVERY'],
    ['wrong recipient', () => [deliveredLog(0, { recipient: OWNER }), deliveredLog(1), purchaseLog()], 'RECIPIENT_MISMATCH'],
    ['delta below minimum', () => [deliveredLog(0, { after: B(100) + MINS[0] - B(1) }), deliveredLog(1), purchaseLog()], 'DELIVERY_BELOW_MINIMUM'],
    ['minimum below the signed ceiling', () => [deliveredLog(0, { min: MINS[0] - B(1) }), deliveredLog(1), purchaseLog()], 'MINIMUM_BELOW_CEILING'],
    ['no purchase event', () => [deliveredLog(0), deliveredLog(1)], 'NO_PURCHASE_EVENT'],
    ['two purchase events', () => [deliveredLog(0), deliveredLog(1), purchaseLog(), purchaseLog({ logIndex: 11 })], 'DUPLICATE_PURCHASE_EVENT'],
    ['wrong amount', () => [deliveredLog(0), deliveredLog(1), purchaseLog({ amountIn: B(1) })], 'PURCHASE_EVENT_MISMATCH'],
    ['wrong asset count', () => [deliveredLog(0), deliveredLog(1), purchaseLog({ count: B(3) })], 'PURCHASE_EVENT_MISMATCH'],
    ['window ≠ block time', () => [deliveredLog(0), deliveredLog(1), purchaseLog({ window: B(1) })], 'WINDOW_MISMATCH'],
    ['delivery for another index', () => [deliveredLog(0, { index: B(1) }), deliveredLog(1), purchaseLog()], 'EXECUTION_INDEX_MISMATCH'],
    ['delivery after the purchase event', () => [deliveredLog(0), purchaseLog({ logIndex: 1 }), { ...deliveredLog(1), logIndex: 2 }], 'DELIVERY_ORDER'],
    ['assets out of order', () => [{ ...deliveredLog(1), logIndex: 0 }, { ...deliveredLog(0), logIndex: 1 }, purchaseLog()], 'DELIVERY_ORDER'],
    ['undecodable executor log', () => [...goodLogs(), { ...purchaseLog(), topics: [`0x${'ee'.repeat(32)}` as Hex], logIndex: 12 }], 'UNDECODABLE_EXECUTOR_LOG'],
    ['events from another contract only', () => goodLogs().map((l) => ({ ...l, address: ADAPTER })), 'NO_PURCHASE_EVENT'],
  ];
  for (const [name, logs, code] of failing) {
    it(`FAILED: ${name}`, async () => {
      const r = await verify(client({ logs: logs() }));
      expect(r.status).toBe('FAILED');
      expect(codes(r)).toContain(code);
    });
  }

  it('FAILED: reverted transaction, wrong chain, unexpected execution index, executor code differs', async () => {
    expect(codes(await verify(client({ status: 'reverted' })))).toEqual(['TRANSACTION_REVERTED']);
    expect((await verify(client({ chainId: 1 }))).status).toBe('FAILED');
    expect(codes(await verify(client(), { executionIndex: B(3) }))).toContain('EXECUTION_INDEX_MISMATCH');
    expect(codes(await verify(client({ code: '0x6002' }), { expectedExecutorCodeHash: keccak256('0x6001') }))).toContain('EXECUTOR_CODE_MISMATCH');
  });

  it('INDETERMINATE, never VERIFIED, on missing or unstable evidence', async () => {
    expect((await verify(client({ missing: true }))).status).toBe('INDETERMINATE');
    expect((await verify(client({ blockHash: `0x${'dd'.repeat(32)}` }))).status).toBe('INDETERMINATE');
    expect((await verify(client({ head: B(1000) }), { minConfirmations: B(5) })).status).toBe('INDETERMINATE');
    expect((await verify(client({ logs: goodLogs().map((l) => ({ ...l, removed: true })) }))).status).toBe('INDETERMINATE');
    const broken: DcaReceiptClient = { ...client(), getBlock: async () => { throw new Error('rpc down'); } };
    expect((await verify(broken)).status).toBe('INDETERMINATE');
    const noCode: DcaReceiptClient = { ...client(), getCode: undefined };
    expect((await verify(noCode, { expectedExecutorCodeHash: keccak256('0x6001') })).status).toBe('INDETERMINATE');
  });

  it('without expectedExecutorCodeHash the result is at most INDETERMINATE (EXECUTOR_CODE_UNCHECKED), never VERIFIED', async () => {
    const r = await verify(client(), { allowUncheckedExecutorCode: false });
    expect(r.status).toBe('INDETERMINATE');
    expect(codes(r)).toEqual(['EXECUTOR_CODE_UNCHECKED']);
    expect((await verify(client(), { allowUncheckedExecutorCode: false, expectedExecutorCodeHash: keccak256('0x6001') })).status).toBe('VERIFIED');
  });

  it('the id binds the deployment: the same logs do not verify an authorization for another executor', async () => {
    const r = await verifyDcaReceipt({ client: client(), transactionHash: TX, auth: AUTH, deployment: { chainId: 4663, executor: ADAPTER } });
    expect(r.status).toBe('FAILED');
    expect(codes(r)).toContain('NO_PURCHASE_EVENT');
  });
});
