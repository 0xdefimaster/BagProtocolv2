import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbi, parseAbiItem, toHex, type Hex } from 'viem';
import { METAMASK_EIP7702_STATELESS_DELEGATOR as MM, SELF_AUTHORIZED_PERMISSION_CONTEXT as EMPTY } from '@/packages/bag-sdk/src';

// -----------------------------------------------------------------------------
// BAG_WALLET_BATCH_BINDING (lib/config/execution.ts) through the real trackComposerTransaction, with the
// transaction shapes each flow produces from a MetaMask EIP-7702 smart account:
//   purchase  — usePurchaseExecution's sendTransaction, routed by the account through DelegationManager (single);
//   redemption — wallet_sendCalls batch (approve each sold token + the sale), executed by the account itself;
//   rebalance — DelegationManager batch (approve the sold token + the rebalance call).
// Adversarial variants add what an owner could put next to the built call to inflate execution accounting (T-1),
// or route the calldata to a contract that never runs it (F-01). 'off' must stay exactly the legacy behavior.
// -----------------------------------------------------------------------------

const client = {
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getCode: vi.fn(),
  getTransactionCount: vi.fn(),
  getBlock: vi.fn(),
};
vi.mock('@/lib/blockchain/rpc/clients', () => ({ hasRpcEndpoint: () => true, getChainPublicClient: () => client }));
const { trackComposerTransaction } = await import('../composer-status');

const WALLET = '0x1111111111111111111111111111111111111111' as Hex;
const COMPOSER = '0x4444444444444444444444444444444444444444' as Hex;
const PROXY = '0x8888888888888888888888888888888888888888' as Hex;
const USDG = '0xcccccccccccccccccccccccccccccccccccccccc' as Hex;
const OUT1 = '0x3131313131313131313131313131313131313131' as Hex;
const OUT2 = '0x3232323232323232323232323232323232323232' as Hex;
const SOLD1 = '0x6161616161616161616161616161616161616161' as Hex;
const SOLD2 = '0x6262626262626262626262626262626262626262' as Hex;
const OTHER = '0x9999999999999999999999999999999999999999' as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const CALLDATA = ('0x12345678' + 'cd'.repeat(120)) as Hex;

const ERC20 = parseAbi(['function approve(address spender, uint256 amount)', 'function transferFrom(address from, address to, uint256 amount)', 'function transfer(address to, uint256 amount)']);
const EXECUTE_MODE = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const REDEEM = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

type Exec = { target: Hex; value: bigint; callData: Hex };
const COMPILED: Exec = { target: COMPOSER, value: BigInt(0), callData: CALLDATA };
const approve = (token: Hex, amount: bigint, spender: Hex = COMPOSER): Exec =>
  ({ target: token, value: BigInt(0), callData: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }) });
const pull = (token: Hex, from: Hex, amount: bigint): Exec =>
  ({ target: token, value: BigInt(0), callData: encodeFunctionData({ abi: ERC20, functionName: 'transferFrom', args: [from, WALLET, amount] }) });
const push = (token: Hex, to: Hex, amount: bigint): Exec =>
  ({ target: token, value: BigInt(0), callData: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] }) });

const MODE_BATCH = pad('0x01', { dir: 'right', size: 32 });
const MODE_SINGLE = pad('0x00', { size: 32 });
const batch = (e: Exec[]) => encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }], [e.map((x) => [x.target, x.value, x.callData] as const)]);
const single = (e: Exec) => concat([e.target, pad(toHex(e.value), { size: 32 }), e.callData]);
const viaManager = (e: Exec[], mode: Hex = MODE_BATCH, contexts: Hex[] = [EMPTY]) =>
  encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [contexts, [mode], [mode === MODE_BATCH ? batch(e) : single(e[0])]] });
const selfExecute = (e: Exec[], mode: Hex = MODE_BATCH) => encodeFunctionData({ abi: EXECUTE_MODE, functionName: 'execute', args: [mode, mode === MODE_BATCH ? batch(e) : single(e[0])] });

const transferLog = (token: Hex, from: Hex, to: Hex, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
const designator = (delegate: Hex) => concat(['0xef0100', delegate]);

interface Mined { to: Hex; input: Hex; logs: ReturnType<typeof transferLog>[]; status?: 'success' | 'reverted'; type?: string; nonce?: number }
function mine(m: Mined, state: { code?: Hex; nonceBefore?: number; unreadable?: boolean } = {}) {
  client.getTransaction.mockResolvedValue({ hash: TX_HASH, from: WALLET, to: m.to, input: m.input, value: BigInt(0), nonce: m.nonce ?? 7, type: m.type ?? 'eip1559' });
  client.getTransactionReceipt.mockResolvedValue({ status: m.status ?? 'success', logs: m.logs, blockNumber: BigInt(100) });
  client.getCode.mockImplementation(async () => { if (state.unreadable) throw new Error('missing trie node'); return state.code ?? designator(MM.delegate); });
  client.getTransactionCount.mockImplementation(async () => { if (state.unreadable) throw new Error('missing trie node'); return state.nonceBefore ?? 7; });
  client.getBlock.mockResolvedValue({ transactions: [] });
}

const FLOWS = {
  purchase: {
    expectedApprovals: [] as { token: string; spender: string; amountRaw: string }[],
    // A 7702 account's sendTransaction becomes a single-mode execution through the DelegationManager.
    envelope: (e: Exec[]) => ({ to: MM.delegationManager, input: e.length === 1 ? viaManager(e, MODE_SINGLE) : viaManager(e) }),
    legit: [COMPILED],
    logs: [transferLog(USDG, WALLET, PROXY, BigInt(10_000_000)), transferLog(OUT1, PROXY, WALLET, BigInt(500)), transferLog(OUT2, PROXY, WALLET, BigInt(700))],
    received: { [OUT1]: '500', [OUT2]: '700' },
    sent: { [USDG]: '10000000' },
  },
  redeem: {
    expectedApprovals: [{ token: SOLD1, spender: COMPOSER, amountRaw: '1000' }, { token: SOLD2, spender: COMPOSER, amountRaw: '2000' }],
    // wallet_sendCalls on a 7702 account: the account calls itself with an ERC-7579 batch.
    envelope: (e: Exec[]) => ({ to: WALLET, input: selfExecute(e) }),
    legit: [approve(SOLD1, BigInt(1000)), approve(SOLD2, BigInt(2000)), COMPILED],
    logs: [transferLog(SOLD1, WALLET, PROXY, BigInt(1000)), transferLog(SOLD2, WALLET, PROXY, BigInt(2000)), transferLog(USDG, PROXY, WALLET, BigInt(9_900_000))],
    received: { [USDG]: '9900000' },
    sent: { [SOLD1]: '1000', [SOLD2]: '2000' },
  },
  rebalance: {
    expectedApprovals: [{ token: SOLD1, spender: COMPOSER, amountRaw: '1000' }],
    envelope: (e: Exec[]) => ({ to: MM.delegationManager, input: viaManager(e) }),
    legit: [approve(SOLD1, BigInt(1000)), COMPILED],
    logs: [transferLog(SOLD1, WALLET, PROXY, BigInt(1000)), transferLog(OUT1, PROXY, WALLET, BigInt(800))],
    received: { [OUT1]: '800' },
    sent: { [SOLD1]: '1000' },
  },
} as const;
type Flow = keyof typeof FLOWS;

const track = (flow: Flow) => trackComposerTransaction({
  txHash: TX_HASH, chain: 'robinhood', recipient: WALLET,
  expectedTransaction: { to: COMPOSER, data: CALLDATA, value: '0' },
  expectedApprovals: FLOWS[flow].expectedApprovals, flow,
});

/** Adversarial additions per flow: the extra execution, and the Transfer it would really emit. */
const ATTACKS: Record<Flow, [string, Exec, ReturnType<typeof transferLog>][]> = {
  purchase: [
    ['pull an output token in from another account (inflates the credited purchase)', pull(OUT1, OTHER, BigInt(5000)), transferLog(OUT1, OTHER, WALLET, BigInt(5000))],
  ],
  redeem: [
    ['pull extra USDG in (inflates the booked proceeds)', pull(USDG, OTHER, BigInt(50_000_000)), transferLog(USDG, OTHER, WALLET, BigInt(50_000_000))],
    ['push a sold token elsewhere (fakes "sold in full")', push(SOLD2, OTHER, BigInt(2000)), transferLog(SOLD2, WALLET, OTHER, BigInt(2000))],
  ],
  rebalance: [
    ['pull the bought token in (inflates the fills)', pull(OUT1, OTHER, BigInt(9000)), transferLog(OUT1, OTHER, WALLET, BigInt(9000))],
  ],
};

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const f of Object.values(client)) f.mockReset();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  infoSpy.mockRestore();
});
const shadowLines = () => infoSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[wallet-binding-shadow] '))
  .map((l: string) => JSON.parse(l.slice('[wallet-binding-shadow] '.length)));

for (const flow of Object.keys(FLOWS) as Flow[]) {
  const f = FLOWS[flow];
  describe(`${flow}: exact wallet-batch binding`, () => {
    it('off (default): the legitimate envelope is DONE exactly as before, with no wallet state read and no shadow log', async () => {
      mine({ ...f.envelope([...f.legit]), logs: [...f.logs] });
      expect(await track(flow)).toEqual({ kind: 'DONE', receivedAmountsByAddress: f.received, sentAmountsByAddress: f.sent });
      expect(client.getCode).not.toHaveBeenCalled();
      expect(client.getTransactionCount).not.toHaveBeenCalled();
      expect(client.getBlock).not.toHaveBeenCalled();
      expect(shadowLines()).toEqual([]);
    });

    it('enforce: the legitimate MetaMask envelope is DONE with exactly the built execution\'s amounts', async () => {
      vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
      mine({ ...f.envelope([...f.legit]), logs: [...f.logs] });
      expect(await track(flow)).toEqual({ kind: 'DONE', receivedAmountsByAddress: f.received, sentAmountsByAddress: f.sent });
      expect(client.getCode).toHaveBeenCalledWith({ address: WALLET, blockNumber: BigInt(99) });
    });

    for (const [label, extra, log] of ATTACKS[flow]) {
      it(`enforce refuses a sibling call that would ${label}`, async () => {
        vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
        mine({ ...f.envelope([...f.legit, extra]), logs: [...f.logs, log] });
        const outcome = await track(flow);
        expect(outcome).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
        expect(outcome.kind === 'FAILED' && outcome.message).toMatch(/UNEXPECTED_CALL/);
      });

      it(`off (default) keeps the legacy verdict for that envelope: the known gap T-1 is still open there`, async () => {
        mine({ ...f.envelope([...f.legit, extra]), logs: [...f.logs, log] });
        const outcome = await track(flow);
        expect(outcome.kind).toBe('DONE');
        expect(client.getCode).not.toHaveBeenCalled();
        expect(client.getTransactionCount).not.toHaveBeenCalled();
      });

      it('shadow returns the legacy verdict and records the disagreement', async () => {
        vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'shadow');
        mine({ ...f.envelope([...f.legit, extra]), logs: [...f.logs, log] });
        expect((await track(flow)).kind).toBe('DONE');
        expect(shadowLines()).toEqual([expect.objectContaining({ flow, legacy: 'ACCEPT', exact: 'REFUSED', code: 'UNEXPECTED_CALL', agree: false, txHash: TX_HASH })]);
        expect(JSON.stringify(shadowLines())).not.toContain(WALLET.slice(2));
      });
    }

    it('enforce refuses F-01: the calldata sent to a contract that is not the pinned DelegationManager', async () => {
      vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
      mine({ to: OTHER, input: viaManager([...f.legit]), logs: [...f.logs] });
      const outcome = await track(flow);
      expect(outcome).toMatchObject({ kind: 'FAILED', failureCode: 'VERIFICATION_FAILED' });
      expect(outcome.kind === 'FAILED' && outcome.message).toMatch(/UNSUPPORTED_ENVELOPE/);
    });

    it('off (default) still accepts that F-01 envelope (legacy), with no state reads', async () => {
      mine({ to: OTHER, input: viaManager([...f.legit]), logs: [...f.logs] });
      expect((await track(flow)).kind).toBe('DONE');
      expect(client.getCode).not.toHaveBeenCalled();
    });

    it('enforce refuses the built call repeated in one envelope', async () => {
      vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
      mine({ ...f.envelope([...f.legit, COMPILED]), logs: [...f.logs] });
      expect(await track(flow)).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/COMPILED_CALL_REPEATED/) });
    });

    it('shadow agrees on the legitimate envelope and logs it once', async () => {
      vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'shadow');
      mine({ ...f.envelope([...f.legit]), logs: [...f.logs] });
      expect((await track(flow)).kind).toBe('DONE');
      expect(shadowLines()).toEqual([expect.objectContaining({ flow, legacy: 'ACCEPT', exact: 'BOUND', agree: true })]);
    });
  });
}

describe('redemption approvals: only the built (token, spender) pairs, within the built amounts', () => {
  const f = FLOWS.redeem;
  const cases: [string, Exec[]][] = [
    ['an approval to another spender', [approve(SOLD1, BigInt(1000), OTHER), approve(SOLD2, BigInt(2000)), COMPILED]],
    ['an approval above the built amount', [approve(SOLD1, BigInt(1001)), approve(SOLD2, BigInt(2000)), COMPILED]],
    ['an approval of a token the sale does not sell', [approve(SOLD1, BigInt(1000)), approve(USDG, BigInt(1)), COMPILED]],
  ];
  for (const [label, executions] of cases) {
    it(`enforce refuses ${label}`, async () => {
      vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
      mine({ ...f.envelope(executions), logs: [...f.logs] });
      expect(await track('redeem')).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/APPROVAL_NOT_ALLOWED/) });
    });
  }

  it('enforce accepts fewer approvals than built (allowance already in place)', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine({ ...f.envelope([approve(SOLD2, BigInt(2000)), COMPILED]), logs: [...f.logs] });
    expect((await track('redeem')).kind).toBe('DONE');
  });
});

describe('rebalance: execution semantics the binding refuses', () => {
  const f = FLOWS.rebalance;
  it('enforce refuses try-mode (a failed call would not revert the transaction)', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    const input = encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [[EMPTY], [pad('0x0101', { dir: 'right', size: 32 })], [batch([...f.legit])]] });
    mine({ to: MM.delegationManager, input, logs: [...f.logs] });
    expect(await track('rebalance')).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/UNSUPPORTED_EXECUTION_MODE/) });
  });

  it('enforce refuses a redeemed delegation (another account would execute the calls)', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    const delegation = encodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }] }, { type: 'uint256' }, { type: 'bytes' }] }],
      [[[WALLET, OTHER, `0x${'f'.repeat(64)}`, [], BigInt(1), '0x12']]],
    );
    mine({ to: MM.delegationManager, input: viaManager([...f.legit], MODE_BATCH, [delegation]), logs: [...f.logs] });
    expect(await track('rebalance')).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/DELEGATED_EXECUTION/) });
  });
});

describe('wallet state behind a smart-account envelope (enforce)', () => {
  const f = FLOWS.purchase;
  it('a delegation to an unpinned implementation is refused', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine({ ...f.envelope([...f.legit]), logs: [...f.logs] }, { code: designator(OTHER) });
    expect(await track('purchase')).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/DELEGATE_NOT_TRUSTED/) });
  });

  it('an EIP-7702 transaction (its authorization could swap the code before the calls) is refused', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine({ ...f.envelope([...f.legit]), logs: [...f.logs], type: 'eip7702' });
    expect(await track('purchase')).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/DELEGATE_CHANGED_IN_TRANSACTION/) });
  });

  it('unreadable historical state keeps the transaction pending, never passes', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine({ ...f.envelope([...f.legit]), logs: [...f.logs] }, { unreadable: true });
    expect(await track('purchase')).toEqual({ kind: 'PENDING' });
  });

  it('shadow with unreadable state: legacy verdict stands, the log says INDETERMINATE, nothing throws', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'shadow');
    mine({ ...f.envelope([...f.legit]), logs: [...f.logs] }, { unreadable: true });
    expect((await track('purchase')).kind).toBe('DONE');
    expect(shadowLines()).toEqual([expect.objectContaining({ exact: 'INDETERMINATE', code: 'STATE_UNAVAILABLE', agree: false })]);
  });

  it('a reverted but correctly bound transaction is reported as reverted', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine({ ...f.envelope([...f.legit]), logs: [], status: 'reverted' });
    expect(await track('purchase')).toMatchObject({ kind: 'FAILED', failureCode: 'TRANSACTION_REVERTED' });
  });
});

describe('modes and direct calls', () => {
  it('a direct call to the built target binds in every mode without reading wallet state, and agreeing direct calls are not logged', async () => {
    for (const mode of ['off', 'shadow', 'enforce']) {
      vi.stubEnv('BAG_WALLET_BATCH_BINDING', mode);
      client.getCode.mockClear();
      mine({ to: COMPOSER, input: CALLDATA, logs: [...FLOWS.purchase.logs] });
      expect((await track('purchase')).kind).toBe('DONE');
      expect(client.getCode).not.toHaveBeenCalled();
    }
    expect(shadowLines()).toEqual([]);
  });

  it('an unknown flag value is off', async () => {
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'ENFORCE-ish');
    mine({ to: OTHER, input: viaManager([COMPILED]), logs: [...FLOWS.purchase.logs] });
    expect((await track('purchase')).kind).toBe('DONE');
    expect(client.getCode).not.toHaveBeenCalled();
  });

  it('enforce fails closed on a stored expectation it cannot evaluate; shadow logs it and keeps the legacy verdict', async () => {
    const bad = () => trackComposerTransaction({
      txHash: TX_HASH, chain: 'robinhood', recipient: WALLET, expectedTransaction: { to: COMPOSER, data: CALLDATA, value: '0' },
      expectedApprovals: [{ token: SOLD1, spender: COMPOSER, amountRaw: 'not-a-number' }], flow: 'redeem',
    });
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'enforce');
    mine({ ...FLOWS.redeem.envelope([...FLOWS.redeem.legit]), logs: [...FLOWS.redeem.logs] });
    expect(await bad()).toMatchObject({ kind: 'FAILED', message: expect.stringMatching(/EXPECTATION_INVALID/) });
    vi.stubEnv('BAG_WALLET_BATCH_BINDING', 'shadow');
    expect((await bad()).kind).toBe('DONE');
    expect(shadowLines().at(-1)).toMatchObject({ exact: 'ERROR', code: 'EXPECTATION_INVALID', agree: false });
  });
});
