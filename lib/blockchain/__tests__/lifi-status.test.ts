import { beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Security invariant: a successful transaction that is NOT this intent's own
// execution must never verify — "LI.FI says DONE and the right token
// arrived" is not proof of anything on its own.
// -----------------------------------------------------------------------------

const getStatusMock = vi.fn();
const getTransactionMock = vi.fn();
const getTransactionReceiptMock = vi.fn();
let rpcConfigured = false;

vi.mock('@lifi/sdk', () => ({ getStatus: (...args: unknown[]) => getStatusMock(...args) }));
vi.mock('../lifi-config', () => ({ getLiFiClient: () => ({}), toLiFiChainId: () => 1 }));
vi.mock('../lifi-execution-adapter', () => ({ mapLiFiError: (err: Error) => ({ message: err.message }) }));
vi.mock('@/lib/blockchain/rpc/clients', () => ({
  hasRpcEndpoint: () => rpcConfigured,
  getChainPublicClient: () => ({
    getTransaction: (...args: unknown[]) => getTransactionMock(...args),
    getTransactionReceipt: (...args: unknown[]) => getTransactionReceiptMock(...args),
  }),
}));

const { trackStepStatus } = await import('../lifi-status');

const WALLET = '0x1111111111111111111111111111111111111111';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const USDC = '0x2222222222222222222222222222222222222222';
const WETH = '0x3333333333333333333333333333333333333333';
const TX = `0x${'ab'.repeat(32)}`;

const input = {
  txHash: TX,
  sourceChain: 'ethereum' as const,
  destinationChain: 'ethereum' as const,
  tool: 'uniswap',
  expectedOutputAsset: { chain: 'ethereum' as const, address: WETH },
  expectedWallet: WALLET,
  expectedInputAsset: { chain: 'ethereum' as const, address: USDC },
  expectedInputAmountRaw: '1000000000',
  minOutputRaw: '400000000000000000',
};

function doneStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: 'DONE',
    fromAddress: WALLET,
    toAddress: WALLET,
    sending: { txHash: TX, amount: '1000000000', token: { address: USDC } },
    receiving: { txHash: TX, amount: '420000000000000000', token: { address: WETH } },
    ...overrides,
  };
}

beforeEach(() => {
  getStatusMock.mockReset();
  getTransactionMock.mockReset();
  getTransactionReceiptMock.mockReset();
  rpcConfigured = false;
});

describe('trackStepStatus — binding the reported tx to the intent', () => {
  it('verifies the intent\'s own execution', async () => {
    getStatusMock.mockResolvedValue(doneStatus());
    const outcome = await trackStepStatus(input);
    expect(outcome).toMatchObject({ kind: 'DONE', matchesExpectedAsset: true, receivedAmountRaw: '420000000000000000' });
  });

  const rejects: [string, Record<string, unknown>][] = [
    ['someone else sent it', { fromAddress: ATTACKER }],
    ['it paid out to someone else', { toAddress: ATTACKER }],
    ['it spent a different token', { sending: { txHash: TX, amount: '1000000000', token: { address: WETH } } }],
    ['it spent less than the step (a tiny swap reported for a big intent)', { sending: { txHash: TX, amount: '1', token: { address: USDC } } }],
    ['it delivered less than the minimum output', { receiving: { amount: '1', token: { address: WETH } } }],
    ['the status describes a different transaction', { sending: { txHash: `0x${'cd'.repeat(32)}`, amount: '1000000000', token: { address: USDC } } }],
    ['LI.FI gives no sender at all', { fromAddress: undefined }],
  ];
  for (const [label, overrides] of rejects) {
    it(`rejects an unrelated successful tx: ${label}`, async () => {
      getStatusMock.mockResolvedValue(doneStatus(overrides));
      const outcome = await trackStepStatus(input);
      expect(outcome).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    });
  }

  it('rejects when the chain says a different wallet sent the transaction', async () => {
    rpcConfigured = true;
    getStatusMock.mockResolvedValue(doneStatus());
    getTransactionMock.mockResolvedValue({ from: ATTACKER });
    const outcome = await trackStepStatus(input);
    expect(outcome).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
  });

  it('accepts when the chain confirms the intent\'s wallet sent it', async () => {
    rpcConfigured = true;
    getStatusMock.mockResolvedValue(doneStatus());
    getTransactionMock.mockResolvedValue({ from: WALLET.toUpperCase().replace('0X', '0x') });
    const outcome = await trackStepStatus(input);
    expect(outcome.kind).toBe('DONE');
  });

  it('keeps a still-pending transfer pending', async () => {
    getStatusMock.mockResolvedValue({ status: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION' });
    expect(await trackStepStatus(input)).toEqual({ kind: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION' });
  });
});

describe('trackStepStatus — on-chain fallback when LI.FI has no status', () => {
  const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const transfer = (token: string, from: string, to: string, value: bigint) => ({
    address: token,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  });
  const ROUTER = '0x4444444444444444444444444444444444444444';

  function mined(logs: ReturnType<typeof transfer>[], opts: { from?: string; status?: string } = {}) {
    getTransactionReceiptMock.mockResolvedValue({ status: opts.status ?? 'success', logs });
    getTransactionMock.mockResolvedValue({ from: opts.from ?? WALLET, value: BigInt(0) });
  }

  beforeEach(() => {
    rpcConfigured = true;
    getStatusMock.mockResolvedValue({ status: 'NOT_FOUND' });
  });

  it('verifies a mined same-chain swap from its receipt', async () => {
    mined([transfer(USDC, WALLET, ROUTER, BigInt(1000000000)), transfer(WETH, ROUTER, WALLET, BigInt('420000000000000000'))]);
    expect(await trackStepStatus(input)).toMatchObject({ kind: 'DONE', matchesExpectedAsset: true, receivedAmountRaw: '420000000000000000' });
  });

  it('also falls back when the LI.FI status call itself fails', async () => {
    getStatusMock.mockRejectedValue(new Error('status api down'));
    mined([transfer(USDC, WALLET, ROUTER, BigInt(1000000000)), transfer(WETH, ROUTER, WALLET, BigInt('420000000000000000'))]);
    expect(await trackStepStatus(input)).toMatchObject({ kind: 'DONE' });
  });

  it('stays pending while the transaction is not mined', async () => {
    getTransactionReceiptMock.mockRejectedValue(new Error('not found'));
    expect(await trackStepStatus(input)).toMatchObject({ kind: 'PENDING' });
  });

  it('fails a reverted transaction', async () => {
    mined([], { status: 'reverted' });
    expect(await trackStepStatus(input)).toMatchObject({ kind: 'FAILED', failureCode: 'TRANSACTION_REVERTED' });
  });

  const rejects: [string, () => void][] = [
    ['sent by someone else', () => mined([transfer(USDC, ATTACKER, ROUTER, BigInt(1000000000)), transfer(WETH, ROUTER, WALLET, BigInt('420000000000000000'))], { from: ATTACKER })],
    ['spent less than the step', () => mined([transfer(USDC, WALLET, ROUTER, BigInt(1)), transfer(WETH, ROUTER, WALLET, BigInt('420000000000000000'))])],
    ['delivered nothing to the wallet', () => mined([transfer(USDC, WALLET, ROUTER, BigInt(1000000000)), transfer(WETH, ROUTER, ATTACKER, BigInt('420000000000000000'))])],
    ['delivered below the minimum', () => mined([transfer(USDC, WALLET, ROUTER, BigInt(1000000000)), transfer(WETH, ROUTER, WALLET, BigInt(1))])],
  ];
  for (const [label, setup] of rejects) {
    it(`rejects a receipt that ${label}`, async () => {
      setup();
      expect(await trackStepStatus(input)).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
    });
  }
});
