import { describe, expect, it } from 'vitest';
import { describeWalletError } from '../wallet-error';

describe('describeWalletError', () => {
  it('reads a plain EIP-1193 rejection object (what injected wallets throw)', () => {
    expect(describeWalletError({ code: 4001, message: 'User rejected the request.' })).toEqual({
      message: 'User rejected the request. (code 4001)',
      code: 4001,
      rejected: true,
    });
  });

  it('reads a nested provider error object instead of printing [object Object]', () => {
    const d = describeWalletError({ code: -32603, data: { message: 'execution reverted: Transfer failed' } });
    expect(d.message).toBe('execution reverted: Transfer failed (code -32603)');
    expect(d.rejected).toBe(false);
  });

  it('prefers viem shortMessage and finds the provider code on the cause', () => {
    const err = Object.assign(new Error('long viem message with docs link'), {
      shortMessage: 'The total cost (gas * gas fee + value) exceeds the balance.',
      cause: { code: -32000 },
    });
    expect(describeWalletError(err)).toMatchObject({ message: 'The total cost (gas * gas fee + value) exceeds the balance. (code -32000)', code: -32000, rejected: false });
  });

  it('recognises an ethers-style rejection code', () => {
    expect(describeWalletError({ code: 'ACTION_REJECTED', message: 'user rejected action' }).rejected).toBe(true);
  });

  it('falls back to JSON, then a fixed text, and never throws', () => {
    expect(describeWalletError({ reason: 'weird' }).message).toBe('{"reason":"weird"}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeWalletError(cyclic).message).toBe('Unknown wallet error.');
    expect(describeWalletError('plain string').message).toBe('plain string');
  });

  it('a locked MetaMask (KeyringController, -32603) says to unlock the wallet, and is not a rejection', () => {
    const d = describeWalletError({ code: -32603, message: 'KeyringController - The operation cannot be completed while the controller is locked.' });
    expect(d).toEqual({ message: 'Your wallet is locked. Open MetaMask, unlock it with your password, then try again.', code: -32603, rejected: false });
    expect(describeWalletError({ code: -32603, message: 'Internal error', data: { message: 'KeyringController - controller is locked' } }).message).toMatch(/wallet is locked/);
  });
});

