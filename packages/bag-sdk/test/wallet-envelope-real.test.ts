import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, pad } from 'viem';
import { bindWalletEnvelope, checkWalletExecutionState, METAMASK_EIP7702_STATELESS_DELEGATOR as MM, type Hex, type WalletEnvelopeBinding } from '../src';

// -----------------------------------------------------------------------------
// A real MetaMask EIP-7702 transaction (Base mainnet, captured read-only 2026-11-14 with its pre-block state):
// an EIP-5792 batch the account executed on itself, approve + one call. The exact binding must accept it with the
// recorded state, and refuse every adversarial variant built from the same bytes.
// -----------------------------------------------------------------------------

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/metamask-7702-batch-base.json', import.meta.url)), 'utf8')) as {
  chainId: number; hash: Hex; from: Hex; to: Hex; value: string; nonce: number; type: string; blockNumber: string; input: Hex;
  stateBeforeBlock: { code: Hex; nonce: number };
};
const EXECUTE = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const APPROVE = parseAbi(['function approve(address spender, uint256 amount)', 'function transferFrom(address from, address to, uint256 amount)']);
const EXECUTIONS = [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }] as const;

const { args } = decodeFunctionData({ abi: EXECUTE, data: fixture.input });
const [mode, data] = args as [Hex, Hex];
const executions = (decodeAbiParameters(EXECUTIONS, data)[0] as readonly (readonly [Hex, bigint, Hex])[]).map(([target, value, callData]) => ({ target, value, callData }));
const approves = executions.filter((e) => e.callData.startsWith('0x095ea7b3'));
const [main] = executions.filter((e) => !e.callData.startsWith('0x095ea7b3'));
const expectation = {
  chainId: fixture.chainId,
  wallet: fixture.from,
  call: { to: main.target, data: main.callData, value: main.value },
  approvals: approves.map((e) => {
    const [spender, amount] = decodeFunctionData({ abi: APPROVE, data: e.callData }).args as [Hex, bigint];
    return { token: e.target, spender, maxAmountRaw: amount };
  }),
};
const tx = (input: Hex, to: Hex = fixture.to) => ({ from: fixture.from, to, input, value: BigInt(fixture.value) });
const reencode = (list: { target: Hex; value: bigint; callData: Hex }[], m: Hex = mode) =>
  encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [m, encodeAbiParameters(EXECUTIONS, [list.map((e) => [e.target, e.value, e.callData] as const)])] });
const recorded = {
  getCode: async () => fixture.stateBeforeBlock.code,
  getTransactionCount: async () => fixture.stateBeforeBlock.nonce,
};

describe('a real MetaMask EIP-7702 batch (Base mainnet)', () => {
  it('has the shape this test assumes: a self-call, batch mode, approve + one call, pinned delegate', () => {
    expect(fixture.to.toLowerCase()).toBe(fixture.from.toLowerCase());
    expect(mode).toBe(pad('0x01', { dir: 'right', size: 32 }));
    expect([approves.length, executions.length]).toEqual([1, 2]);
    expect(fixture.stateBeforeBlock.code.toLowerCase()).toBe(`0xef0100${MM.delegate.slice(2)}`);
  });

  it('binds exactly and passes the wallet-state check with the recorded pre-block state', async () => {
    const bound = bindWalletEnvelope(tx(fixture.input), expectation);
    expect(bound).toMatchObject({ ok: true, envelope: 'SELF_EXECUTE_MODE' });
    const state = await checkWalletExecutionState(recorded, { ...tx(fixture.input), nonce: fixture.nonce, type: fixture.type, blockNumber: BigInt(fixture.blockNumber) }, bound as Extract<WalletEnvelopeBinding, { ok: true }>);
    expect(state).toEqual({ ok: true, smartAccount: MM });
  });

  it('the same bytes with a sibling transferFrom appended are refused', () => {
    const sibling = { target: approves[0].target, value: BigInt(0), callData: encodeFunctionData({ abi: APPROVE, functionName: 'transferFrom', args: [main.target, fixture.from, BigInt(1)] }) };
    expect(bindWalletEnvelope(tx(reencode([...executions, sibling])), expectation)).toMatchObject({ ok: false, code: 'UNEXPECTED_CALL' });
  });

  it('the same executions in try mode are refused', () => {
    expect(bindWalletEnvelope(tx(reencode(executions, pad('0x0101', { dir: 'right', size: 32 }))), expectation)).toMatchObject({ ok: false, code: 'UNSUPPORTED_EXECUTION_MODE' });
  });

  it('the same calldata sent to another contract is refused', () => {
    expect(bindWalletEnvelope(tx(fixture.input, `0x${'9'.repeat(40)}` as Hex), expectation)).toMatchObject({ ok: false, code: 'UNSUPPORTED_ENVELOPE' });
  });

  it('the recorded state with another delegate, or a moved nonce, is refused', async () => {
    const bound = bindWalletEnvelope(tx(fixture.input), expectation) as Extract<WalletEnvelopeBinding, { ok: true }>;
    const mined = { ...tx(fixture.input), nonce: fixture.nonce, type: fixture.type, blockNumber: BigInt(fixture.blockNumber) };
    expect(await checkWalletExecutionState({ ...recorded, getCode: async () => `0xef0100${'4'.repeat(40)}` as Hex }, mined, bound)).toMatchObject({ ok: false, code: 'DELEGATE_NOT_TRUSTED' });
    expect(await checkWalletExecutionState({ ...recorded, getTransactionCount: async () => fixture.nonce - 1, getBlock: async () => ({ transactions: [] }) }, mined, bound))
      .toMatchObject({ ok: false, code: 'WALLET_STATE_CHANGED_IN_BLOCK' });
  });
});
