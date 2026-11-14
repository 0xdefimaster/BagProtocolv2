import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { BAG_V1_CHAINS } from './chains';
import { BagSdkError } from './errors';
import type { Hex } from './types';

// -----------------------------------------------------------------------------
// Exact binding of a wallet transaction to the calls BAG compiled (policy bag-wallet-envelope/v1).
//
// A smart-account wallet (EIP-7702) does not call the compiled target directly: it calls itself, or MetaMask's
// DelegationManager, and its own code then runs a list of executions. Finding the compiled call somewhere in that
// calldata is not enough: other executions in the same transaction can move tokens into or out of the wallet, and
// a receipt-wide Transfer sum or balance delta then credits them to the purchase, sale or rebalance (T-1). An
// envelope sent to an arbitrary contract that merely carries the compiled bytes never runs the call at all (F-01).
//
// This module accepts a transaction only when:
//   1. it comes from the wallet, and is either the compiled call itself (DIRECT), or one of the envelopes the pinned
//      MetaMask EIP7702StatelessDeleGator executes: execute(bytes32,bytes) or execute((address,uint256,bytes)) on
//      the wallet itself, or redeemDelegations(...) on the wallet or on the pinned DelegationManager with only
//      self-authorized (empty) permission contexts;
//   2. every encoding is canonical ABI (decode, re-encode, compare), so no parser can read it differently;
//   3. every execution uses the default execution type (a failing call reverts the transaction) and the single or
//      batch call type, with zero mode selector and payload;
//   4. the executions are exactly the compiled call, once, plus ERC-20 approve calls to allowed (token, spender)
//      pairs within their allowed amounts, and nothing else;
//   5. (checkWalletExecutionState) the wallet's code before the block is the 7702 designator of a pinned delegate
//      whose DelegationManager matches, the transaction carries no authorization list, and no other nonce-changing
//      event touched the wallet earlier in the block, so the code that ran was the pinned code.
//
// Semantics are taken from the verified sources (Sourcify exact match on Base) of DelegationManager and
// EIP7702StatelessDeleGator (MetaMask Delegation Framework v1.3.0); chain copies were compared byte for byte
// (scripts/audit/verify-smart-account-pins.mjs, evidence/smart-account/). Pure and read-only: nothing is signed
// or sent.
// -----------------------------------------------------------------------------

export const WALLET_ENVELOPE_POLICY = 'bag-wallet-envelope/v1';

export interface TrustedSmartAccount {
  readonly name: string;
  /** Implementation address carried in the wallet's EIP-7702 delegation designator (0xef0100 ‖ delegate). */
  readonly delegate: Hex;
  /** The DelegationManager the implementation trusts (its immutable delegationManager()). */
  readonly delegationManager: Hex;
}

export const METAMASK_EIP7702_STATELESS_DELEGATOR: TrustedSmartAccount = Object.freeze({
  name: 'MetaMask Delegation Framework v1.3.0 EIP7702StatelessDeleGator',
  delegate: '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b' as Hex,
  delegationManager: '0xdb9b1e94b5b69df7e401ddbede43491141047db3' as Hex,
});

/**
 * Per chain id: the smart accounts whose envelopes are accepted. A chain is listed only after its copies of both
 * contracts were read on-chain and matched the verified build (2026-11-14: Robinhood, Base, Arbitrum One).
 * Any other chain accepts DIRECT transactions only.
 */
export const TRUSTED_SMART_ACCOUNTS: Readonly<Record<number, readonly TrustedSmartAccount[]>> = Object.freeze({
  [BAG_V1_CHAINS.robinhood]: Object.freeze([METAMASK_EIP7702_STATELESS_DELEGATOR]),
  [BAG_V1_CHAINS.base]: Object.freeze([METAMASK_EIP7702_STATELESS_DELEGATOR]),
  [BAG_V1_CHAINS.arbitrum]: Object.freeze([METAMASK_EIP7702_STATELESS_DELEGATOR]),
});

export interface WalletCallExpectation {
  chainId: number;
  wallet: string;
  /** The compiled call: it must run exactly once. */
  call: { to: string; data: string; value: bigint };
  /** ERC-20 approve calls that may accompany it: (token, spender) pairs, each up to maxAmountRaw. */
  approvals?: readonly { token: string; spender: string; maxAmountRaw: bigint }[];
}

export interface WalletEnvelopeTransaction {
  from: string;
  to: string | null;
  input: string;
  value: bigint;
}

export interface WalletExecutionTransaction extends WalletEnvelopeTransaction {
  nonce?: number;
  type?: string;
  authorizationList?: readonly unknown[] | null;
  blockNumber?: bigint | null;
}

export interface DecodedWalletExecution {
  target: Hex;
  value: bigint;
  callData: Hex;
}

export type WalletEnvelopeKind =
  | 'DIRECT'
  | 'SELF_EXECUTE_MODE'
  | 'SELF_EXECUTE_SINGLE'
  | 'SELF_REDEEM_DELEGATIONS'
  | 'DELEGATION_MANAGER';

export type WalletEnvelopeIssueCode =
  | 'NOT_FROM_WALLET'
  | 'TRANSACTION_MISMATCH'
  | 'UNSUPPORTED_ENVELOPE'
  | 'NON_CANONICAL_ENVELOPE'
  | 'UNSUPPORTED_EXECUTION_MODE'
  | 'DELEGATED_EXECUTION'
  | 'ENVELOPE_VALUE_NOT_ZERO'
  | 'COMPILED_CALL_MISSING'
  | 'COMPILED_CALL_REPEATED'
  | 'UNEXPECTED_CALL'
  | 'APPROVAL_NOT_ALLOWED'
  | 'DELEGATE_NOT_TRUSTED'
  | 'DELEGATE_CHANGED_IN_TRANSACTION'
  | 'WALLET_STATE_CHANGED_IN_BLOCK'
  | 'STATE_UNAVAILABLE';

export type WalletEnvelopeBinding =
  | {
      ok: true;
      envelope: WalletEnvelopeKind;
      executions: DecodedWalletExecution[];
      /** Smart accounts the wallet's code may be (empty for DIRECT, which runs no wallet code). */
      candidates: readonly TrustedSmartAccount[];
    }
  | { ok: false; code: WalletEnvelopeIssueCode; detail: string };

export type WalletExecutionVerification =
  | { status: 'BOUND'; envelope: WalletEnvelopeKind; executions: DecodedWalletExecution[]; smartAccount: TrustedSmartAccount | null }
  | { status: 'REFUSED'; code: WalletEnvelopeIssueCode; detail: string }
  | { status: 'INDETERMINATE'; code: 'STATE_UNAVAILABLE'; detail: string };

/** Caller-owned read-only state reader; a viem public client satisfies it. */
export interface WalletStateReader {
  getCode(args: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined | null>;
  getTransactionCount(args: { address: Hex; blockNumber: bigint }): Promise<number>;
  /** Needed only when the wallet sent another transaction earlier in the same block. */
  getBlock?(args: { blockNumber: bigint; includeTransactions: true }): Promise<{ transactions?: readonly unknown[] } | null>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CALLDATA = /^0x(?:[0-9a-fA-F]{2}){4,}$/;
const HEXBYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX_UINT = BigInt(2) ** BigInt(256);
const ZERO = BigInt(0);
const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const EXECUTE_MODE_ABI = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const EXECUTE_SINGLE_ABI = parseAbi(['function execute((address target, uint256 value, bytes callData) execution)']);
const REDEEM_ABI = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount)']);
// Derived from the signatures, never typed by hand (0xe9ae5c53, 0x5c1c6dcd, 0xcef6d209, 0x095ea7b3; all four are
// in the pinned implementation's dispatcher except approve, which targets tokens).
const EXECUTE_MODE_SELECTOR = toFunctionSelector(EXECUTE_MODE_ABI[0]);
const EXECUTE_SINGLE_SELECTOR = toFunctionSelector(EXECUTE_SINGLE_ABI[0]);
const REDEEM_SELECTOR = toFunctionSelector(REDEEM_ABI[0]);
const APPROVE_SELECTOR = toFunctionSelector(APPROVE_ABI[0]);

const EXECUTIONS = [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }] as const;
const DELEGATIONS = [{
  type: 'tuple[]',
  components: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] },
    { name: 'salt', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
}] as const;
/** abi.encode(new Delegation[](0)): the only accepted permission context (self-authorized execution). */
export const SELF_AUTHORIZED_PERMISSION_CONTEXT: Hex = encodeAbiParameters(DELEGATIONS, [[]]);

type Issue = { ok: false; code: WalletEnvelopeIssueCode; detail: string };
const issue = (code: WalletEnvelopeIssueCode, detail: string): Issue => ({ ok: false, code, detail });

/** Decodes calldata against one function and accepts it only if re-encoding reproduces it byte for byte. */
function canonical<T extends readonly unknown[]>(abi: readonly unknown[], data: string): T | null {
  try {
    const decoded = decodeFunctionData({ abi: abi as never, data: data as Hex }) as { functionName: string; args: T };
    const params = { abi, functionName: decoded.functionName, args: decoded.args } as unknown as Parameters<typeof encodeFunctionData>[0];
    const again = encodeFunctionData(params);
    return again.toLowerCase() === data.toLowerCase() ? decoded.args : null;
  } catch {
    return null;
  }
}

/** ERC-7579 mode word: call type single (0x00) or batch (0x01), default exec type, zero selector and payload. */
function executionsFor(mode: string, executionCalldata: string): { ok: true; executions: DecodedWalletExecution[] } | Issue {
  const m = mode.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(m) || !HEXBYTES.test(executionCalldata)) return issue('NON_CANONICAL_ENVELOPE', 'Malformed mode or execution calldata.');
  const callType = m.slice(2, 4);
  if (m.slice(4, 6) !== '00') return issue('UNSUPPORTED_EXECUTION_MODE', 'Only the default execution type is accepted: try-mode can swallow a failed call.');
  if (/[^0]/.test(m.slice(6))) return issue('UNSUPPORTED_EXECUTION_MODE', 'Mode selector and payload must be zero.');
  const data = executionCalldata.toLowerCase();
  if (callType === '00') {
    // ExecutionLib.decodeSingle: target ‖ value ‖ callData, packed.
    if (data.length < 2 + 2 * 52) return issue('NON_CANONICAL_ENVELOPE', 'Single execution shorter than target and value.');
    return {
      ok: true,
      executions: [{ target: `0x${data.slice(2, 42)}` as Hex, value: BigInt(`0x${data.slice(42, 106)}`), callData: `0x${data.slice(106)}` as Hex }],
    };
  }
  if (callType !== '01') return issue('UNSUPPORTED_EXECUTION_MODE', `Call type 0x${callType} is not single or batch.`);
  try {
    const [decoded] = decodeAbiParameters(EXECUTIONS, data as Hex);
    if (encodeAbiParameters(EXECUTIONS, [decoded]).toLowerCase() !== data) return issue('NON_CANONICAL_ENVELOPE', 'Batch executions are not canonically encoded.');
    if (decoded.length === 0) return issue('COMPILED_CALL_MISSING', 'Empty batch.');
    return { ok: true, executions: decoded.map(([target, value, callData]) => ({ target: target.toLowerCase() as Hex, value, callData: callData.toLowerCase() as Hex })) };
  } catch {
    return issue('NON_CANONICAL_ENVELOPE', 'Batch executions do not decode.');
  }
}

/** redeemDelegations: every permission context must be the self-authorized empty chain. */
function redeemExecutions(input: string): { ok: true; executions: DecodedWalletExecution[] } | Issue {
  const args = canonical<readonly [readonly Hex[], readonly Hex[], readonly Hex[]]>(REDEEM_ABI, input);
  if (!args) return issue('NON_CANONICAL_ENVELOPE', 'redeemDelegations calldata is not canonical.');
  const [contexts, modes, datas] = args;
  if (contexts.length === 0 || contexts.length !== modes.length || contexts.length !== datas.length) {
    return issue('NON_CANONICAL_ENVELOPE', 'redeemDelegations arrays are empty or of different lengths.');
  }
  const executions: DecodedWalletExecution[] = [];
  for (let i = 0; i < contexts.length; i++) {
    if (contexts[i].toLowerCase() !== SELF_AUTHORIZED_PERMISSION_CONTEXT) {
      try {
        const [delegations] = decodeAbiParameters(DELEGATIONS, contexts[i]);
        if (delegations.length > 0) return issue('DELEGATED_EXECUTION', `Permission context ${i} redeems a delegation: another account would execute.`);
      } catch {
        /* falls through: not decodable */
      }
      return issue('NON_CANONICAL_ENVELOPE', `Permission context ${i} is not the canonical empty delegation chain.`);
    }
    const part = executionsFor(modes[i], datas[i]);
    if (!part.ok) return part;
    executions.push(...part.executions);
  }
  return { ok: true, executions };
}

/** Exactly one compiled call; any other execution must be an allowed ERC-20 approve. */
function classify(executions: readonly DecodedWalletExecution[], expectation: WalletCallExpectation): Issue | null {
  let compiled = 0;
  const { call } = expectation;
  for (const [i, e] of executions.entries()) {
    if (same(e.target, call.to) && same(e.callData, call.data) && e.value === call.value) {
      compiled++;
      continue;
    }
    if (e.callData.toLowerCase().startsWith(APPROVE_SELECTOR)) {
      const args = canonical<readonly [Hex, bigint]>(APPROVE_ABI, e.callData);
      const allowed = args && expectation.approvals?.find((a) => same(a.token, e.target) && same(a.spender, args[0]));
      if (!args || !allowed || e.value !== ZERO || args[1] > allowed.maxAmountRaw) {
        return issue('APPROVAL_NOT_ALLOWED', `Execution ${i} approves ${e.target} for a spender or amount that was not built.`);
      }
      continue;
    }
    return issue('UNEXPECTED_CALL', `Execution ${i} calls ${e.target} (${e.callData.slice(0, 10)}), which is not part of the built transaction.`);
  }
  if (compiled === 0) return issue('COMPILED_CALL_MISSING', 'The built call is not among the executions.');
  if (compiled > 1) return issue('COMPILED_CALL_REPEATED', `The built call runs ${compiled} times.`);
  return null;
}

function assertExpectation(expectation: WalletCallExpectation): void {
  const { chainId, wallet, call, approvals } = expectation;
  const bad = !Number.isSafeInteger(chainId) || chainId < 1 || !ADDRESS.test(wallet) || !call || !ADDRESS.test(call.to) ||
    !CALLDATA.test(call.data) || typeof call.value !== 'bigint' || call.value < ZERO || call.value >= MAX_UINT ||
    (approvals !== undefined && (!Array.isArray(approvals) || approvals.some((a) => !a || !ADDRESS.test(a.token) || !ADDRESS.test(a.spender) ||
      typeof a.maxAmountRaw !== 'bigint' || a.maxAmountRaw < ZERO || a.maxAmountRaw >= MAX_UINT)));
  if (bad) throw new BagSdkError('INVALID_ARGUMENT', 'Wallet call expectation is malformed.');
}

/**
 * Pure: binds a mined transaction's envelope to the expected calls. Smart-account envelopes additionally need
 * checkWalletExecutionState (or verifyWalletExecution, which runs both).
 */
export function bindWalletEnvelope(
  tx: WalletEnvelopeTransaction,
  expectation: WalletCallExpectation,
  trusted: readonly TrustedSmartAccount[] = TRUSTED_SMART_ACCOUNTS[expectation.chainId] ?? [],
): WalletEnvelopeBinding {
  assertExpectation(expectation);
  if (!tx || !same(tx.from, expectation.wallet)) return issue('NOT_FROM_WALLET', 'The transaction was not sent by the wallet.');
  if (typeof tx.input !== 'string' || !HEXBYTES.test(tx.input) || typeof tx.value !== 'bigint' || typeof tx.to !== 'string' || !ADDRESS.test(tx.to)) {
    return issue('UNSUPPORTED_ENVELOPE', 'Not a call transaction.');
  }
  if (same(tx.to, expectation.call.to)) {
    if (same(tx.input, expectation.call.data) && tx.value === expectation.call.value) {
      return { ok: true, envelope: 'DIRECT', executions: [{ target: tx.to as Hex, value: tx.value, callData: tx.input as Hex }], candidates: [] };
    }
    return issue('TRANSACTION_MISMATCH', 'A direct call to the built target with other calldata or value.');
  }
  if (trusted.length === 0) return issue('UNSUPPORTED_ENVELOPE', `No trusted smart account is pinned for chain ${expectation.chainId}.`);
  const selector = tx.input.slice(0, 10).toLowerCase();
  let envelope: WalletEnvelopeKind;
  let decoded: { ok: true; executions: DecodedWalletExecution[] } | Issue;
  let candidates: readonly TrustedSmartAccount[] = trusted;

  if (same(tx.to, expectation.wallet)) {
    if (selector === EXECUTE_MODE_SELECTOR) {
      const args = canonical<readonly [Hex, Hex]>(EXECUTE_MODE_ABI, tx.input);
      if (!args) return issue('NON_CANONICAL_ENVELOPE', 'execute(bytes32,bytes) calldata is not canonical.');
      envelope = 'SELF_EXECUTE_MODE';
      decoded = executionsFor(args[0], args[1]);
    } else if (selector === EXECUTE_SINGLE_SELECTOR) {
      const args = canonical<readonly [{ target: Hex; value: bigint; callData: Hex }]>(EXECUTE_SINGLE_ABI, tx.input);
      if (!args) return issue('NON_CANONICAL_ENVELOPE', 'execute((address,uint256,bytes)) calldata is not canonical.');
      envelope = 'SELF_EXECUTE_SINGLE';
      decoded = { ok: true, executions: [{ target: args[0].target.toLowerCase() as Hex, value: args[0].value, callData: args[0].callData.toLowerCase() as Hex }] };
    } else if (selector === REDEEM_SELECTOR) {
      if (tx.value !== ZERO) return issue('ENVELOPE_VALUE_NOT_ZERO', 'redeemDelegations is not payable.');
      envelope = 'SELF_REDEEM_DELEGATIONS';
      decoded = redeemExecutions(tx.input);
    } else {
      return issue('UNSUPPORTED_ENVELOPE', `Self-call selector ${selector} is not an execution the pinned smart account supports.`);
    }
  } else {
    candidates = trusted.filter((t) => same(t.delegationManager, tx.to));
    if (candidates.length === 0 || selector !== REDEEM_SELECTOR) {
      return issue('UNSUPPORTED_ENVELOPE', 'The transaction targets neither the built contract, the wallet itself, nor a pinned DelegationManager.');
    }
    if (tx.value !== ZERO) return issue('ENVELOPE_VALUE_NOT_ZERO', 'redeemDelegations is not payable.');
    envelope = 'DELEGATION_MANAGER';
    decoded = redeemExecutions(tx.input);
  }
  if (!decoded.ok) return decoded;
  const problem = classify(decoded.executions, expectation);
  if (problem) return problem;
  return { ok: true, envelope, executions: decoded.executions, candidates };
}

const DESIGNATOR = /^0xef0100([0-9a-f]{40})$/;

/**
 * Proves the code that executed the envelope was a pinned delegate: designator before the block, no authorization
 * in this transaction, and no nonce-changing event for the wallet earlier in the block (a valid EIP-7702
 * authorization always increments the authority's nonce). Any read failure is STATE_UNAVAILABLE, never a pass.
 */
export async function checkWalletExecutionState(
  reader: WalletStateReader,
  tx: WalletExecutionTransaction,
  binding: Extract<WalletEnvelopeBinding, { ok: true }>,
): Promise<{ ok: true; smartAccount: TrustedSmartAccount | null } | Issue> {
  if (binding.envelope === 'DIRECT') return { ok: true, smartAccount: null };
  if (tx.type === undefined) return issue('STATE_UNAVAILABLE', 'Transaction type is unknown.');
  if (tx.type === 'eip7702' || (Array.isArray(tx.authorizationList) && tx.authorizationList.length > 0)) {
    return issue('DELEGATE_CHANGED_IN_TRANSACTION', 'The transaction carries an EIP-7702 authorization list.');
  }
  if (typeof tx.blockNumber !== 'bigint' || tx.blockNumber < BigInt(1) || !Number.isSafeInteger(tx.nonce) || (tx.nonce as number) < 0) {
    return issue('STATE_UNAVAILABLE', 'Block number or nonce is unknown.');
  }
  const wallet = tx.from as Hex;
  const before = tx.blockNumber - BigInt(1);
  try {
    const code = ((await reader.getCode({ address: wallet, blockNumber: before })) ?? '0x').toLowerCase();
    const designated = DESIGNATOR.exec(code);
    const smartAccount = designated ? binding.candidates.find((c) => same(c.delegate, `0x${designated[1]}`)) : undefined;
    if (!smartAccount) {
      return issue('DELEGATE_NOT_TRUSTED', designated ? `The wallet delegates to 0x${designated[1]}, which is not pinned.` : 'The wallet has no EIP-7702 delegation to a pinned smart account.');
    }
    const nonceBefore = await reader.getTransactionCount({ address: wallet, blockNumber: before });
    if (!Number.isSafeInteger(nonceBefore)) return issue('STATE_UNAVAILABLE', 'Nonce read failed.');
    const nonce = tx.nonce as number;
    if (nonceBefore === nonce) return { ok: true, smartAccount };
    if (nonceBefore > nonce) return issue('STATE_UNAVAILABLE', 'The reader returned a nonce ahead of the transaction.');
    if (!reader.getBlock) return issue('STATE_UNAVAILABLE', 'The wallet sent earlier transactions in this block; reading them needs block transactions.');
    const block = await reader.getBlock({ blockNumber: tx.blockNumber, includeTransactions: true });
    const txs = block?.transactions;
    if (!Array.isArray(txs) || txs.some((t) => !t || typeof t !== 'object')) return issue('STATE_UNAVAILABLE', 'Block transactions are not available in full.');
    const earlier = txs.filter((t) => {
      const x = t as { from?: string; nonce?: number | bigint };
      return same(x.from, wallet) && Number(x.nonce) < nonce;
    }).length;
    if (earlier !== nonce - nonceBefore) {
      return issue('WALLET_STATE_CHANGED_IN_BLOCK', 'Something other than the wallet\'s own earlier transactions moved its nonce in this block (an EIP-7702 authorization can change its code).');
    }
    return { ok: true, smartAccount };
  } catch {
    return issue('STATE_UNAVAILABLE', 'Historical wallet state could not be read.');
  }
}

/** bindWalletEnvelope + checkWalletExecutionState. REFUSED is final; INDETERMINATE may succeed on another read. */
export async function verifyWalletExecution(
  reader: WalletStateReader,
  tx: WalletExecutionTransaction,
  expectation: WalletCallExpectation,
  trusted?: readonly TrustedSmartAccount[],
): Promise<WalletExecutionVerification> {
  const binding = bindWalletEnvelope(tx, expectation, trusted);
  if (!binding.ok) return { status: 'REFUSED', code: binding.code, detail: binding.detail };
  const state = await checkWalletExecutionState(reader, tx, binding);
  if (!state.ok) {
    return state.code === 'STATE_UNAVAILABLE'
      ? { status: 'INDETERMINATE', code: 'STATE_UNAVAILABLE', detail: state.detail }
      : { status: 'REFUSED', code: state.code, detail: state.detail };
  }
  return { status: 'BOUND', envelope: binding.envelope, executions: binding.executions, smartAccount: state.smartAccount };
}

/**
 * The wallet-originated CALL frames of a callTracer result, for exactness on traced transactions: every frame
 * below the root whose `from` is the wallet is an execution the wallet's code performed.
 */
export function walletExecutionsFromTrace(call: unknown, wallet: string): { ok: true; executions: DecodedWalletExecution[] } | Issue {
  if (!call || typeof call !== 'object') return issue('NON_CANONICAL_ENVELOPE', 'Malformed trace.');
  const executions: DecodedWalletExecution[] = [];
  const stack: { frame: Record<string, unknown>; depth: number }[] = [{ frame: call as Record<string, unknown>, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { frame: node, depth } = stack.pop()!;
    if (++visited > 10_000 || depth > 128) return issue('NON_CANONICAL_ENVELOPE', 'Trace too large.');
    if (depth > 0 && same(node.from as string, wallet)) {
      const type = String(node.type);
      if (type === 'STATICCALL') {
        /* read-only; cannot move value */
      } else if (type !== 'CALL') {
        return issue('UNSUPPORTED_EXECUTION_MODE', `The wallet performed a ${type}.`);
      } else if (typeof node.error === 'string' && node.error.length > 0) {
        return issue('UNSUPPORTED_EXECUTION_MODE', 'A wallet execution failed without reverting the transaction.');
      } else {
        const value = typeof node.value === 'string' && /^(0x[0-9a-fA-F]+|0|[1-9]\d*)$/.test(node.value) ? BigInt(node.value) : null;
        if (value === null || typeof node.to !== 'string' || !ADDRESS.test(node.to) || typeof node.input !== 'string' || !HEXBYTES.test(node.input)) {
          return issue('NON_CANONICAL_ENVELOPE', 'Malformed wallet frame.');
        }
        executions.push({ target: node.to.toLowerCase() as Hex, value, callData: node.input.toLowerCase() as Hex });
      }
    }
    const children = node.calls;
    if (children !== undefined) {
      if (!Array.isArray(children)) return issue('NON_CANONICAL_ENVELOPE', 'Malformed trace children.');
      for (const child of children) {
        if (!child || typeof child !== 'object') return issue('NON_CANONICAL_ENVELOPE', 'Malformed trace child.');
        stack.push({ frame: child as Record<string, unknown>, depth: depth + 1 });
      }
    }
  }
  return { ok: true, executions };
}

/** Exactness over executions observed in a trace (same rule as an envelope: the compiled call once, allowed approvals). */
export function checkWalletExecutions(executions: readonly DecodedWalletExecution[], expectation: WalletCallExpectation): { ok: true } | Issue {
  assertExpectation(expectation);
  return classify(executions, expectation) ?? { ok: true };
}
