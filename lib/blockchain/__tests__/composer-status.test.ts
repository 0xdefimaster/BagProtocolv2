import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';

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

const { trackComposerTransaction } = await import('../composer-status');

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
