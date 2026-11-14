import { describe, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex } from 'viem';
import {
  bindWalletEnvelope,
  checkWalletExecutionState,
  compileBag,
  DELIVERY_PROOF_SIGNATURE,
  METAMASK_EIP7702_STATELESS_DELEGATOR as MM,
  parseBag,
  SELF_AUTHORIZED_PERMISSION_CONTEXT as EMPTY,
  verifyPurchaseReceipt,
  verifyWalletExecution,
  type Hex,
  type PurchaseReceiptClient,
  type PurchaseReceiptLog,
  type PurchaseReceiptTransaction,
  type PurchaseTransactionReceipt,
  type WalletCallExpectation,
  type WalletEnvelopeBinding,
  type WalletStateReader,
} from '../src';
import { externalBag } from './helpers';

// -----------------------------------------------------------------------------
// Exact smart-account binding (wallet-envelope.ts): the legitimate MetaMask EIP-7702 envelopes are accepted,
// everything that could put an unrelated transfer into execution accounting (T-1) or skip the compiled call
// (F-01) is refused, and verifyPurchaseReceipt's 'EXACT' mode applies it in every evidence mode.
// -----------------------------------------------------------------------------

const hex = (digit: string, length: number) => ('0x' + digit.repeat(length)) as Hex;
const WALLET = hex('5', 40);
const ROUTER = hex('7', 40);
const INPUT = hex('c', 40);
const OTHER = hex('9', 40);
const PROXY = hex('8', 40);
const HASH = hex('1', 64);
const BLOCK = hex('2', 64);
const CHAIN = 4663;
const CALLDATA = ('0x12345678' + 'ab'.repeat(100)) as Hex;
const MAX = BigInt(10_000_000);

const ERC20 = parseAbi(['function approve(address spender, uint256 amount)', 'function transferFrom(address from, address to, uint256 amount)']);
const EXECUTE_MODE = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const EXECUTE_SINGLE = parseAbi(['function execute((address target, uint256 value, bytes callData) execution)']);
const REDEEM = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
const EXECUTE_BATCH = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

type Exec = { target: Hex; value: bigint; callData: Hex };
const approve = (spender: Hex, amount: bigint, token: Hex = INPUT, value = BigInt(0)): Exec =>
  ({ target: token, value, callData: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }) });
const COMPILED: Exec = { target: ROUTER, value: BigInt(0), callData: CALLDATA };
const APPROVE = approve(ROUTER, MAX);
/** T-1: the wallet pulls an output token from another account it controls, inside the same transaction. */
const SIBLING: Exec = { target: hex('d', 40), value: BigInt(0), callData: encodeFunctionData({ abi: ERC20, functionName: 'transferFrom', args: [OTHER, WALLET, BigInt(1000)] }) };

const MODE_BATCH = pad('0x01', { dir: 'right', size: 32 });
const MODE_SINGLE = pad('0x00', { size: 32 });
const batch = (e: Exec[]) => encodeAbiParameters(
  [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
  [e.map((x) => [x.target, x.value, x.callData] as const)],
);
const single = (e: Exec) => concat([e.target, pad(toHex(e.value), { size: 32 }), e.callData]);
const executeMode = (mode: Hex, data: Hex) => encodeFunctionData({ abi: EXECUTE_MODE, functionName: 'execute', args: [mode, data] });
const executeSingle = (e: Exec) => encodeFunctionData({ abi: EXECUTE_SINGLE, functionName: 'execute', args: [e] });
const redeem = (contexts: Hex[], modes: Hex[], datas: Hex[]) => encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [contexts, modes, datas] });
const viaManager = (e: Exec[], mode = MODE_BATCH, context: Hex = EMPTY) => redeem([context], [mode], [mode === MODE_BATCH ? batch(e) : single(e[0])]);
const tx = (to: Hex, input: Hex, value = BigInt(0), from: Hex = WALLET) => ({ from, to, input, value });

const expectation: WalletCallExpectation = {
  chainId: CHAIN, wallet: WALLET, call: { to: ROUTER, data: CALLDATA, value: BigInt(0) },
  approvals: [{ token: INPUT, spender: ROUTER, maxAmountRaw: MAX }],
};

/** One delegation (another account would execute): a non-empty permission context. */
const DELEGATION_CONTEXT = encodeAbiParameters(
  [{ type: 'tuple[]', components: [
    { type: 'address' }, { type: 'address' }, { type: 'bytes32' },
    { type: 'tuple[]', components: [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }] },
    { type: 'uint256' }, { type: 'bytes' },
  ] }],
  [[[WALLET, OTHER, hex('f', 64), [], BigInt(1), '0x1234']]],
);

describe('bindWalletEnvelope: legitimate MetaMask EIP-7702 envelopes', () => {
  const accepted: [string, ReturnType<typeof tx>, string, number][] = [
    ['the compiled call itself (DIRECT)', tx(ROUTER, CALLDATA), 'DIRECT', 1],
    ['DelegationManager.redeemDelegations, batch: approve + compiled call', tx(MM.delegationManager, viaManager([APPROVE, COMPILED])), 'DELEGATION_MANAGER', 2],
    ['DelegationManager.redeemDelegations, single mode (what a 7702 sendTransaction becomes)', tx(MM.delegationManager, viaManager([COMPILED], MODE_SINGLE)), 'DELEGATION_MANAGER', 1],
    ['DelegationManager.redeemDelegations, two entries', tx(MM.delegationManager, redeem([EMPTY, EMPTY], [MODE_SINGLE, MODE_SINGLE], [single(APPROVE), single(COMPILED)])), 'DELEGATION_MANAGER', 2],
    ['self-call execute(bytes32,bytes), batch (EIP-5792 wallet_sendCalls)', tx(WALLET, executeMode(MODE_BATCH, batch([APPROVE, COMPILED]))), 'SELF_EXECUTE_MODE', 2],
    ['self-call execute(bytes32,bytes), single', tx(WALLET, executeMode(MODE_SINGLE, single(COMPILED))), 'SELF_EXECUTE_MODE', 1],
    ['self-call execute((address,uint256,bytes))', tx(WALLET, executeSingle(COMPILED)), 'SELF_EXECUTE_SINGLE', 1],
    ['self-call redeemDelegations (the account forwards to its DelegationManager)', tx(WALLET, viaManager([APPROVE, COMPILED])), 'SELF_REDEEM_DELEGATIONS', 2],
    ['an approval below the built amount, and a zero reset', tx(MM.delegationManager, viaManager([approve(ROUTER, BigInt(0)), approve(ROUTER, BigInt(5)), COMPILED])), 'DELEGATION_MANAGER', 3],
  ];
  for (const [label, transaction, envelope, count] of accepted) {
    it(`accepts ${label}`, () => {
      const r = bindWalletEnvelope(transaction, expectation);
      expect(r).toMatchObject({ ok: true, envelope });
      expect(r.ok && r.executions).toHaveLength(count);
      expect(r.ok && r.candidates).toEqual([MM]);
    });
  }
});

describe('bindWalletEnvelope: adversarial envelopes are refused with a reason', () => {
  const dirtyAddress = (() => {
    const data = batch([COMPILED]);
    const word = '000000000000000000000000' + ROUTER.slice(2);
    return data.replace(word, 'ff' + word.slice(2)) as Hex;
  })();
  const refused: [string, ReturnType<typeof tx>, string, WalletCallExpectation?][] = [
    ['T-1: a sibling transferFrom into the wallet', tx(MM.delegationManager, viaManager([APPROVE, COMPILED, SIBLING])), 'UNEXPECTED_CALL'],
    ['T-1: a sibling call before the compiled call, self-call batch', tx(WALLET, executeMode(MODE_BATCH, batch([SIBLING, COMPILED]))), 'UNEXPECTED_CALL'],
    ['a sibling native transfer', tx(MM.delegationManager, viaManager([COMPILED, { target: OTHER, value: BigInt(1), callData: '0x' }])), 'UNEXPECTED_CALL'],
    ['the compiled call twice', tx(MM.delegationManager, viaManager([COMPILED, COMPILED])), 'COMPILED_CALL_REPEATED'],
    ['approvals without the compiled call', tx(MM.delegationManager, viaManager([APPROVE])), 'COMPILED_CALL_MISSING'],
    ['the compiled target with another value', tx(MM.delegationManager, viaManager([{ ...COMPILED, value: BigInt(1) }])), 'UNEXPECTED_CALL'],
    ['try mode (a failed call would not revert)', tx(MM.delegationManager, redeem([EMPTY], [pad('0x0101', { dir: 'right', size: 32 })], [batch([COMPILED])])), 'UNSUPPORTED_EXECUTION_MODE'],
    ['delegatecall call type', tx(WALLET, executeMode(pad('0xff', { dir: 'right', size: 32 }), batch([COMPILED]))), 'UNSUPPORTED_EXECUTION_MODE'],
    ['a non-zero mode selector', tx(WALLET, executeMode(pad('0x01000000000001', { dir: 'right', size: 32 }), batch([COMPILED]))), 'UNSUPPORTED_EXECUTION_MODE'],
    ['a redeemed delegation (another account would execute)', tx(MM.delegationManager, viaManager([COMPILED], MODE_BATCH, DELEGATION_CONTEXT)), 'DELEGATED_EXECUTION'],
    ['an empty-bytes permission context (reverts on chain)', tx(MM.delegationManager, viaManager([COMPILED], MODE_BATCH, '0x')), 'NON_CANONICAL_ENVELOPE'],
    ['F-01: redeemDelegations sent to an unpinned contract', tx(OTHER, viaManager([COMPILED])), 'UNSUPPORTED_ENVELOPE'],
    ['another sender', tx(MM.delegationManager, viaManager([COMPILED]), BigInt(0), OTHER), 'NOT_FROM_WALLET'],
    ['value sent to the non-payable DelegationManager', tx(MM.delegationManager, viaManager([COMPILED]), BigInt(1)), 'ENVELOPE_VALUE_NOT_ZERO'],
    ['an approval to another spender', tx(MM.delegationManager, viaManager([approve(OTHER, BigInt(1)), COMPILED])), 'APPROVAL_NOT_ALLOWED'],
    ['an approval above the built amount', tx(MM.delegationManager, viaManager([approve(ROUTER, MAX + BigInt(1)), COMPILED])), 'APPROVAL_NOT_ALLOWED'],
    ['an approval of another token', tx(MM.delegationManager, viaManager([approve(ROUTER, BigInt(1), OTHER), COMPILED])), 'APPROVAL_NOT_ALLOWED'],
    ['an approval carrying value', tx(MM.delegationManager, viaManager([approve(ROUTER, BigInt(1), INPUT, BigInt(1)), COMPILED])), 'APPROVAL_NOT_ALLOWED'],
    ['a non-canonical batch (dirty address word)', tx(MM.delegationManager, redeem([EMPTY], [MODE_BATCH], [dirtyAddress])), 'NON_CANONICAL_ENVELOPE'],
    ['trailing bytes after the batch', tx(MM.delegationManager, redeem([EMPTY], [MODE_BATCH], [(batch([COMPILED]) + '00') as Hex])), 'NON_CANONICAL_ENVELOPE'],
    ['executeBatch(Call[]) (not an entry point of the pinned account)', tx(WALLET, encodeFunctionData({ abi: EXECUTE_BATCH, functionName: 'executeBatch', args: [[{ target: ROUTER, value: BigInt(0), data: CALLDATA }]] })), 'UNSUPPORTED_ENVELOPE'],
    ['mismatched redeemDelegations array lengths', tx(MM.delegationManager, redeem([EMPTY, EMPTY], [MODE_BATCH], [batch([COMPILED])])), 'NON_CANONICAL_ENVELOPE'],
    ['a direct call with other calldata', tx(ROUTER, '0x12345678'), 'TRANSACTION_MISMATCH'],
    ['a smart-account envelope on a chain with no pinned account', tx(MM.delegationManager, viaManager([COMPILED])), 'UNSUPPORTED_ENVELOPE', { ...expectation, chainId: 10 }],
  ];
  for (const [label, transaction, code, exp] of refused) {
    it(`refuses ${label}: ${code}`, () => {
      expect(bindWalletEnvelope(transaction, exp ?? expectation)).toMatchObject({ ok: false, code });
    });
  }

  // Function-level canonical encoding (decode, re-encode, compare): a parser that tolerated these could read a
  // different call than the chain executes, or accept bytes the account never sees.
  it('refuses trailing bytes after the redeemDelegations calldata: NON_CANONICAL_ENVELOPE', () => {
    const input = (viaManager([COMPILED]) + 'ab') as Hex;
    expect(bindWalletEnvelope(tx(MM.delegationManager, input), expectation)).toMatchObject({ ok: false, code: 'NON_CANONICAL_ENVELOPE' });
  });

  it('refuses trailing bytes after execute(bytes32,bytes): NON_CANONICAL_ENVELOPE', () => {
    const input = (executeMode(MODE_BATCH, batch([COMPILED])) + '00') as Hex;
    expect(bindWalletEnvelope(tx(WALLET, input), expectation)).toMatchObject({ ok: false, code: 'NON_CANONICAL_ENVELOPE' });
  });

  it('refuses an approve whose spender word has dirty upper bytes: APPROVAL_NOT_ALLOWED', () => {
    const clean = APPROVE.callData;
    const dirty = (clean.slice(0, 10) + 'ff' + clean.slice(12)) as Hex; // first byte of the spender word
    expect(bindWalletEnvelope(tx(MM.delegationManager, viaManager([{ ...APPROVE, callData: dirty }, COMPILED])), expectation))
      .toMatchObject({ ok: false, code: 'APPROVAL_NOT_ALLOWED' });
  });

  it('a malformed expectation is a programming error, not a verdict', () => {
    expect(() => bindWalletEnvelope(tx(ROUTER, CALLDATA), { ...expectation, wallet: 'nope' })).toThrow(/expectation/);
  });
});

const designator = (delegate: Hex) => concat(['0xef0100', delegate]);

function reader(over: { code?: Hex; nonceBefore?: number; block?: unknown; throws?: boolean; noBlock?: boolean } = {}) {
  const r = {
    getCode: vi.fn(async () => { if (over.throws) throw new Error('missing trie node'); return over.code ?? designator(MM.delegate); }),
    getTransactionCount: vi.fn(async () => over.nonceBefore ?? 7),
    getBlock: vi.fn(async () => (over.block === undefined ? { transactions: [] } : over.block) as { transactions?: readonly unknown[] }),
  };
  if (over.noBlock) delete (r as Partial<typeof r>).getBlock;
  return r as WalletStateReader & typeof r;
}

describe('checkWalletExecutionState: the code that ran must be the pinned delegate', () => {
  const bound = bindWalletEnvelope(tx(MM.delegationManager, viaManager([APPROVE, COMPILED])), expectation) as Extract<WalletEnvelopeBinding, { ok: true }>;
  const mined = (over: Record<string, unknown> = {}) => ({ ...tx(MM.delegationManager, viaManager([APPROVE, COMPILED])), nonce: 7, type: 'eip1559', blockNumber: BigInt(100), ...over });

  it('accepts the pinned designator before the block with an unchanged nonce, reading the previous block', async () => {
    const r = reader();
    expect(await checkWalletExecutionState(r, mined(), bound)).toEqual({ ok: true, smartAccount: MM });
    expect(r.getCode).toHaveBeenCalledWith({ address: WALLET, blockNumber: BigInt(99) });
  });

  const cases: [string, Parameters<typeof reader>[0], Record<string, unknown>, string][] = [
    ['a plain EOA (no delegation)', { code: '0x' }, {}, 'DELEGATE_NOT_TRUSTED'],
    ['a delegation to an unpinned implementation', { code: designator(hex('4', 40)) }, {}, 'DELEGATE_NOT_TRUSTED'],
    ['an EIP-7702 transaction (its authorization runs before the calls)', {}, { type: 'eip7702' }, 'DELEGATE_CHANGED_IN_TRANSACTION'],
    ['a non-empty authorization list', {}, { authorizationList: [{}] }, 'DELEGATE_CHANGED_IN_TRANSACTION'],
    ['an unknown transaction type', {}, { type: undefined }, 'STATE_UNAVAILABLE'],
    ['an authorization earlier in the block (nonce moved by more than the wallet\'s own transactions)', { nonceBefore: 5, block: { transactions: [{ from: WALLET, nonce: 5 }] } }, {}, 'WALLET_STATE_CHANGED_IN_BLOCK'],
    ['block transactions available only as hashes', { nonceBefore: 6, block: { transactions: [HASH] } }, {}, 'STATE_UNAVAILABLE'],
    ['no block reader when the wallet sent earlier in the block', { nonceBefore: 6, noBlock: true }, {}, 'STATE_UNAVAILABLE'],
    ['historical state not served', { throws: true }, {}, 'STATE_UNAVAILABLE'],
    ['a reader nonce ahead of the transaction', { nonceBefore: 8 }, {}, 'STATE_UNAVAILABLE'],
  ];
  for (const [label, r, over, code] of cases) {
    it(`refuses ${label}: ${code}`, async () => {
      expect(await checkWalletExecutionState(reader(r), mined(over), bound)).toMatchObject({ ok: false, code });
    });
  }

  it("accepts the wallet's own earlier transaction in the same block when it accounts for the nonce", async () => {
    expect(await checkWalletExecutionState(reader({ nonceBefore: 6, block: { transactions: [{ from: OTHER, nonce: 3 }, { from: WALLET, nonce: 6 }] } }), mined(), bound))
      .toEqual({ ok: true, smartAccount: MM });
  });

  it('a DelegationManager envelope needs a delegate bound to that DelegationManager', async () => {
    const foreign = { name: 'foreign', delegate: hex('4', 40), delegationManager: hex('3', 40) };
    const b = bindWalletEnvelope(tx(MM.delegationManager, viaManager([COMPILED])), expectation, [MM, foreign]) as Extract<WalletEnvelopeBinding, { ok: true }>;
    expect(b.candidates).toEqual([MM]);
    expect(await checkWalletExecutionState(reader({ code: designator(foreign.delegate) }), mined({ input: viaManager([COMPILED]) }), b)).toMatchObject({ ok: false, code: 'DELEGATE_NOT_TRUSTED' });
  });

  // A DIRECT call runs no wallet code unless it sends ETH back to the wallet (a native sale, a refund); then the
  // wallet's code runs inside the transaction. So DIRECT also needs a plain EOA or a pinned delegate, unchanged.
  describe('DIRECT: the wallet must be a plain EOA or a pinned delegate', () => {
    const b = bindWalletEnvelope(tx(ROUTER, CALLDATA), expectation) as Extract<WalletEnvelopeBinding, { ok: true }>;
    const direct = (over: Record<string, unknown> = {}) => ({ ...tx(ROUTER, CALLDATA), nonce: 7, type: 'eip1559', blockNumber: BigInt(100), ...over });
    it('accepts a plain EOA (no wallet code can run), reading the previous block', async () => {
      const r = reader({ code: '0x' });
      expect(await checkWalletExecutionState(r, direct(), b)).toEqual({ ok: true, smartAccount: null });
      expect(r.getCode).toHaveBeenCalledWith({ address: WALLET, blockNumber: BigInt(99) });
    });
    it('accepts a pinned MetaMask delegate', async () => {
      expect(await checkWalletExecutionState(reader(), direct(), b)).toEqual({ ok: true, smartAccount: MM });
    });
    it('refuses an unpinned delegate (its receive() could add transfers when ETH comes back)', async () => {
      expect(await checkWalletExecutionState(reader({ code: designator(hex('4', 40)) }), direct(), b)).toMatchObject({ ok: false, code: 'DELEGATE_NOT_TRUSTED' });
    });
    it('refuses a wallet that is a contract', async () => {
      expect(await checkWalletExecutionState(reader({ code: '0x6080604052' }), direct(), b)).toMatchObject({ ok: false, code: 'DELEGATE_NOT_TRUSTED' });
    });
    it('refuses an EIP-7702 transaction and an unexplained nonce movement, as for envelopes', async () => {
      expect(await checkWalletExecutionState(reader({ code: '0x' }), direct({ type: 'eip7702' }), b)).toMatchObject({ ok: false, code: 'DELEGATE_CHANGED_IN_TRANSACTION' });
      expect(await checkWalletExecutionState(reader({ code: '0x', nonceBefore: 6, block: { transactions: [] } }), direct(), b)).toMatchObject({ ok: false, code: 'WALLET_STATE_CHANGED_IN_BLOCK' });
    });
  });

  it('verifyWalletExecution: REFUSED is final, INDETERMINATE only for unreadable state', async () => {
    expect(await verifyWalletExecution(reader(), mined({ input: viaManager([APPROVE, COMPILED, SIBLING]) }), expectation)).toMatchObject({ status: 'REFUSED', code: 'UNEXPECTED_CALL' });
    expect(await verifyWalletExecution(reader({ throws: true }), mined(), expectation)).toMatchObject({ status: 'INDETERMINATE', code: 'STATE_UNAVAILABLE' });
    expect(await verifyWalletExecution(reader(), mined(), expectation)).toMatchObject({ status: 'BOUND', envelope: 'DELEGATION_MANAGER', smartAccount: MM });
  });
});

// -----------------------------------------------------------------------------
// verifyPurchaseReceipt with smartAccountBinding 'EXACT', in every evidence mode.
// -----------------------------------------------------------------------------

const TRANSFER = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
const DISCRIMINATOR = keccak256(new TextEncoder().encode(DELIVERY_PROOF_SIGNATURE));
const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
const addressWord = (a: Hex) => ('0x' + w(a)) as Hex;

async function purchase(deliveryProof = false) {
  const parsed = parseBag(externalBag());
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const compiled = await compileBag(parsed.bag, { inputToken: INPUT, amountRaw: BigInt(10_000_000), inputTokenDecimals: 6, signer: WALLET }, {
    provider: {
      name: 'fixture',
      async compile(request) {
        return {
          transaction: { to: ROUTER, data: CALLDATA, value: '0', chainId: request.chainId },
          executor: PROXY, approvals: [{ token: INPUT, spender: ROUTER, amountRaw: String(MAX) }], priceImpactBps: 1, gasLimit: null, fees: [],
          legs: request.legs.map((leg) => ({ token: leg.token, expectedOutRaw: '1000', minOutRaw: '990' })),
          ...(deliveryProof ? { deliveryProof: { signature: DELIVERY_PROOF_SIGNATURE, recipient: WALLET, tokens: request.legs.map((l) => l.token) } } : {}),
        };
      },
    },
    trust: { chainId: CHAIN, allowedTransactionTargets: [ROUTER], allowedApprovalSpenders: [ROUTER] },
  });
  const tokens = compiled.quote.plan.legs.map((l) => l.token as Hex);
  return { compiled, tokens };
}

async function scenario(mode: 'TRANSFER_LOGS' | 'BALANCE_DELTA' | 'DELIVERY_LOG', executions: Exec[] = [APPROVE, COMPILED], over: { code?: Hex; to?: Hex; input?: Hex; noState?: boolean; trace?: unknown } = {}) {
  const { compiled, tokens } = await purchase(mode === 'DELIVERY_LOG');
  const input = over.input ?? viaManager(executions);
  const to = over.to ?? MM.delegationManager;
  const transaction: PurchaseReceiptTransaction = {
    hash: HASH, from: WALLET, to, input, value: BigInt(0), chainId: CHAIN, blockHash: BLOCK, blockNumber: BigInt(10), nonce: 7, type: 'eip1559',
  };
  let index = 0;
  const log = (address: Hex, topics: Hex[], data: string): PurchaseReceiptLog =>
    ({ address, topics, data: ('0x' + data) as Hex, logIndex: index++, transactionHash: HASH, blockHash: BLOCK, blockNumber: BigInt(10), removed: false });
  const logs: PurchaseReceiptLog[] = tokens.map((t) => log(t, [TRANSFER, addressWord(PROXY), addressWord(WALLET)], w(BigInt(100))));
  // What the sibling call moved, if any: 1000 of the first planned token pulled into the wallet.
  const sibling = executions.includes(SIBLING);
  if (sibling) logs.push(log(tokens[0], [TRANSFER, addressWord(OTHER), addressWord(WALLET)], w(BigInt(1000))));
  if (mode === 'DELIVERY_LOG') tokens.forEach((t) => logs.push(log(PROXY, [hex('e', 64)], [w(DISCRIMINATOR), w(t), w(WALLET), w(BigInt(5)), w(BigInt(105))].join(''))));
  const receipt: PurchaseTransactionReceipt = { transactionHash: HASH, from: WALLET, to, blockHash: BLOCK, blockNumber: BigInt(10), status: 'success', logs };
  const client: PurchaseReceiptClient = {
    getChainId: vi.fn(async () => CHAIN),
    getTransaction: vi.fn(async () => transaction),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async () => ({ hash: BLOCK })),
    getBlockNumber: vi.fn(async () => BigInt(12)),
    getPurchaseBalanceChanges: vi.fn(async (ctx) => ({
      ...ctx, scope: 'TRANSACTION' as const,
      balances: [
        ...tokens.map((t, i) => ({ token: t, beforeRaw: BigInt(25), afterRaw: BigInt(125) + (sibling && i === 0 ? BigInt(1000) : BigInt(0)) })),
        { token: INPUT, beforeRaw: compiled.quote.plan.amountRaw, afterRaw: BigInt(0) },
      ],
    })),
    ...(over.noState ? {} : {
      getCode: vi.fn(async () => over.code ?? designator(MM.delegate)),
      getTransactionCount: vi.fn(async () => 7),
    }),
    ...(over.trace ? { tracePurchaseCall: vi.fn(async () => ({ transactionHash: HASH, blockHash: BLOCK, call: over.trace })) } : {}),
  };
  const run = (binding?: 'OFF' | 'EXACT') => verifyPurchaseReceipt(compiled, {
    client, transactionHash: HASH, verification: mode, smartAccountBinding: binding,
    minimumReceived: tokens.map((token) => ({ token, amountRaw: BigInt(80) })),
  });
  return { compiled, tokens, client, run };
}

const MODES = ['TRANSFER_LOGS', 'BALANCE_DELTA', 'DELIVERY_LOG'] as const;

describe("verifyPurchaseReceipt smartAccountBinding 'EXACT'", () => {
  for (const mode of MODES) {
    it(`${mode}: binds a MetaMask DelegationManager batch exactly (D-1 resolved) and verifies`, async () => {
      const s = await scenario(mode);
      const r = await s.run('EXACT');
      expect(r.status).toBe('VERIFIED');
      expect(r.transactionBinding).toBe('WALLET_BATCH_EXACT');
      expect(r.walletEnvelope).toBe('DELEGATION_MANAGER');
      expect(r.accounting).toBe('NOT_BAG_ACCOUNTED');
    });

    it(`${mode}: default 'OFF' is unchanged: the same batch without a trace stays INDETERMINATE`, async () => {
      const r = await (await scenario(mode)).run();
      expect(r.status).toBe('INDETERMINATE');
      expect(r.issues[0].code).toBe('UNSUPPORTED_TRANSACTION_ENVELOPE');
    });

    it(`${mode}: T-1 refused: a sibling transfer in the batch fails the whole verification`, async () => {
      const r = await (await scenario(mode, [APPROVE, COMPILED, SIBLING])).run('EXACT');
      expect(r.status).toBe('FAILED');
      expect(r.issues[0].code).toBe('WALLET_ENVELOPE_MISMATCH');
      expect(r.walletBindingIssue).toBe('UNEXPECTED_CALL');
      expect(r.outputs).toEqual([]);
    });

    it(`${mode}: an unpinned delegate is refused, unreadable wallet state is never a pass`, async () => {
      const untrusted = await (await scenario(mode, [APPROVE, COMPILED], { code: designator(hex('4', 40)) })).run('EXACT');
      expect(untrusted).toMatchObject({ status: 'FAILED', walletBindingIssue: 'DELEGATE_NOT_TRUSTED' });
      const blind = await (await scenario(mode, [APPROVE, COMPILED], { noState: true })).run('EXACT');
      expect(blind.status).toBe('INDETERMINATE');
      expect(blind.issues[0].code).toBe('WALLET_STATE_UNAVAILABLE');
    });
  }

  for (const mode of MODES) {
    it(`${mode}: a DIRECT call under 'EXACT' needs a plain EOA or a pinned delegate; unreadable state is never a pass`, async () => {
      const eoa = await (await scenario(mode, [COMPILED], { to: ROUTER, input: CALLDATA, code: '0x' })).run('EXACT');
      expect(eoa).toMatchObject({ status: 'VERIFIED', transactionBinding: 'DIRECT', walletEnvelope: 'DIRECT' });
      const pinned = await (await scenario(mode, [COMPILED], { to: ROUTER, input: CALLDATA })).run('EXACT');
      expect(pinned.status).toBe('VERIFIED');
      const unpinned = await (await scenario(mode, [COMPILED], { to: ROUTER, input: CALLDATA, code: designator(hex('4', 40)) })).run('EXACT');
      expect(unpinned).toMatchObject({ status: 'FAILED', walletBindingIssue: 'DELEGATE_NOT_TRUSTED' });
      const blind = await (await scenario(mode, [COMPILED], { to: ROUTER, input: CALLDATA, noState: true })).run('EXACT');
      expect(blind).toMatchObject({ status: 'INDETERMINATE', walletBindingIssue: 'STATE_UNAVAILABLE' });
      // 'OFF' keeps the direct path exactly as before: no state needed.
      expect((await (await scenario(mode, [COMPILED], { to: ROUTER, input: CALLDATA, noState: true })).run('OFF')).status).toBe('VERIFIED');
    });
  }

  it('F-01: an envelope sent to an unpinned contract is never verified', async () => {
    const r = await (await scenario('TRANSFER_LOGS', [COMPILED], { to: OTHER })).run('EXACT');
    expect(r.status).toBe('INDETERMINATE');
    expect(r.issues[0].code).toBe('UNSUPPORTED_TRANSACTION_ENVELOPE');
  });

  const frame = (from: Hex, to: Hex, input: Hex, calls: unknown[] = []) => ({ type: 'CALL', from, to, input, value: '0x0', calls });
  const executeBatchInput = encodeFunctionData({ abi: EXECUTE_BATCH, functionName: 'executeBatch', args: [[{ target: ROUTER, value: BigInt(0), data: CALLDATA }]] });

  it('an envelope the binder does not know still needs a trace, whose wallet calls must be exact', async () => {
    const clean = frame(WALLET, WALLET, executeBatchInput, [frame(WALLET, ROUTER, CALLDATA)]);
    const ok = await (await scenario('TRANSFER_LOGS', [COMPILED], { to: WALLET, input: executeBatchInput, trace: clean })).run('EXACT');
    expect(ok.status).toBe('VERIFIED');
    expect(ok.transactionBinding).toBe('CALL_TRACE');

    const dirty = frame(WALLET, WALLET, executeBatchInput, [frame(WALLET, ROUTER, CALLDATA), frame(WALLET, SIBLING.target, SIBLING.callData)]);
    const refused = await (await scenario('TRANSFER_LOGS', [COMPILED], { to: WALLET, input: executeBatchInput, trace: dirty })).run('EXACT');
    expect(refused).toMatchObject({ status: 'FAILED', walletBindingIssue: 'UNEXPECTED_CALL' });

    // The same dirty trace under 'OFF' is the known gap T-1: accepted.
    const legacy = await (await scenario('TRANSFER_LOGS', [COMPILED], { to: WALLET, input: executeBatchInput, trace: dirty })).run('OFF');
    expect(legacy.status).toBe('VERIFIED');
  });

  it('a bound envelope is cross-checked against a trace when one is available', async () => {
    const input = viaManager([APPROVE, COMPILED]);
    const consistent = frame(WALLET, MM.delegationManager, input, [frame(MM.delegationManager, WALLET, '0xd691c964', [
      frame(WALLET, INPUT, APPROVE.callData), frame(WALLET, ROUTER, CALLDATA)])]);
    expect((await (await scenario('TRANSFER_LOGS', [APPROVE, COMPILED], { trace: consistent })).run('EXACT')).status).toBe('VERIFIED');
    const extra = frame(WALLET, MM.delegationManager, input, [frame(MM.delegationManager, WALLET, '0xd691c964', [
      frame(WALLET, INPUT, APPROVE.callData), frame(WALLET, ROUTER, CALLDATA), frame(WALLET, OTHER, '0x')])]);
    expect(await (await scenario('TRANSFER_LOGS', [APPROVE, COMPILED], { trace: extra })).run('EXACT')).toMatchObject({ status: 'FAILED', walletBindingIssue: 'UNEXPECTED_CALL' });
  });

  it('rejects an unknown binding option', async () => {
    await expect((await scenario('TRANSFER_LOGS')).run('MAYBE' as never)).rejects.toThrow(/smartAccountBinding/);
  });
});
