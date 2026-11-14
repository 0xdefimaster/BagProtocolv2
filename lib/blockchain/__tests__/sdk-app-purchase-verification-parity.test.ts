import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, parseAbiItem, type Hex } from 'viem';
import { composeResponse, wireOut } from './composer-fixtures';
import { compileBag, METAMASK_EIP7702_STATELESS_DELEGATOR as MM, parseBag, planPurchase, SELF_AUTHORIZED_PERMISSION_CONTEXT as EMPTY_CONTEXT, verifyPurchaseReceipt, type BagDocument, type CompiledPurchase } from '@/packages/bag-sdk/src';
import { lifiComposer } from '@/packages/bag-sdk/src/adapters/lifi';

// -----------------------------------------------------------------------------
// SDK-first vertical slice, end to end, both implementations side by side
// (docs/architecture/SDK_FIRST_MIGRATION_PLAN.md, milestone M1):
//
//   bag.json → parseBag → planPurchase → compile (BAG buildComposerPurchase ↔ SDK compileBag + lifiComposer)
//            → the transaction the wallet signs → one mined receipt
//            → verify (BAG trackComposerTransaction ↔ SDK verifyPurchaseReceipt, TRANSFER_LOGS)
//
// sdk-app-composer-flow-parity.test.ts already proves both adapters send Composer the same program. This file
// proves the next two links: both produce the same transaction to sign, and both reach the same verdict and the
// same per-token received amounts on the same receipt. Where the verdicts differ on purpose, the difference is
// pinned here (D-1) so that changing either side is a deliberate decision. No production code is involved
// beyond the two real implementations; HTTP and the chain reader are fixtures.
// -----------------------------------------------------------------------------

const getTransactionMock = vi.fn();
const getReceiptMock = vi.fn();
const getCodeMock = vi.fn();
const getTransactionCountMock = vi.fn();
vi.mock('@/lib/blockchain/rpc/clients', () => ({
  hasRpcEndpoint: () => true,
  getChainPublicClient: () => ({
    getTransaction: (...a: unknown[]) => getTransactionMock(...a),
    getTransactionReceipt: (...a: unknown[]) => getReceiptMock(...a),
    getCode: (...a: unknown[]) => getCodeMock(...a),
    getTransactionCount: (...a: unknown[]) => getTransactionCountMock(...a),
    getBlock: async () => ({ transactions: [] }),
  }),
}));
const { trackComposerTransaction } = await import('../composer-status');
const { buildComposerPurchase } = await import('../lifi-composer-adapter');

const CHAIN_ID = 4663;
const USDG = ('0x' + 'c'.repeat(40)) as Hex;
const SIGNER = ('0x' + '5'.repeat(40)) as Hex;
const ROUTER = ('0x' + '7'.repeat(40)) as Hex;
const PROXY = ('0x' + '8'.repeat(40)) as Hex;
const CALLDATA = ('0x12345678' + 'ab'.repeat(100)) as Hex;
const TX_HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const BLOCK_HASH = ('0x' + 'cd'.repeat(32)) as Hex;
const token = (i: number) => ('0x' + (0x1000 + i * 7919).toString(16).padStart(8, '0') + 'd'.repeat(32)) as Hex;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function bag(weights: number[]): BagDocument {
  const r = parseBag({
    bagJson: 1,
    definition: {
      kind: 'STATIC_BASKET', chain: 'robinhood', mutability: 'MUTABLE',
      assets: weights.map((weightBps, i) => ({ chain: 'robinhood', address: token(i), decimals: 18, weightBps })),
      rules: { weightBounds: { minBps: 1, maxBps: 10000 }, maxAssets: 100, minInvestment: null, swapSlippageBps: 100, rebalance: null, performanceFeeBps: null, noRouteAssetPolicy: null },
    },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.bag;
}

/** Composer's compile answer for `tokens`, identical for both adapters: expected 1000, guaranteed 990 per leg. */
function composerFetch(tokens: string[]) {
  return (async () => {
    const outputs = Object.fromEntries(tokens.map((t, i) => [`swap_${i}.amountOut`, { ...wireOut(1000, 990, t), owner: SIGNER }]));
    return composeResponse({
      data: {
        outputs, transactionRequest: { to: ROUTER, chainId: CHAIN_ID, data: CALLDATA, value: '0' }, userProxy: PROXY, approvals: [],
        priceImpact: { inputValueUsd: 100, outputValueUsd: 99, impactBps: 100, unpricedInputs: [], unpricedOutputs: [] }, fees: [],
      },
    });
  }) as unknown as typeof fetch;
}

function transferLog(tokenAddress: Hex, to: Hex, value: bigint, logIndex: number, from: Hex = PROXY) {
  return {
    address: tokenAddress,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex, transactionHash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: BigInt(10), removed: false,
  };
}

/** One chain observation served to BOTH verifiers: the app's resilient RPC mock and the SDK's caller-owned reader. */
function observe(tx: { from: Hex; to: Hex; input: Hex; value: bigint }, status: 'success' | 'reverted', logs: ReturnType<typeof transferLog>[]) {
  const transaction = { hash: TX_HASH, ...tx, chainId: CHAIN_ID, blockHash: BLOCK_HASH, blockNumber: BigInt(10) };
  const receipt = { transactionHash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: BigInt(10), from: tx.from, to: tx.to, status, logs };
  getTransactionMock.mockResolvedValue(transaction);
  getReceiptMock.mockResolvedValue(receipt);
  return {
    getChainId: vi.fn(async () => CHAIN_ID),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: BLOCK_HASH })),
    getBlockNumber: vi.fn(async () => BigInt(12)),
  };
}

async function compileBoth(weights: number[]) {
  const doc = bag(weights);
  const deposit = BigInt(50_000_000);
  const plan = planPurchase(doc, { inputToken: USDG, amountRaw: deposit, signer: SIGNER });
  const tokens = plan.legs.map((l) => l.token);
  const sdk: CompiledPurchase = await compileBag(doc, { inputToken: USDG, amountRaw: deposit, signer: SIGNER }, {
    provider: lifiComposer({ apiKey: 'k', baseUrl: 'https://composer.test', fetch: composerFetch(tokens) }),
    trust: { chainId: CHAIN_ID, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [] },
  });
  const app = await buildComposerPurchase({
    chain: 'robinhood', inputTokenAddress: USDG, inputAmountRaw: plan.swapAmountRaw.toString(),
    legs: plan.legs.map((l) => ({ address: l.token, weightBps: l.legBps, symbol: l.token })),
    signerAddress: SIGNER, slippageBps: plan.slippageBps, maxPriceImpactBps: plan.maxPriceImpactBps,
    apiKey: 'k', fetchImpl: composerFetch(tokens),
  });
  return { tokens: tokens as Hex[], sdk, app, expected: { to: app.transactionRequest.to, data: app.transactionRequest.data, value: app.transactionRequest.value } };
}

async function verifyBoth(c: Awaited<ReturnType<typeof compileBoth>>, client: ReturnType<typeof observe>) {
  const app = await trackComposerTransaction({ txHash: TX_HASH, chain: 'robinhood', recipient: SIGNER, expectedTransaction: c.expected });
  const sdk = await verifyPurchaseReceipt(c.sdk, {
    client, transactionHash: TX_HASH, verification: 'TRANSFER_LOGS',
    minimumReceived: c.tokens.map((t) => ({ token: t, amountRaw: BigInt(990) })),
  });
  return { app, sdk };
}

const WEIGHTS: [string, number[]][] = [
  ['2 assets', [4000, 6000]],
  ['5 uneven assets', [1, 999, 3000, 2500, 3500]],
];

beforeEach(() => {
  getTransactionMock.mockReset();
  getReceiptMock.mockReset();
});

describe('SDK ↔ BAG app, one purchase end to end: same transaction to sign, same verdict on the same receipt', () => {
  for (const [name, weights] of WEIGHTS) {
    it(`${name}: both compile the same transaction and both verify the direct call with the same amounts`, async () => {
      const c = await compileBoth(weights);
      expect({ to: c.sdk.transaction.to, data: c.sdk.transaction.data, value: c.sdk.transaction.value.toString() }).toEqual(c.expected);

      const client = observe({ from: SIGNER, to: ROUTER, input: CALLDATA, value: BigInt(0) }, 'success',
        c.tokens.map((t, i) => transferLog(t, SIGNER, BigInt(1000 + i), i)));
      const { app, sdk } = await verifyBoth(c, client);

      expect(app.kind).toBe('DONE');
      expect(sdk.status).toBe('VERIFIED');
      expect(sdk.transactionBinding).toBe('DIRECT');
      expect(sdk.accounting).toBe('NOT_BAG_ACCOUNTED');
      const appReceived = app.kind === 'DONE' ? app.receivedAmountsByAddress : {};
      const sdkReceived = Object.fromEntries(sdk.outputs.map((o) => [o.token.toLowerCase(), o.receivedRaw.toString()]));
      expect(appReceived).toEqual(sdkReceived);
    });
  }

  const refusals: [string, { tx?: Partial<{ from: Hex; to: Hex; input: Hex; value: bigint }>; status?: 'reverted' }, string, string][] = [
    ['another calldata', { tx: { input: (CALLDATA.slice(0, -2) + 'cd') as Hex } }, 'VERIFICATION_FAILED', 'TRANSACTION_MISMATCH'],
    ['another sender', { tx: { from: ('0x' + '9'.repeat(40)) as Hex } }, 'VERIFICATION_FAILED', 'TRANSACTION_MISMATCH'],
    ['another native value', { tx: { value: BigInt(1) } }, 'VERIFICATION_FAILED', 'TRANSACTION_MISMATCH'],
    ['a reverted transaction', { status: 'reverted' }, 'TRANSACTION_REVERTED', 'TRANSACTION_REVERTED'],
  ];
  for (const [label, change, appCode, sdkCode] of refusals) {
    it(`both refuse ${label}`, async () => {
      const c = await compileBoth([4000, 6000]);
      const client = observe({ from: SIGNER, to: ROUTER, input: CALLDATA, value: BigInt(0), ...change.tx }, change.status ?? 'success',
        c.tokens.map((t, i) => transferLog(t, SIGNER, BigInt(1000), i)));
      const { app, sdk } = await verifyBoth(c, client);
      expect(app).toMatchObject({ kind: 'FAILED', failureCode: appCode });
      expect(sdk.status).toBe('FAILED');
      expect(sdk.issues[0].code).toBe(sdkCode);
    });
  }

  // D-1, a deliberate difference: a smart-account wallet batch (EIP-7702) that carries the exact call.
  // BAG accepts it by calldata containment (and credits every Transfer to the wallet, see T-1 in
  // composer-status.test.ts); the SDK will not bind a batch without execution-trace evidence.
  it('D-1: a wallet batch carrying the exact call is DONE for BAG and INDETERMINATE for the SDK without a trace', async () => {
    const c = await compileBoth([4000, 6000]);
    const batch = encodeFunctionData({
      abi: parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']),
      functionName: 'execute',
      args: [pad('0x01', { dir: 'right', size: 32 }), encodeAbiParameters(
        [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
        [[[ROUTER, BigInt(0), CALLDATA]]],
      )],
    });
    const client = observe({ from: SIGNER, to: SIGNER, input: batch, value: BigInt(0) }, 'success',
      c.tokens.map((t, i) => transferLog(t, SIGNER, BigInt(1000), i)));
    const { app, sdk } = await verifyBoth(c, client);
    expect(app.kind).toBe('DONE');
    expect(sdk.status).toBe('INDETERMINATE');
    expect(sdk.issues[0].code).toBe('UNSUPPORTED_TRANSACTION_ENVELOPE');
  });
});

// -----------------------------------------------------------------------------
// M2: the same shared exact binding on both sides (app BAG_WALLET_BATCH_BINDING=enforce, SDK smartAccountBinding
// 'EXACT'). The app's verdict and the SDK's now agree on smart-account envelopes too: D-1 is resolved, and the
// T-1 and F-01 envelopes are refused (or left unverified) by both.
// -----------------------------------------------------------------------------
describe('with the exact binding on both sides (enforce / EXACT)', () => {
  const REDEEM = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
  const ERC20 = parseAbi(['function transferFrom(address from, address to, uint256 amount)']);
  const OTHER = ('0x' + '9'.repeat(40)) as Hex;
  const single = (target: Hex, data: Hex) => (target + pad('0x00', { size: 32 }).slice(2) + data.slice(2)) as Hex;
  const redeem = (datas: Hex[], modes: Hex[]) => encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [datas.map(() => EMPTY_CONTEXT), modes, datas] });
  const MODE_SINGLE = pad('0x00', { size: 32 });

  function observeExact(to: Hex, input: Hex, logs: ReturnType<typeof transferLog>[]) {
    const transaction = { hash: TX_HASH, from: SIGNER, to, input, value: BigInt(0), chainId: CHAIN_ID, blockHash: BLOCK_HASH, blockNumber: BigInt(10), nonce: 7, type: 'eip1559' };
    const receipt = { transactionHash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: BigInt(10), from: SIGNER, to, status: 'success' as const, logs };
    getTransactionMock.mockResolvedValue(transaction);
    getReceiptMock.mockResolvedValue(receipt);
    getCodeMock.mockResolvedValue(('0xef0100' + MM.delegate.slice(2)) as Hex);
    getTransactionCountMock.mockResolvedValue(7);
    return {
      getChainId: vi.fn(async () => CHAIN_ID),
      getTransaction: vi.fn(async () => transaction),
      getTransactionReceipt: vi.fn(async () => receipt),
      getBlock: vi.fn(async () => ({ hash: BLOCK_HASH })),
      getBlockNumber: vi.fn(async () => BigInt(12)),
      getCode: vi.fn(async () => ('0xef0100' + MM.delegate.slice(2)) as Hex),
      getTransactionCount: vi.fn(async () => 7),
    };
  }

  async function verifyExactBoth(c: Awaited<ReturnType<typeof compileBoth>>, client: ReturnType<typeof observeExact>) {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    try {
      const app = await trackComposerTransaction({ txHash: TX_HASH, chain: 'robinhood', recipient: SIGNER, expectedTransaction: c.expected, expectedApprovals: [], flow: 'purchase' });
      const sdk = await verifyPurchaseReceipt(c.sdk, {
        client, transactionHash: TX_HASH, verification: 'TRANSFER_LOGS', smartAccountBinding: 'EXACT',
        minimumReceived: c.tokens.map((t) => ({ token: t, amountRaw: BigInt(990) })),
      });
      return { app, sdk };
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('D-1 resolved: a MetaMask DelegationManager envelope carrying the call binds on both sides, with the same amounts', async () => {
    const c = await compileBoth([4000, 6000]);
    const client = observeExact(MM.delegationManager, redeem([single(ROUTER, CALLDATA)], [MODE_SINGLE]), c.tokens.map((t, i) => transferLog(t, SIGNER, BigInt(1000 + i), i)));
    const { app, sdk } = await verifyExactBoth(c, client);
    expect(app.kind).toBe('DONE');
    expect(sdk.status).toBe('VERIFIED');
    expect(sdk.transactionBinding).toBe('WALLET_BATCH_EXACT');
    const appReceived = app.kind === 'DONE' ? app.receivedAmountsByAddress : {};
    expect(appReceived).toEqual(Object.fromEntries(sdk.outputs.map((o) => [o.token.toLowerCase(), o.receivedRaw.toString()])));
  });

  it('T-1 refused on both sides: a sibling transfer next to the call', async () => {
    const c = await compileBoth([4000, 6000]);
    const sibling = encodeFunctionData({ abi: ERC20, functionName: 'transferFrom', args: [OTHER, SIGNER, BigInt(5000)] });
    const input = redeem([single(ROUTER, CALLDATA), single(c.tokens[0], sibling)], [MODE_SINGLE, MODE_SINGLE]);
    const logs = [...c.tokens.map((t, i) => transferLog(t, SIGNER, BigInt(1000), i)), transferLog(c.tokens[0], SIGNER, BigInt(5000), 9, OTHER)];
    const { app, sdk } = await verifyExactBoth(c, observeExact(MM.delegationManager, input, logs));
    expect(app).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED', message: expect.stringMatching(/UNEXPECTED_CALL/) });
    expect(sdk).toMatchObject({ status: 'FAILED', walletBindingIssue: 'UNEXPECTED_CALL' });
  });

  it('F-01 never passes on either side: the envelope sent to an unpinned contract', async () => {
    const c = await compileBoth([4000, 6000]);
    const client = observeExact(OTHER, redeem([single(ROUTER, CALLDATA)], [MODE_SINGLE]), c.tokens.map((t, i) => transferLog(t, SIGNER, BigInt(1000), i)));
    const { app, sdk } = await verifyExactBoth(c, client);
    expect(app).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/UNSUPPORTED_ENVELOPE/) });
    expect(sdk.status).toBe('INDETERMINATE');
    expect(sdk.issues[0].code).toBe('UNSUPPORTED_TRANSACTION_ENVELOPE');
  });
});
