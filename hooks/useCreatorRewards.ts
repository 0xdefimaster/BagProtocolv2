'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCurrentUserId } from './useCurrentUserId';
import {
  claimAllCreatorRewards,
  fetchClaimableRewardBalance,
  getConfiguredVaultAddress,
} from '@/lib/blockchain/creator-rewards-vault-client';
import { rewardTokenRawToQuoteDecimal, ROBINHOOD_REWARD_TOKEN } from '@/lib/config/robinhood-chain';

// -----------------------------------------------------------------------------
// Phase 22 (follow-up) — client-side counterpart to
// app/api/creator/rewards/route.ts, mirroring usePaperPortfolio.ts's
// fetch-on-mount + manual refresh() shape.
//
// `claimableRaw`/`claimableDisplay` are DELIBERATELY separate from
// `totalQuote`: `totalQuote` is the historical Supabase-ledger total (may
// include rewards never settled on-chain yet — see
// docs/CREATOR_REWARDS_SETTLEMENT.md's "historical rewards" gap), while
// `claimableRaw` is read live from `CreatorRewardsVault.balanceOf` and is
// the ONLY number that `claim()` actually pays out. Never conflate the two
// in the UI — see app/dashboard/profile/page.tsx for how they're kept
// visually distinct.
// -----------------------------------------------------------------------------

export type CreatorRewardType = 'FORK_ROYALTY' | 'PERFORMANCE_FEE';

export interface CreatorRewardActivity {
  id: string;
  type: CreatorRewardType;
  amountQuote: string;
  bagId: string;
  createdAt: string;
}

export function useCreatorRewards(walletAddress?: string) {
  const { isAuthenticated } = useCurrentUserId();
  const [rewards, setRewards] = useState<CreatorRewardActivity[]>([]);
  const [totalQuote, setTotalQuote] = useState('0');
  const [isLoading, setIsLoading] = useState(false);

  const [claimableRaw, setClaimableRaw] = useState<bigint | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [lastClaimTxHash, setLastClaimTxHash] = useState<string | null>(null);

  const vaultAddress = getConfiguredVaultAddress();

  const refresh = useCallback(() => {
    if (!isAuthenticated) {
      setRewards([]);
      setTotalQuote('0');
      return;
    }
    setIsLoading(true);
    fetch('/api/creator/rewards')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { rewards: CreatorRewardActivity[]; totalQuote: string } | null) => {
        if (data) {
          setRewards(data.rewards);
          setTotalQuote(data.totalQuote);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [isAuthenticated]);

  const refreshClaimable = useCallback(() => {
    if (!vaultAddress || !walletAddress) {
      setClaimableRaw(null);
      return;
    }
    fetchClaimableRewardBalance(vaultAddress, walletAddress as `0x${string}`)
      .then(setClaimableRaw)
      .catch(() => setClaimableRaw(null)); // no live RPC / vault not reachable — treat as "unknown", not "zero"
  }, [vaultAddress, walletAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshClaimable();
  }, [refreshClaimable]);

  const claim = useCallback(async () => {
    if (!vaultAddress || !walletAddress) return;
    setIsClaiming(true);
    setClaimError(null);
    try {
      const txHash = await claimAllCreatorRewards(vaultAddress, walletAddress as `0x${string}`);
      setLastClaimTxHash(txHash);
      // Optimistic zero would be exactly the "database row pretending to be
      // money" mistake the vault itself was built to avoid — re-read the
      // real on-chain balance instead of assuming the withdraw succeeded.
      refreshClaimable();
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed.');
    } finally {
      setIsClaiming(false);
    }
  }, [vaultAddress, walletAddress, refreshClaimable]);

  return {
    rewards,
    totalQuote,
    isLoading,
    refresh,
    // On-chain claimable balance — null means "unknown / vault not
    // configured or not reachable", NOT zero. UI should hide the claim
    // affordance entirely on null rather than show "$0.00 claimable".
    claimableRaw,
    claimableDisplay: claimableRaw !== null ? rewardTokenRawToQuoteDecimal(claimableRaw) : null,
    claimableTokenSymbol: ROBINHOOD_REWARD_TOKEN.symbol,
    isVaultConfigured: vaultAddress !== null,
    isClaiming,
    claimError,
    lastClaimTxHash,
    claim,
    refreshClaimable,
  };
}
