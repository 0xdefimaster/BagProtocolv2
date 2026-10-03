'use client';

import { BagNFT } from '@/types/domain';
import { getAccessoryById } from '@/data/mock-accessories';
import { ACCESSORY_SLOTS } from '@/types/domain';

interface NFTCardProps {
  nft: BagNFT;
}

export function NFTCard({ nft }: NFTCardProps) {
  const glyphs = ACCESSORY_SLOTS.map((slot) => getAccessoryById(nft.accessories[slot])?.image).filter(Boolean);

  return (
    <div className="nft-card">
      <div className="nft-avatar">{glyphs.slice(0, 3).join(' ') || '🎒'}</div>
      <span className={`reveal-rarity ${nft.rarity.toLowerCase()}`}>{nft.rarity}</span>
      <div className="name">BAG #{nft.id.replace('bagnft_', '').slice(0, 6).toUpperCase()}</div>
      {nft.genesisRank && <div className="genesis-badge" style={{ display: 'inline-flex' }}>Genesis #{nft.genesisRank}</div>}
      <div className="id mono" style={{ marginTop: 8 }}>{nft.blockchainStatus}</div>
    </div>
  );
}
