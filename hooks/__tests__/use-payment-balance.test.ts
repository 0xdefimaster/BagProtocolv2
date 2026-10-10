// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// viem's public client is mocked at createPublicClient: the hook's own logic
// (which call, request ordering, error handling) runs for real.
const getBalance = vi.fn();
const readContract = vi.fn();
const getGasPrice = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ getBalance, readContract, getGasPrice }) };
});

const {
  usePaymentBalance,
  usableBalanceRaw,
  estimateGasReserveRaw,
  PURCHASE_GAS_LIMIT,
  GAS_RESERVE_MULTIPLIER,
  FALLBACK_GAS_RESERVE_WEI,
} = await import('../use-payment-balance');
const { NATIVE_ASSET_ADDRESS } = await import('@/lib/domain/basket-protocol/asset-identity');
const { ROBINHOOD_REWARD_TOKEN } = await import('@/lib/config/robinhood-chain');

const WALLET = '0x' + '5'.repeat(40);
type Asset = { chain: string; address: string; decimals: number };
const USDG: Asset = { chain: 'robinhood', address: ROBINHOOD_REWARD_TOKEN.address, decimals: ROBINHOOD_REWARD_TOKEN.decimals };
const ETH: Asset = { chain: 'robinhood', address: NATIVE_ASSET_ADDRESS, decimals: 18 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  getBalance.mockReset();
  readContract.mockReset();
  getGasPrice.mockReset();
});

describe('usePaymentBalance', () => {
  it('ERC-20: balanceOf on the token; native: getBalance', async () => {
    readContract.mockResolvedValue(BigInt(250_000_000));
    getBalance.mockResolvedValue(BigInt('42100000000000000'));

    const erc20 = renderHook(() => usePaymentBalance(USDG, WALLET));
    await waitFor(() => expect(erc20.result.current.status).toBe('ready'));
    expect(erc20.result.current.balanceRaw).toBe(BigInt(250_000_000));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: USDG.address, functionName: 'balanceOf', args: [WALLET] }));
    expect(getBalance).not.toHaveBeenCalled();

    const native = renderHook(() => usePaymentBalance(ETH, WALLET));
    await waitFor(() => expect(native.result.current.status).toBe('ready'));
    expect(native.result.current.balanceRaw).toBe(BigInt('42100000000000000'));
    expect(getBalance).toHaveBeenCalledWith({ address: WALLET });
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('a slow answer for asset A never overwrites asset B, and B never shows A’s figure', async () => {
    const slowA = deferred<bigint>();
    readContract.mockReturnValueOnce(slowA.promise);
    getBalance.mockResolvedValue(BigInt(7));

    const { result, rerender } = renderHook(({ asset }) => usePaymentBalance(asset, WALLET), { initialProps: { asset: USDG } });
    expect(result.current).toMatchObject({ status: 'loading', balanceRaw: null });

    rerender({ asset: ETH });
    // Same render as the switch: loading, no figure.
    expect(result.current).toMatchObject({ status: 'loading', balanceRaw: null });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.balanceRaw).toBe(BigInt(7));

    await act(async () => slowA.resolve(BigInt(999)));
    expect(result.current.balanceRaw).toBe(BigInt(7));
  });

  it('switching back shows loading, not the previous asset’s figure', async () => {
    readContract.mockResolvedValue(BigInt(1));
    getBalance.mockResolvedValue(BigInt(2));
    const { result, rerender } = renderHook(({ asset }) => usePaymentBalance(asset, WALLET), { initialProps: { asset: USDG } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ asset: ETH });
    expect(result.current).toMatchObject({ status: 'loading', balanceRaw: null });
  });

  it('an RPC error is status error with a null balance, never 0n; refetch retries', async () => {
    readContract.mockRejectedValueOnce(new Error('rpc down'));
    const { result } = renderHook(() => usePaymentBalance(USDG, WALLET));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.balanceRaw).toBeNull();

    readContract.mockResolvedValueOnce(BigInt(5));
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.balanceRaw).toBe(BigInt(5));
  });

  it('no wallet address: idle, and no RPC call', async () => {
    const { result } = renderHook(() => usePaymentBalance(USDG, null));
    expect(result.current).toMatchObject({ status: 'idle', balanceRaw: null });
    const none = renderHook(() => usePaymentBalance(null, WALLET));
    expect(none.result.current.status).toBe('idle');
    await new Promise((r) => setTimeout(r, 10));
    expect(readContract).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });
});

describe('usable amount and gas reserve', () => {
  it('ERC-20: the whole balance; native: balance minus the reserve, never below 0', () => {
    expect(usableBalanceRaw(BigInt(100), false, BigInt(1000))).toBe(BigInt(100));
    expect(usableBalanceRaw(BigInt(1000), true, BigInt(300))).toBe(BigInt(700));
    expect(usableBalanceRaw(BigInt(100), true, BigInt(1000))).toBe(BigInt(0));
  });

  it('reserve = gasPrice × gas limit × multiplier; a failed gas-price read uses the fixed reserve', async () => {
    getGasPrice.mockResolvedValueOnce(BigInt(100_000_000)); // 0.1 gwei
    expect(await estimateGasReserveRaw({ getGasPrice })).toBe(BigInt(100_000_000) * PURCHASE_GAS_LIMIT * GAS_RESERVE_MULTIPLIER);
    getGasPrice.mockRejectedValueOnce(new Error('no gas price'));
    expect(await estimateGasReserveRaw({ getGasPrice })).toBe(FALLBACK_GAS_RESERVE_WEI);
  });
});
