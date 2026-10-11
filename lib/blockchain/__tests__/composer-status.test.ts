import { beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, parseAbiItem, toHex, type Hex } from 'viem';

// Security invariant: only the exact Composer transaction the server built
// for an intent can complete it — never some other successful tx that also
// moved the expected token into the wallet.

const getTransactionMock = vi.fn();
const getReceiptMock = vi.fn();

vi.mock('@/lib/blockchain/rpc/clients', () => ({
  hasRpcEndpoint: () => true,
  getChainPublicClient: () => ({
    getTransaction: (...a: unknown[]) => getTransactionMock(...a),
    getTransactionReceipt: (...a: unknown[]) => getReceiptMock(...a),
  }),
}));

const { trackComposerTransaction, batchContainsCall } = await import('../composer-status');

const WALLET = '0x1111111111111111111111111111111111111111';
const COMPOSER = '0x4444444444444444444444444444444444444444';
const TOKEN = '0x3333333333333333333333333333333333333333';
const TX = `0x${'ab'.repeat(32)}`;
const DATA = '0xdeadbeef';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function transferLog(to: string, value: bigint, from = COMPOSER, address = TOKEN) {
  return {
    address,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

const input = { txHash: TX, chain: 'robinhood' as const, recipient: WALLET, expectedTransaction: { to: COMPOSER, data: DATA, value: '0' } };

beforeEach(() => {
  getReceiptMock.mockResolvedValue({ status: 'success', logs: [transferLog(WALLET, BigInt(500))] });
  getTransactionMock.mockResolvedValue({ from: WALLET, to: COMPOSER, input: DATA, value: BigInt(0) });
});

describe('trackComposerTransaction', () => {
  it('verifies the exact transaction built for the intent', async () => {
    const outcome = await trackComposerTransaction(input);
    expect(outcome).toEqual({ kind: 'DONE', receivedAmountsByAddress: { [TOKEN]: '500' }, sentAmountsByAddress: {} });
  });

  it('also reports what the wallet sent (what a sale took), per token, summed', async () => {
    const SOLD = '0x6666666666666666666666666666666666666666';
    getReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [transferLog(COMPOSER, BigInt(70), WALLET, SOLD), transferLog(COMPOSER, BigInt(30), WALLET, SOLD), transferLog(WALLET, BigInt(500))],
    });
    expect(await trackComposerTransaction(input)).toEqual({ kind: 'DONE', receivedAmountsByAddress: { [TOKEN]: '500' }, sentAmountsByAddress: { [SOLD]: '100' } });
  });

  const cases: [string, Record<string, unknown>][] = [
    ['sent by another wallet', { from: '0x9999999999999999999999999999999999999999' }],
    ['sent to another contract', { to: '0x5555555555555555555555555555555555555555' }],
    ['different calldata (e.g. a tiny self-built swap)', { input: '0xcafebabe' }],
    ['different value', { value: BigInt(1) }],
  ];
  for (const [label, override] of cases) {
    it(`rejects an unrelated successful tx that still delivered the token: ${label}`, async () => {
      getTransactionMock.mockResolvedValue({ from: WALLET, to: COMPOSER, input: DATA, value: BigInt(0), ...override });
      const outcome = await trackComposerTransaction(input);
      expect(outcome).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    });
  }
});

// -----------------------------------------------------------------------------
// Wallet batches (EIP-5792 over an EIP-7702 account, e.g. MetaMask): one transaction from the wallet to
// itself runs the approvals and the Composer call. It completes the intent only when the exact Composer
// call is one of the batched calls.
// -----------------------------------------------------------------------------

const BATCH_ABI = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)']);
const COMPOSER_DATA = ('0x12345678' + 'ab'.repeat(100)) as Hex;
const APPROVE = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), args: [COMPOSER as Hex, BigInt(9)] });
type Call = { target: Hex; value: bigint; data: Hex };
const calls = (composer: Partial<Call> = {}): Call[] => [
  { target: TOKEN as Hex, value: BigInt(0), data: APPROVE },
  { target: COMPOSER as Hex, value: BigInt(0), data: COMPOSER_DATA, ...composer },
];
/** ERC-7579 batch mode: execute(mode, abi.encode(Execution[])). */
const erc7579Batch = (c: Call[]) =>
  encodeFunctionData({
    abi: BATCH_ABI,
    functionName: 'execute',
    args: [pad('0x01', { dir: 'right', size: 32 }), encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }], [c.map((x) => [x.target, x.value, x.data] as const)])],
  });
const executeBatch = (c: Call[]) => encodeFunctionData({ abi: BATCH_ABI, functionName: 'executeBatch', args: [c] });
/** ERC-7579 single mode: execute(0x00…, target ‖ value ‖ data). */
const erc7579Single = (c: Call) => encodeFunctionData({ abi: BATCH_ABI, functionName: 'execute', args: [pad('0x00', { size: 32 }), concat([c.target, pad(toHex(c.value), { size: 32 }), c.data])] });

const batchInput = { ...input, expectedTransaction: { to: COMPOSER, data: COMPOSER_DATA, value: '0' } };

describe('trackComposerTransaction: wallet batches', () => {
  for (const [label, encoded] of [
    ['ERC-7579 batch', erc7579Batch(calls())],
    ['executeBatch(Call[])', executeBatch(calls())],
    ['ERC-7579 single execution', erc7579Single(calls()[1])],
  ] as const) {
    it(`accepts a batch from the wallet to itself that carries the exact Composer call: ${label}`, async () => {
      getTransactionMock.mockResolvedValue({ from: WALLET, to: WALLET, input: encoded, value: BigInt(0) });
      expect(await trackComposerTransaction(batchInput)).toMatchObject({ kind: 'DONE', receivedAmountsByAddress: { [TOKEN]: '500' } });
    });
  }

  const rejected: [string, Record<string, unknown>][] = [
    ['another wallet batching to itself', { from: '0x9999999999999999999999999999999999999999', to: '0x9999999999999999999999999999999999999999' }],
    ['a batch sent to another contract', { to: '0x5555555555555555555555555555555555555555' }],
    ['the Composer call with other calldata', { input: erc7579Batch(calls({ data: ('0x12345678' + 'cd'.repeat(100)) as Hex })) }],
    ['the Composer calldata sent to another target', { input: erc7579Batch(calls({ target: '0x5555555555555555555555555555555555555555' })) }],
    ['the Composer call with another value', { input: erc7579Batch(calls({ value: BigInt(1) })) }],
    ['only a prefix of the Composer calldata', { input: erc7579Batch(calls({ data: COMPOSER_DATA.slice(0, 100) as Hex })) }],
    ['a batch with only the approvals', { input: erc7579Batch(calls().slice(0, 1)) }],
  ];
  for (const [label, override] of rejected) {
    it(`rejects ${label}`, async () => {
      getTransactionMock.mockResolvedValue({ from: WALLET, to: WALLET, input: erc7579Batch(calls()), value: BigInt(0), ...override });
      expect(await trackComposerTransaction(batchInput)).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    });
  }

  it('a batch whose Composer call reverted the transaction is reported as reverted, never done', async () => {
    getTransactionMock.mockResolvedValue({ from: WALLET, to: WALLET, input: erc7579Batch(calls()), value: BigInt(0) });
    getReceiptMock.mockResolvedValue({ status: 'reverted', logs: [] });
    expect(await trackComposerTransaction(batchInput)).toMatchObject({ kind: 'FAILED', failureCode: 'TRANSACTION_REVERTED' });
  });

  it('batchContainsCall refuses empty calldata and misaligned matches', () => {
    expect(batchContainsCall(erc7579Batch(calls()), { to: COMPOSER, data: '0x', value: '0' })).toBe(false);
    // The calldata shifted by one nibble inside another blob is not a call.
    const shifted = ('0x99999999' + '0' + COMPOSER_DATA.slice(2) + '0') as Hex;
    expect(batchContainsCall(shifted, { to: COMPOSER, data: COMPOSER_DATA, value: '0' })).toBe(false);
  });
});
