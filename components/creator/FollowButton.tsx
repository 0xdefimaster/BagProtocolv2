'use client';

import { useCreatorFollows } from '@/lib/creator-follow-store';
import { useNotifications } from '@/lib/notifications-store';
import { useWallet } from '@/lib/wallet-context';
import { Check, Plus } from 'lucide-react';

interface FollowButtonProps {
  creatorId: string;
  creatorName: string;
}

/** True when `creatorAddress` is the connected wallet — nobody follows themselves. */
export function useIsSelf(creatorAddress: string | undefined): boolean {
  const { isConnected, walletAddress } = useWallet();
  return Boolean(isConnected && creatorAddress && walletAddress && creatorAddress.toLowerCase() === walletAddress.toLowerCase());
}

export function FollowButton({ creatorId, creatorName }: FollowButtonProps) {
  const { isFollowing, toggleFollowCreator } = useCreatorFollows();
  const { addNotification } = useNotifications();
  const isSelf = useIsSelf(creatorId);
  const following = isFollowing(creatorId);

  if (isSelf) {
    return <span className="follow-btn" aria-label="This is your Bag">Your Bag</span>;
  }

  const handleClick = () => {
    const nowFollowing = toggleFollowCreator(creatorId);
    if (nowFollowing) {
      addNotification(
        `You followed ${creatorName}`,
        `You'll get notified whenever ${creatorName} publishes a new Bag.`
      );
    }
  };

  return (
    <button className={`follow-btn ${following ? 'following' : ''}`} onClick={handleClick}>
      {following ? <Check size={13} /> : <Plus size={13} />}
      {following ? 'Following' : 'Follow'}
    </button>
  );
}
