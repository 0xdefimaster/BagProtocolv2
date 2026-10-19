import { describe, expect, it, vi } from 'vitest';
import { numberToHex } from 'viem';
import { mainnet } from 'viem/chains';
import { BAG_CHAINS } from '@/lib/config/chains';
import { chainFeeHints, withChainFeeHints } from '@/lib/wallet/chain-fees';
import type { Eip1193Provider } from '@/lib/wallet/eth-provider';

const ROBINHOOD = numberToHex(BAG_CHAINS.robinhood.chainId);
const MAINNET = numberToHex(mainnet.id);
const BASE_FEE = BigInt(10_000_000); // 0.01 gwei

function fakeProvider(answers: Record<string, unknown>, failing: string[] = []) {
  const request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
    if (failing.includes(method)) throw new Error(`${method} unsupported`);
    if (method === 'eth_sendTransaction') return '0xhash';
    return answers[method];
  });
  const provider = { request, on: vi.fn(), removeListener: vi.fn(), isMetaMask: true } as unknown as Eip1193Provider & { request: typeof request };
  return provider;
}

const tx = { from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), data: '0x1234' };

describe('chainFeeHints', () => {
  it('reads EIP-1559 fees from the chain on Robinhood Chain: 2 × base fee + priority', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD, eth_getBlockByNumber: { baseFeePerGas: numberToHex(BASE_FEE) }, eth_maxPriorityFeePerGas: '0x0' });
    expect(await chainFeeHints(p, tx)).toEqual({ maxFeePerGas: numberToHex(BigInt(2) * BASE_FEE), maxPriorityFeePerGas: '0x0' });
  });

  it('adds the node priority fee and takes the chain id from the transaction when present', async () => {
    const p = fakeProvider({ eth_getBlockByNumber: { baseFeePerGas: numberToHex(BASE_FEE) }, eth_maxPriorityFeePerGas: numberToHex(BigInt(5)) });
    expect(await chainFeeHints(p, { ...tx, chainId: ROBINHOOD })).toEqual({ maxFeePerGas: numberToHex(BigInt(2) * BASE_FEE + BigInt(5)), maxPriorityFeePerGas: numberToHex(BigInt(5)) });
    expect(p.request).not.toHaveBeenCalledWith({ method: 'eth_chainId' });
  });

  it('treats a missing priority-fee method as a zero tip', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD, eth_getBlockByNumber: { baseFeePerGas: numberToHex(BASE_FEE) } }, ['eth_maxPriorityFeePerGas']);
    expect(await chainFeeHints(p, tx)).toEqual({ maxFeePerGas: numberToHex(BigInt(2) * BASE_FEE), maxPriorityFeePerGas: '0x0' });
  });

  it('uses the gas price on a chain without a base fee', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD, eth_getBlockByNumber: {}, eth_gasPrice: numberToHex(BASE_FEE) });
    expect(await chainFeeHints(p, tx)).toEqual({ gasPrice: numberToHex(BASE_FEE) });
  });

  it('leaves chains the wallet already prices (Ethereum) to the wallet', async () => {
    const p = fakeProvider({ eth_chainId: MAINNET, eth_getBlockByNumber: { baseFeePerGas: numberToHex(BASE_FEE) } });
    expect(await chainFeeHints(p, tx)).toBeNull();
  });

  it('never overrides fees or a type the caller chose', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD, eth_getBlockByNumber: { baseFeePerGas: numberToHex(BASE_FEE) } });
    expect(await chainFeeHints(p, { ...tx, maxFeePerGas: '0x1' })).toBeNull();
    expect(await chainFeeHints(p, { ...tx, gasPrice: '0x1' })).toBeNull();
    expect(await chainFeeHints(p, { ...tx, type: '0x0' })).toBeNull();
    expect(p.request).not.toHaveBeenCalled();
  });

  it('returns null when a read fails, so the wallet estimates as before', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD }, ['eth_getBlockByNumber']);
    expect(await chainFeeHints(p, tx)).toBeNull();
  });
});

describe('withChainFeeHints', () => {
  it('adds the fees to eth_sendTransaction and keeps every other field, never the gas limit', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD, eth_getBlockByNumber: { baseFeePerGas: numberToHex(BASE_FEE) }, eth_maxPriorityFeePerGas: '0x0' });
    await withChainFeeHints(p).request({ method: 'eth_sendTransaction', params: [{ ...tx, value: '0x5' }] });
    const sent = p.request.mock.calls.find(([a]) => a.method === 'eth_sendTransaction')![0];
    expect(sent.params).toEqual([{ ...tx, value: '0x5', maxFeePerGas: numberToHex(BigInt(2) * BASE_FEE), maxPriorityFeePerGas: '0x0' }]);
    expect(sent.params![0]).not.toHaveProperty('gas');
  });

  it('sends the transaction unchanged when the fee read fails', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD }, ['eth_getBlockByNumber']);
    await withChainFeeHints(p).request({ method: 'eth_sendTransaction', params: [tx] });
    expect(p.request).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [tx] });
  });

  it('passes other methods through and returns one stable wrapper that forwards listeners', async () => {
    const p = fakeProvider({ eth_chainId: ROBINHOOD });
    const w = withChainFeeHints(p);
    expect(withChainFeeHints(p)).toBe(w);
    expect(await w.request({ method: 'eth_chainId' })).toBe(ROBINHOOD);
    const handler = () => undefined;
    w.on('accountsChanged', handler);
    w.removeListener('accountsChanged', handler);
    expect(p.on).toHaveBeenCalledWith('accountsChanged', handler);
    expect(p.removeListener).toHaveBeenCalledWith('accountsChanged', handler);
    expect(w.isMetaMask).toBe(true);
  });
});
