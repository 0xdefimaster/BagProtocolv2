// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

// -----------------------------------------------------------------------------
// Tests for hooks/useCreatorRewards.ts's on-chain half: the Supabase-backed
// `rewards`/`totalQuote`/`refresh` behavior already existed and is
// unchanged; what's new (and had zero coverage before this file) is the
// `claimableDisplay`/`claim()` wiring to CreatorRewardsVault via
// lib/blockchain/creator-rewards-vault-client.ts. That client module talks
// to a real wallet/RPC, so it's mocked here — this proves the HOOK's own
// state machine (null-vs-zero handling, isClaiming, error surfacing,
// re-fetch-after-claim) is correct, not the vault client or a real chain.
// -----------------------------------------------------------------------------

const fetchClaimableRewardBalanceMock = vi.fn<(vault: string, wallet: string) => Promise<bigint>>();
const claimAllCreatorRewardsMock = vi.fn<(vault: string, wallet: string) => Promise<`0x${string}`>>();
const getConfiguredVaultAddressMock = vi.fn<() => `0x${string}` | null>();

vi.mock('@/lib/blockchain/creator-rewards-vault-client', () => ({
  fetchClaimableRewardBalance: (...args: [string, string]) => fetchClaimableRewardBalanceMock(...args),
  claimAllCreatorRewards: (...args: [string, string]) => claimAllCreatorRewardsMock(...args),
  getConfiguredVaultAddress: () => getConfiguredVaultAddressMock(),
}));

vi.mock('@/hooks/useCurrentUserId', () => ({
  useCurrentUserId: () => ({ isAuthenticated: true, userId: 'user-1' }),
}));

const { useCreatorRewards } = await import('../useCreatorRewards');

const VAULT_ADDRESS = '0x1111111111111111111111111111111111111a';
const WALLET_ADDRESS = '0x2222222222222222222222222222222222222b';

describe('useCreatorRewards — on-chain claim wiring', () => {
  beforeEach(() => {
    fetchClaimableRewardBalanceMock.mockReset();
    claimAllCreatorRewardsMock.mockReset();
    getConfiguredVaultAddressMock.mockReset();
    getConfiguredVaultAddressMock.mockReturnValue(VAULT_ADDRESS);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rewards: [], totalQuote: '0' }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    // Unmount the previous test's hook so it cannot re-render against the
    // next test's mocks.
    cleanup();
    vi.restoreAllMocks();
  });

  it('reports isVaultConfigured=false and claimableDisplay=null when no vault address is configured', async () => {
    getConfiguredVaultAddressMock.mockReturnValue(null);
    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));

    expect(result.current.isVaultConfigured).toBe(false);
    expect(result.current.claimableDisplay).toBeNull();
    expect(fetchClaimableRewardBalanceMock).not.toHaveBeenCalled();
  });

  it('reports claimableDisplay=null (not "0") when no wallet is connected yet', async () => {
    const { result } = renderHook(() => useCreatorRewards(undefined));

    expect(result.current.isVaultConfigured).toBe(true);
    expect(result.current.claimableDisplay).toBeNull();
    expect(fetchClaimableRewardBalanceMock).not.toHaveBeenCalled();
  });

  it('fetches and displays the real on-chain claimable balance, correctly converted from raw units', async () => {
    fetchClaimableRewardBalanceMock.mockResolvedValue(BigInt(17_130_000)); // 17.13 USDG at 6 decimals
    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));

    await waitFor(() => expect(result.current.claimableDisplay).toBe('17.13'));
    expect(fetchClaimableRewardBalanceMock).toHaveBeenCalledWith(VAULT_ADDRESS, WALLET_ADDRESS);
    expect(result.current.claimableTokenSymbol).toBe('USDG');
  });

  it('a genuine zero on-chain balance displays as "0", distinguishable from the null/unknown case above', async () => {
    fetchClaimableRewardBalanceMock.mockResolvedValue(BigInt(0));
    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));

    await waitFor(() => expect(result.current.claimableDisplay).not.toBeNull());
    expect(result.current.claimableDisplay).toBe('0');
  });

  it('treats an RPC/vault read failure as unknown (null), never as a false zero', async () => {
    fetchClaimableRewardBalanceMock.mockRejectedValue(new Error('RPC timeout'));
    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));

    await waitFor(() => expect(fetchClaimableRewardBalanceMock).toHaveBeenCalled());
    expect(result.current.claimableDisplay).toBeNull();
  });

  it('claim() calls the vault client, records the tx hash, and re-fetches the real balance afterward (no optimistic-zero assumption)', async () => {
    fetchClaimableRewardBalanceMock
      .mockResolvedValueOnce(BigInt(17_130_000)) // initial mount fetch
      .mockResolvedValueOnce(BigInt(0)); // re-fetch after claim
    claimAllCreatorRewardsMock.mockResolvedValue('0xabc123');

    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));
    await waitFor(() => expect(result.current.claimableDisplay).toBe('17.13'));

    await act(async () => {
      await result.current.claim();
    });

    expect(claimAllCreatorRewardsMock).toHaveBeenCalledWith(VAULT_ADDRESS, WALLET_ADDRESS);
    expect(result.current.lastClaimTxHash).toBe('0xabc123');
    expect(result.current.isClaiming).toBe(false);
    expect(fetchClaimableRewardBalanceMock).toHaveBeenCalledTimes(2);
    expect(result.current.claimableDisplay).toBe('0');
  });

  it('surfaces a claim failure via claimError and leaves isClaiming false afterward, without touching claimableDisplay', async () => {
    fetchClaimableRewardBalanceMock.mockResolvedValue(BigInt(5_000_000));
    claimAllCreatorRewardsMock.mockRejectedValue(new Error('user rejected transaction'));

    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));
    await waitFor(() => expect(result.current.claimableDisplay).toBe('5'));

    await act(async () => {
      await result.current.claim();
    });

    expect(result.current.claimError).toBe('user rejected transaction');
    expect(result.current.isClaiming).toBe(false);
    expect(result.current.lastClaimTxHash).toBeNull();
  });

  it('claim() is a no-op if the vault is not configured or no wallet is connected', async () => {
    getConfiguredVaultAddressMock.mockReturnValue(null);
    const { result } = renderHook(() => useCreatorRewards(WALLET_ADDRESS));

    await act(async () => {
      await result.current.claim();
    });

    expect(claimAllCreatorRewardsMock).not.toHaveBeenCalled();
    expect(result.current.isClaiming).toBe(false);
  });
});
