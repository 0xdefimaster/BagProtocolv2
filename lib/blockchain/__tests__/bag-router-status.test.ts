import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, parseAbiItem } from 'viem';

const getTransactionReceiptMock = vi.fn();
const createPublicClientMock = vi.fn((..._args: unknown[]) => ({ getTransactionReceipt: getTransactionReceiptMock }));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: (...args: unknown[]) => createPublicClientMock(...args),
  };
});

const { trackBagRouterTransaction } = await import('../bag-router-status');

// -----------------------------------------------------------------------------
// Bag Router execution hardening, item 4 — provider-specific verification.
// `createPublicClient` is mocked (no real RPC call); `decodeEventLog`/
// `parseAbiItem`/`encodeEventTopics` are the REAL viem implementations, and
// every log fed to `getTransactionReceiptMock` below is built with them, so
// these tests exercise the actual ABI decoding/matching logic, not a stub.
// -----------------------------------------------------------------------------

/** Left-pads a short hex suffix to a full 20-byte, checksummed address — every literal address in this file goes through this rather than hand-counting zeros. */
function addr(suffix: string): `0x${string}` {
  return getAddress(`0x${suffix.padStart(40, '0')}`);
}

const ROUTER_ADDRESS = addr('aa');
const WALLET = addr('bb');
const NVDA = addr('aaaa01');
const AAPL = addr('bbbb02');
const BAG_ID = pad('0x01');
const PLAN_HASH = pad('0x02');
const INPUT_TOKEN = addr('cccc03');

const EXECUTION_COMPLETED_EVENT = parseAbiItem(
  'event ExecutionCompleted(bytes32 indexed bagId, bytes32 indexed executionPlanHash, address indexed wallet, address inputToken, uint256 inputAmount, uint256 legCount)'
);
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function executionCompletedLog(overrides: {
  address?: string;
  bagId?: `0x${string}`;
  executionPlanHash?: `0x${string}`;
  wallet?: string;
  inputToken?: string;
  inputAmount?: bigint;
  legCount?: bigint;
} = {}) {
  const bagId = overrides.bagId ?? BAG_ID;
  const executionPlanHash = overrides.executionPlanHash ?? PLAN_HASH;
  const wallet = overrides.wallet ?? WALLET;
  const inputToken = overrides.inputToken ?? INPUT_TOKEN;
  const inputAmount = overrides.inputAmount ?? BigInt(100_000_000);
  const legCount = overrides.legCount ?? BigInt(2);

  const topics = encodeEventTopics({
    abi: [EXECUTION_COMPLETED_EVENT],
    eventName: 'ExecutionCompleted',
    args: { bagId, executionPlanHash, wallet: wallet as `0x${string}` },
  });
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    [inputToken as `0x${string}`, inputAmount, legCount]
  );
  return { address: overrides.address ?? ROUTER_ADDRESS, topics, data };
}

function transferLog(token: string, to: string, value: bigint, from = addr('dddd06')) {
  const topics = encodeEventTopics({
    abi: [TRANSFER_EVENT],
    eventName: 'Transfer',
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }], [value]);
  return { address: token, topics, data };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RPC_URL_ETHEREUM = 'https://rpc.example';
});

const baseInput = () => ({
  txHash: '0xabc',
  chain: 'ethereum' as const,
  routerAddress: ROUTER_ADDRESS,
  recipient: WALLET,
  expectedBagId: BAG_ID,
  expectedExecutionPlanHash: PLAN_HASH.slice(2), // persisted WITHOUT 0x — normalizeHex must still match
  expectedInputToken: INPUT_TOKEN,
  expectedInputAmountRaw: '100000000',
  expectedLegCount: 2,
  expectedOutputTokens: [NVDA, AAPL],
});

describe('trackBagRouterTransaction', () => {
  it('returns PENDING when the receipt cannot be found yet', async () => {
    getTransactionReceiptMock.mockRejectedValue(new Error('not found'));
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome).toEqual({ kind: 'PENDING' });
  });

  it('FAILED/TRANSACTION_REVERTED when the receipt status is not success — a revert is never treated as success', async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: 'reverted', logs: [] });
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome).toEqual({ kind: 'FAILED', failureCode: 'TRANSACTION_REVERTED', message: expect.any(String) });
  });

  it('FAILED/VERIFICATION_FAILED when no ExecutionCompleted event is found at all', async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: 'success', logs: [] });
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome.kind).toBe('FAILED');
    if (outcome.kind !== 'FAILED') return;
    expect(outcome.failureCode).toBe('VERIFICATION_FAILED');
  });

  it('never trusts an ExecutionCompleted-shaped event from a DIFFERENT contract address (correct BagRouter contract check)', async () => {
    getTransactionReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [executionCompletedLog({ address: addr('fff') })],
    });
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome.kind).toBe('FAILED');
    if (outcome.kind !== 'FAILED') return;
    expect(outcome.failureCode).toBe('VERIFICATION_FAILED');
  });

  it('FAILED/VERIFICATION_FAILED when the event wallet does not match the expected recipient', async () => {
    getTransactionReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [executionCompletedLog({ wallet: addr('eeee04') })],
    });
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome.kind).toBe('FAILED');
    if (outcome.kind !== 'FAILED') return;
    expect(outcome.failureCode).toBe('VERIFICATION_FAILED');
    expect(outcome.message).toContain('wallet');
  });

  it('FAILED/VERIFICATION_FAILED when the event bagId does not match (wrong plan identity)', async () => {
    getTransactionReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [executionCompletedLog({ bagId: pad('0x99') })],
    });
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome.kind).toBe('FAILED');
    if (outcome.kind !== 'FAILED') return;
    expect(outcome.message).toContain('bagId');
  });

  it('FAILED/VERIFICATION_FAILED when the input amount does not match', async () => {
    getTransactionReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [executionCompletedLog({ inputAmount: BigInt(999) })],
    });
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome.kind).toBe('FAILED');
    if (outcome.kind !== 'FAILED') return;
    expect(outcome.message).toContain('inputAmount');
  });

  it('DONE with correctly-summed received amounts, restricted to the expected output tokens and recipient — an unrelated Transfer log is ignored', async () => {
    getTransactionReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [
        executionCompletedLog(),
        transferLog(NVDA, WALLET, BigInt(9_950_000_000_000_000_000)),
        transferLog(AAPL, WALLET, BigInt(3_950_000_000_000_000_000)),
        // Not one of this plan's declared output tokens — must be ignored,
        // never summed into any credited amount (the "arbitrary Transfer
        // log" over-crediting risk item 4 warns against).
        transferLog(addr('dead05'), WALLET, BigInt(1_000_000_000_000_000_000)),
        // Same output token, but to a DIFFERENT address — must be ignored.
        transferLog(NVDA, addr('eeee04'), BigInt(1_000_000_000_000_000_000)),
      ],
    });

    const outcome = await trackBagRouterTransaction(baseInput());

    expect(outcome.kind).toBe('DONE');
    if (outcome.kind !== 'DONE') return;
    expect(outcome.receivedAmountsByAddress[NVDA.toLowerCase()]).toBe('9950000000000000000');
    expect(outcome.receivedAmountsByAddress[AAPL.toLowerCase()]).toBe('3950000000000000000');
    expect(outcome.receivedAmountsByAddress[addr('dead05').toLowerCase()]).toBeUndefined();
  });

  it('sums multiple Transfer logs to the same expected output token (duplicate legs into the same asset)', async () => {
    getTransactionReceiptMock.mockResolvedValue({
      status: 'success',
      logs: [executionCompletedLog(), transferLog(NVDA, WALLET, BigInt(5_000_000_000_000_000_000)), transferLog(NVDA, WALLET, BigInt(4_950_000_000_000_000_000))],
    });

    const outcome = await trackBagRouterTransaction(baseInput());

    expect(outcome.kind).toBe('DONE');
    if (outcome.kind !== 'DONE') return;
    expect(outcome.receivedAmountsByAddress[NVDA.toLowerCase()]).toBe('9950000000000000000');
  });

  it('FAILED/PROVIDER_ERROR when no RPC URL is configured for the chain', async () => {
    delete process.env.RPC_URL_ETHEREUM;
    const outcome = await trackBagRouterTransaction(baseInput());
    expect(outcome).toEqual({ kind: 'FAILED', failureCode: 'PROVIDER_ERROR', message: expect.any(String) });
    expect(getTransactionReceiptMock).not.toHaveBeenCalled();
  });
});
