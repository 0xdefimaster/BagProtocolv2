import { describe, expect, it } from 'vitest';
import { BagSdkError, EXECUTION_PATHS, hasAtomicBatchCapability, selectExecutionPath, type ExecutionPathFacts } from '../src';

const erc20 = (over: Partial<ExecutionPathFacts> = {}, wallet: Partial<ExecutionPathFacts['wallet']> = {}): ExecutionPathFacts => ({
  payment: 'erc20',
  approvalsNeeded: 1,
  ...over,
  wallet: { atomicBatch: false, ...wallet },
});

const candidate = (facts: ExecutionPathFacts, path: string) => selectExecutionPath(facts).candidates.find((c) => c.path === path)!;

describe('selectExecutionPath', () => {
  it('reports every rule in table order, whatever is chosen', () => {
    expect(EXECUTION_PATHS).toEqual(['NATIVE', 'DIRECT', 'ATOMIC_BATCH', 'PERMIT2_RELAYED', 'PERMIT2_SELF', 'SEQUENTIAL']);
    expect(Object.isFrozen(EXECUTION_PATHS)).toBe(true);
    expect(selectExecutionPath(erc20()).candidates.map((c) => c.path)).toEqual([...EXECUTION_PATHS]);
  });

  it('native payment: one transaction on every wallet; every ERC-20 path says why not', () => {
    const s = selectExecutionPath({ payment: 'native', approvalsNeeded: 0, wallet: { atomicBatch: false } });
    expect(s).toMatchObject({ path: 'NATIVE', walletPrompts: 1, payerTransactions: 1, notes: [], ranked: ['NATIVE'] });
    for (const c of s.candidates.slice(1)) expect(c).toMatchObject({ eligible: false, walletPrompts: null, payerTransactions: null });
    expect(s.candidates.slice(1).every((c) => c.blockedBy.includes('NATIVE_PAYMENT'))).toBe(true);
  });

  it('ERC-20 whose allowance already suffices: the purchase transaction alone', () => {
    const s = selectExecutionPath(erc20({ approvalsNeeded: 0 }, { atomicBatch: true }));
    expect(s).toMatchObject({ path: 'DIRECT', walletPrompts: 1, payerTransactions: 1, ranked: ['DIRECT'] });
    expect(candidate(erc20({ approvalsNeeded: 0 }), 'NATIVE').blockedBy).toEqual(['NOT_NATIVE_PAYMENT']);
    expect(candidate(erc20({ approvalsNeeded: 0 }), 'SEQUENTIAL').blockedBy).toEqual(['NO_APPROVALS_NEEDED']);
  });

  it('wallet with atomic batching (MetaMask): one confirmation, sequential as the fallback', () => {
    const s = selectExecutionPath(erc20({ approvalsNeeded: 2 }, { atomicBatch: true }));
    expect(s).toMatchObject({ path: 'ATOMIC_BATCH', walletPrompts: 1, payerTransactions: 1, ranked: ['ATOMIC_BATCH', 'SEQUENTIAL'] });
    expect(candidate(erc20({ approvalsNeeded: 2 }, { atomicBatch: true }), 'SEQUENTIAL')).toMatchObject({ walletPrompts: 3, payerTransactions: 3 });
  });

  it('wallet without batching (Rabby) on a Composer purchase: sequential, with the reasons the others do not apply', () => {
    const facts = erc20({}, { typedDataSigning: true });
    expect(selectExecutionPath(facts)).toMatchObject({ path: 'SEQUENTIAL', walletPrompts: 2, payerTransactions: 2, ranked: ['SEQUENTIAL'] });
    expect(candidate(facts, 'ATOMIC_BATCH').blockedBy).toEqual(['NO_ATOMIC_BATCH']);
    expect(candidate(facts, 'PERMIT2_RELAYED').blockedBy).toEqual(['EXECUTOR_NO_PERMIT2', 'NO_RELAYER']);
    expect(candidate(facts, 'PERMIT2_SELF').blockedBy).toEqual(['EXECUTOR_NO_PERMIT2']);
  });

  it('wallet without batching, Permit2 executor and a relayer: one signature, no gas', () => {
    const facts = erc20({ executorAcceptsPermit2: true, relayerAvailable: true }, { typedDataSigning: true, permit2Approved: true });
    expect(selectExecutionPath(facts)).toMatchObject({
      path: 'PERMIT2_RELAYED',
      walletPrompts: 1,
      payerTransactions: 0,
      notes: [],
      ranked: ['PERMIT2_RELAYED', 'PERMIT2_SELF', 'SEQUENTIAL'],
    });
    expect(candidate(facts, 'PERMIT2_SELF')).toMatchObject({ walletPrompts: 2, payerTransactions: 1 });
  });

  it('first Permit2 use counts the one-time approval to Permit2 and says so', () => {
    const s = selectExecutionPath(erc20({ executorAcceptsPermit2: true, relayerAvailable: true }, { typedDataSigning: true }));
    expect(s).toMatchObject({ path: 'PERMIT2_RELAYED', walletPrompts: 2, payerTransactions: 1, notes: ['PERMIT2_SETUP_REQUIRED'] });
    // A tie on prompts keeps rule order.
    expect(s.ranked).toEqual(['PERMIT2_RELAYED', 'SEQUENTIAL', 'PERMIT2_SELF']);
  });

  it('without a relayer the payer submits the Permit2 purchase; equal prompts keep rule order', () => {
    const s = selectExecutionPath(erc20({ executorAcceptsPermit2: true }, { typedDataSigning: true, permit2Approved: true }));
    expect(s).toMatchObject({ path: 'PERMIT2_SELF', walletPrompts: 2, payerTransactions: 1, ranked: ['PERMIT2_SELF', 'SEQUENTIAL'] });
  });

  it('a batching wallet keeps the self-submitted batch ahead of an equally short relayed path', () => {
    const s = selectExecutionPath(erc20({ executorAcceptsPermit2: true, relayerAvailable: true }, { atomicBatch: true, typedDataSigning: true, permit2Approved: true }));
    expect(s.ranked).toEqual(['ATOMIC_BATCH', 'PERMIT2_RELAYED', 'PERMIT2_SELF', 'SEQUENTIAL']);
  });

  it('an omitted capability is never assumed', () => {
    const facts = erc20({ executorAcceptsPermit2: true, relayerAvailable: true });
    expect(candidate(facts, 'PERMIT2_RELAYED').blockedBy).toEqual(['NO_TYPED_DATA_SIGNING']);
    expect(selectExecutionPath(facts).path).toBe('SEQUENTIAL');
  });

  it('is pure: the same facts give the same selection', () => {
    const facts = erc20({ approvalsNeeded: 3, executorAcceptsPermit2: true }, { typedDataSigning: true });
    expect(selectExecutionPath(facts)).toEqual(selectExecutionPath(JSON.parse(JSON.stringify(facts))));
  });

  it('malformed or contradictory facts fail closed', () => {
    const bad: unknown[] = [
      null,
      { ...erc20(), payment: 'eth' },
      erc20({ approvalsNeeded: -1 }),
      erc20({ approvalsNeeded: 1.5 }),
      { payment: 'native', approvalsNeeded: 1, wallet: { atomicBatch: false } },
      { payment: 'erc20', approvalsNeeded: 1 },
      { payment: 'erc20', approvalsNeeded: 1, wallet: {} },
      erc20({}, { typedDataSigning: 'yes' as unknown as boolean }),
      erc20({ relayerAvailable: 1 as unknown as boolean }),
    ];
    for (const facts of bad) {
      expect(() => selectExecutionPath(facts as ExecutionPathFacts)).toThrow(BagSdkError);
      try { selectExecutionPath(facts as ExecutionPathFacts); } catch (e) { expect((e as BagSdkError).code).toBe('INVALID_ARGUMENT'); }
    }
  });
});

describe('hasAtomicBatchCapability', () => {
  const CHAIN = 8453;
  const HEX = '0x2105';

  it('true for EIP-5792 v2 atomic supported/ready and the older atomicBatch flag', () => {
    expect(hasAtomicBatchCapability({ [HEX]: { atomic: { status: 'supported' } } }, CHAIN)).toBe(true);
    expect(hasAtomicBatchCapability({ [HEX]: { atomic: { status: 'ready' } } }, CHAIN)).toBe(true);
    expect(hasAtomicBatchCapability({ [HEX]: { atomicBatch: { supported: true } } }, CHAIN)).toBe(true);
  });

  it('counts the chain under a decimal or upper-case key and the all-chains entry', () => {
    expect(hasAtomicBatchCapability({ [String(CHAIN)]: { atomic: { status: 'supported' } } }, CHAIN)).toBe(true);
    expect(hasAtomicBatchCapability({ '0X2105': { atomic: { status: 'supported' } } }, CHAIN)).toBe(true);
    expect(hasAtomicBatchCapability({ '0x0': { atomic: { status: 'supported' } } }, CHAIN)).toBe(true);
  });

  it('false when unsupported, for another chain only, or malformed', () => {
    expect(hasAtomicBatchCapability({ [HEX]: { atomic: { status: 'unsupported' } } }, CHAIN)).toBe(false);
    expect(hasAtomicBatchCapability({ [HEX]: { atomicBatch: { supported: 'true' } } }, CHAIN)).toBe(false);
    expect(hasAtomicBatchCapability({ '0xa4b1': { atomic: { status: 'supported' } } }, CHAIN)).toBe(false);
    for (const caps of [null, undefined, 'supported', 1, [], { [HEX]: null }, { [HEX]: 'atomic' }]) expect(hasAtomicBatchCapability(caps, CHAIN)).toBe(false);
  });

  it('a throwing getter is false, not an error', () => {
    const hostile = { get [HEX]() { throw new Error('boom'); } };
    expect(hasAtomicBatchCapability(hostile, CHAIN)).toBe(false);
  });

  it('rejects an invalid chain id', () => {
    for (const chainId of [0, -1, 1.5, Number.NaN]) expect(() => hasAtomicBatchCapability({}, chainId)).toThrow(BagSdkError);
  });
});
